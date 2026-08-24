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
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const DEFAULTS = {
  printerIp: '192.168.1.130',
  printerPort: 9100,
  listenPort: 7000,
  connectTimeoutMs: 4000
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
        printer: { ip: cfg.printerIp, port: cfg.printerPort, reachable: reachable },
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

      if (!zpl || zpl.indexOf('^XA') === -1) {
        sendJson(res, 400, { ok: false, error: 'body contained no ZPL format (expected ^XA ... ^XZ)' });
        return;
      }

      const labels = countLabels(zpl);
      const bytes = Buffer.byteLength(zpl, 'utf8');

      sendToPrinter(zpl).then(function () {
        log('printed ' + labels + ' label(s), ' + bytes + ' bytes -> ' + cfg.printerIp + ':' + cfg.printerPort);
        sendJson(res, 200, { ok: true, labels: labels, bytes: bytes });
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
  probePrinter(1500).then(function (reachable) {
    log('printer reachable: ' + reachable);
  });
});

server.on('error', function (err) {
  log('server error: ' + err.message);
  process.exit(1);
});
