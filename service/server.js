#!/usr/bin/env node
'use strict';

/*
 * Retroble label print service
 * ────────────────────────────
 * Serves the label page and relays ZPL straight to the printer's raw socket.
 *
 * Why this exists:
 *  - The ZT230 listens for raw ZPL on TCP 9100, but a browser cannot open a
 *    raw socket, so something native has to make that connection. Doing it
 *    here means it is installed once, not on every machine that prints.
 *  - Going socket-direct skips the Windows spooler entirely. No driver
 *    rasterisation, no queue, and no jobs that wedge in "Error, Deleting"
 *    when the printer is unreachable — which is what used to block printing.
 *  - Serving index.html from here makes the page and the printer the same
 *    origin over plain HTTP, so there is no mixed-content block to work
 *    around and one copy of the UI to keep updated.
 *
 * Zero npm dependencies on purpose: http + net + fs from stdlib.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const DEFAULTS = {
  printerIp: '192.168.1.130',
  printerPort: 9100,
  listenPort: 7000,
  connectTimeoutMs: 4000,
  autoDiscover: true,
  // Optional. If set, only a printer whose web page shows this serial is
  // accepted — the safe way to pick the right one when there are several.
  printerSerial: ''
};

function loadConfig() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    log('config.json unreadable (' + err.message + ') - using defaults');
    return Object.assign({}, DEFAULTS);
  }
}

// Env overrides, so a second instance can run against a different printer
// (or a test sink) without editing config.json.
function applyEnvOverrides(cfg) {
  if (process.env.PRINTER_IP) cfg.printerIp = process.env.PRINTER_IP;
  if (process.env.PRINTER_PORT) cfg.printerPort = Number(process.env.PRINTER_PORT);
  if (process.env.LISTEN_PORT) cfg.listenPort = Number(process.env.LISTEN_PORT);
  return cfg;
}

const cfg = applyEnvOverrides(loadConfig());

function log() {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + stamp + '] ' + Array.prototype.join.call(arguments, ' '));
}

/* ── Printer socket ──────────────────────────────────────── */

// Resolves once the printer has accepted the bytes and the socket has closed.
function sendToPrinter(zpl) {
  return new Promise(function (resolve, reject) {
    const socket = net.connect({ host: cfg.printerIp, port: cfg.printerPort });
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve();
    }

    socket.setTimeout(cfg.connectTimeoutMs);
    socket.on('timeout', function () {
      finish(new Error('printer did not respond within ' + cfg.connectTimeoutMs + 'ms'));
    });
    socket.on('error', finish);
    socket.on('connect', function () {
      // ^CI28 means the format is UTF-8, so write it as UTF-8.
      socket.write(zpl, 'utf8', function () { socket.end(); });
    });
    socket.on('close', function () { finish(null); });
  });
}

// Connect-and-drop, purely to answer "is the printer there?".
function probePrinter(timeoutMs) {
  return new Promise(function (resolve) {
    const socket = net.connect({ host: cfg.printerIp, port: cfg.printerPort });
    let settled = false;

    function finish(reachable) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    }

    socket.setTimeout(timeoutMs || 1500);
    socket.on('timeout', function () { finish(false); });
    socket.on('error', function () { finish(false); });
    socket.on('connect', function () { finish(true); });
  });
}

/* ── Finding the printer when DHCP moves it ──────────────── */

/*
 * A Zebra on DHCP will eventually change address, and every layer that had
 * the old one hard-coded breaks at once. Rather than hard-code harder, find
 * it: scan the local /24 for the ZPL port, then IDENTIFY each candidate.
 *
 * Identification is not optional. This LAN alone has a Lexmark, an Epson and
 * a Xerox listening on 9100. Sending ZPL to any of them would spit out pages
 * of junk, so a candidate is only accepted after its built-in web page says
 * it is a Zebra. Nothing is ever written to port 9100 of an unknown host.
 */

const ZEBRA_HINT = /zebra|ztc\b|z[td][0-9]{3}/i;
const DISCOVERY_COOLDOWN_MS = 15000;

let printerModel = null;
let lastDiscoveryAt = 0;
let discoveryInFlight = null;

function localSubnetBase() {
  if (cfg.scanSubnet) return cfg.scanSubnet;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.indexOf('169.254.') === 0) continue;  // APIPA, no DHCP here
      if (iface.netmask !== '255.255.255.0') continue;        // keep the sweep to a /24
      return iface.address.split('.').slice(0, 3).join('.');
    }
  }
  return null;
}

function tcpOpen(ip, port, timeoutMs) {
  return new Promise(function (resolve) {
    const socket = net.connect({ host: ip, port: port });
    let settled = false;
    function finish(open) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    }
    socket.setTimeout(timeoutMs);
    socket.on('timeout', function () { finish(false); });
    socket.on('error', function () { finish(false); });
    socket.on('connect', function () { finish(true); });
  });
}

// Reads the device's web page (port 80). Read-only, and safe to point at
// anything, unlike writing to the raw print port.
function readIdentityPage(ip, timeoutMs) {
  return new Promise(function (resolve) {
    const req = http.get({ host: ip, port: 80, path: '/', timeout: timeoutMs }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        body += chunk;
        if (body.length > 16384) req.destroy();
      });
      res.on('end', function () { resolve(body); });
    });
    req.on('timeout', function () { req.destroy(); resolve(''); });
    req.on('error', function () { resolve(''); });
  });
}

function isOurPrinter(pageText) {
  if (!pageText || !ZEBRA_HINT.test(pageText)) return false;
  if (cfg.printerSerial) return pageText.indexOf(cfg.printerSerial) !== -1;
  return true;
}

function modelFrom(pageText) {
  const match = pageText.match(/(Z[TD][0-9]{3}[-\w]*)/i);
  return match ? match[1] : 'Zebra printer';
}

async function scanForPrinter() {
  const base = localSubnetBase();
  if (!base) {
    log('discovery: no usable IPv4 /24 interface, cannot scan');
    return null;
  }

  log('discovery: sweeping ' + base + '.0/24 for port ' + cfg.printerPort);
  const targets = [];
  for (let i = 1; i <= 254; i++) targets.push(base + '.' + i);

  const open = [];
  await Promise.all(targets.map(function (ip) {
    return tcpOpen(ip, cfg.printerPort, 500).then(function (isOpen) {
      if (isOpen) open.push(ip);
    });
  }));
  log('discovery: ' + open.length + ' host(s) listening: ' + (open.join(', ') || 'none'));

  for (const ip of open) {
    const page = await readIdentityPage(ip, 2500);
    if (isOurPrinter(page)) {
      const model = modelFrom(page);
      log('discovery: ' + ip + ' identified as ' + model);
      return { ip: ip, model: model };
    }
  }

  log('discovery: no Zebra found' + (cfg.printerSerial ? ' with serial ' + cfg.printerSerial : ''));
  return null;
}

function persistPrinterIp(ip) {
  if (process.env.PRINTER_IP) return;   // env-driven instance, leave the file alone
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    onDisk.printerIp = ip;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
    log('config.json updated: printerIp = ' + ip);
  } catch (err) {
    log('could not write config.json: ' + err.message);
  }
}

// Confirms the configured address still belongs to our printer, and goes
// looking if it does not. Concurrent callers share one run.
function locatePrinter(force) {
  if (!cfg.autoDiscover) return Promise.resolve(false);
  if (discoveryInFlight) return discoveryInFlight;
  if (!force && Date.now() - lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) {
    return Promise.resolve(false);
  }

  discoveryInFlight = (async function () {
    if (await tcpOpen(cfg.printerIp, cfg.printerPort, 1200)) {
      const page = await readIdentityPage(cfg.printerIp, 2500);
      if (isOurPrinter(page)) {
        printerModel = modelFrom(page);
        return true;
      }
      if (page) {
        // Something answers on the print port but is NOT the Zebra: DHCP has
        // handed this address to another device. Printing here would dump ZPL
        // on a stranger's printer, so go and find ours instead.
        log('WARNING: ' + cfg.printerIp + ' answers on ' + cfg.printerPort +
            ' but is not our Zebra - the address has been reassigned');
      } else {
        // No web page to check. Cannot confirm, cannot disprove - trust the
        // configured address rather than sweeping on every start.
        log('note: could not read an identity page from ' + cfg.printerIp + ', assuming it is correct');
        return true;
      }
    }

    const found = await scanForPrinter();
    if (!found) return false;
    if (found.ip !== cfg.printerIp) {
      log('printer moved: ' + cfg.printerIp + ' -> ' + found.ip);
      cfg.printerIp = found.ip;
      persistPrinterIp(found.ip);
    }
    printerModel = found.model;
    return true;
  })();

  return discoveryInFlight.then(function (ok) {
    lastDiscoveryAt = Date.now();
    discoveryInFlight = null;
    return ok;
  }, function (err) {
    log('discovery error: ' + err.message);
    lastDiscoveryAt = Date.now();
    discoveryInFlight = null;
    return false;
  });
}

// One retry: if the send fails, the printer may have just moved.
async function printWithRecovery(zpl) {
  try {
    await sendToPrinter(zpl);
    return false;
  } catch (err) {
    if (!cfg.autoDiscover) throw err;
    log('send failed (' + err.message + ') - relocating printer');
    const located = await locatePrinter(true);
    if (!located) throw err;
    await sendToPrinter(zpl);
    return true;
  }
}

/* ── HTTP plumbing ───────────────────────────────────────── */

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/jsbarcode.min.js': { file: 'jsbarcode.min.js', type: 'text/javascript; charset=utf-8' }
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    req.on('data', function (chunk) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body over ' + MAX_BODY_BYTES + ' bytes'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// Accepts either {"zpl": "..."} or a raw ZPL body, so curl stays easy.
function extractZpl(body, contentType) {
  if (contentType && contentType.indexOf('application/json') !== -1) {
    const parsed = JSON.parse(body);
    return typeof parsed === 'string' ? parsed : parsed.zpl;
  }
  const trimmed = body.trim();
  if (trimmed.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.zpl === 'string') return parsed.zpl;
    } catch (err) {
      /* not JSON after all - fall through and treat it as raw ZPL */
    }
  }
  return body;
}

function countLabels(zpl) {
  const matches = zpl.match(/\^XA/g);
  return matches ? matches.length : 0;
}

/*
 * The printer takes three kinds of input on this port, and rejecting the last
 * two would mean no way to calibrate or configure it remotely:
 *   format   ^XA ... ^XZ   a label
 *   control  ~JC, ~HS      immediate commands, no format block
 *   SGD      ! U1 setvar   settings
 * Anything else is almost certainly a mistake and is worth refusing, since
 * arbitrary bytes on port 9100 come out as pages of garbage.
 */
function classifyPayload(text) {
  const trimmed = text.trim();
  if (trimmed.indexOf('^XA') !== -1) return 'format';
  if (trimmed.charAt(0) === '~') return 'control';
  if (/^!\s*U1\s/.test(trimmed)) return 'sgd';
  return null;
}

function serveStatic(res, entry) {
  fs.readFile(path.join(ROOT, entry.file), function (err, data) {
    if (err) {
      cors(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + entry.file);
      return;
    }
    cors(res);
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    probePrinter(1500).then(function (reachable) {
      sendJson(res, 200, {
        ok: true,
        printer: {
          ip: cfg.printerIp,
          port: cfg.printerPort,
          reachable: reachable,
          model: printerModel
        },
        autoDiscover: cfg.autoDiscover,
        uptimeSeconds: Math.round(process.uptime())
      });
    });
    return;
  }

  if (req.method === 'POST' && url === '/print') {
    readBody(req).then(function (body) {
      let zpl;
      try {
        zpl = extractZpl(body, req.headers['content-type']);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'could not parse body: ' + err.message });
        return;
      }

      const kind = zpl && classifyPayload(zpl);
      if (!kind) {
        sendJson(res, 400, {
          ok: false,
          error: 'unrecognised payload — expected a ^XA...^XZ format, a ~ control command (e.g. ~JC), or an "! U1" SGD command'
        });
        return;
      }

      const labels = countLabels(zpl);
      const bytes = Buffer.byteLength(zpl, 'utf8');

      printWithRecovery(zpl).then(function (recovered) {
        log('sent ' + kind + ' (' + labels + ' label(s), ' + bytes + ' bytes) -> ' + cfg.printerIp + ':' + cfg.printerPort +
            (recovered ? ' (after relocating the printer)' : ''));
        sendJson(res, 200, { ok: true, kind: kind, labels: labels, bytes: bytes, printer: cfg.printerIp, relocated: recovered });
      }).catch(function (err) {
        log('FAILED ' + labels + ' label(s): ' + err.message);
        sendJson(res, 502, {
          ok: false,
          error: err.message,
          printer: cfg.printerIp + ':' + cfg.printerPort
        });
      });
    }).catch(function (err) {
      sendJson(res, 413, { ok: false, error: err.message });
    });
    return;
  }

  if (req.method === 'GET' && STATIC[url]) {
    serveStatic(res, STATIC[url]);
    return;
  }

  cors(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(cfg.listenPort, function () {
  log('label print service listening on http://0.0.0.0:' + cfg.listenPort);
  log('printer target ' + cfg.printerIp + ':' + cfg.printerPort);
  log('open the label page at http://localhost:' + cfg.listenPort + '/');

  // Confirm the configured address is still the printer before anyone tries
  // to print; if DHCP has moved it, find it now rather than failing later.
  locatePrinter(true).then(function (located) {
    if (located) {
      log('printer ready: ' + (printerModel || 'Zebra') + ' at ' + cfg.printerIp + ':' + cfg.printerPort);
    } else {
      log('printer NOT found. Check it is powered on and on this network.');
      log('If it is on a different subnet, set "printerIp" in config.json (or "scanSubnet").');
    }
  });
});

server.on('error', function (err) {
  log('server error: ' + err.message);
  process.exit(1);
});
