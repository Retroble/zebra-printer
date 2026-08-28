# Label print service

Serves the label page and relays ZPL straight to the Zebra's raw socket.

Run this on **one** machine — the always-on back-office PC. Every other machine
just opens the page in a browser and needs nothing installed: no Zebra Browser
Print, no printer driver, no Node.

## Why it exists

- The ZT230 accepts raw ZPL on TCP 9100, but **a browser cannot open a raw
  socket**. Something native has to make that connection. Doing it here means it
  is set up once rather than on every machine that prints labels.
- It **bypasses the Windows spooler completely**. No driver rasterisation, no
  print queue, and no jobs wedging in `Error, Deleting` when the printer is
  unreachable — which is what used to block printing entirely.
- Serving the page from here puts the UI and the printer on the **same origin
  over plain HTTP**, so there is no mixed-content block (an `https://` page
  cannot call `http://localhost`), and there is one copy of the UI to update.

## Requirements

Node 18 or newer. Nothing else — no `npm install`, zero dependencies.

## Configure

`config.json`:

```json
{
  "printerIp": "192.168.1.155",
  "printerPort": 9100,
  "listenPort": 7000,
  "connectTimeoutMs": 4000,
  "autoDiscover": true,
  "printerSerial": "52J134800953"
}
```

`printerIp` is a starting point, not a hard requirement — see below.

Environment variables override the file, which is handy for testing a second
instance: `PRINTER_IP`, `PRINTER_PORT`, `LISTEN_PORT`. An env-driven instance
never rewrites `config.json`.

## Finding the printer

DHCP moves the Zebra sooner or later, and everything holding the old address
breaks at once. So on startup the service:

1. Checks whether `printerIp` still answers on the print port.
2. Reads that device's built-in web page to confirm it is **actually the
   Zebra** — not just something at that address.
3. If it is not, sweeps the local `/24` for the print port and identifies each
   host that answers.
4. Writes the address it found back to `config.json`, so the next start is
   instant.

It also re-runs this once if a print fails mid-session, then retries the job.
A run takes roughly two seconds.

**Identification is the important part.** This network has a Lexmark, an Epson
and a Xerox all listening on 9100. Sending ZPL to any of them would produce
pages of junk, so a candidate is accepted only after its web page identifies it
as a Zebra. **Nothing is ever written to port 9100 of an unidentified host.**

`printerSerial` pins it further: with a serial set, only that exact printer is
accepted. Worth keeping if you ever add a second Zebra.

Set `autoDiscover: false` to switch all of this off and use `printerIp` alone.
Add `"scanSubnet": "192.168.1"` if the printer is on a different subnet from
the machine running the service (the sweep cannot cross subnets on its own).

A **DHCP reservation is still worth setting** — discovery is a safety net, not
a reason to skip the five minutes in your router.

## Run

```
node service/server.js
```

Then open <http://localhost:7000/>. From another machine on the LAN, use that
machine's name or IP: `http://backoffice-pc:7000/`.

## Autostart

Task Scheduler is the simplest option:

1. Task Scheduler → Create Task
2. Trigger: **At log on**
3. Action: Start a program
   - Program: `node`
   - Arguments: `"C:\Users\Admin\Desktop\zebra printer\service\server.js"`
   - Start in: `C:\Users\Admin\Desktop\zebra printer\service`
4. Settings: tick **Restart the task if it fails**, and untick *Stop the task if
   it runs longer than…*

Use [NSSM](https://nssm.cc/) instead if it needs to run without anyone logged in.

## Endpoints

| Method | Path      | Purpose |
|--------|-----------|---------|
| `GET`  | `/`       | The label page (`index.html`) |
| `GET`  | `/health` | `{ ok, printer: { ip, port, reachable }, uptimeSeconds }` |
| `POST` | `/print`  | Body is raw ZPL, or `{"zpl": "..."}`. Returns `{ ok, labels, bytes }` |

`POST /print` accepts `text/plain` so browsers can call it without a CORS
preflight. CORS is open (`*`) so a page served from anywhere can reach it.

It takes three kinds of payload, since refusing the last two would leave no way
to configure the printer remotely:

| Kind | Looks like | Example |
|------|-----------|---------|
| format | `^XA ... ^XZ` | a label |
| control | starts with `~` | `~JC` calibrate, `~HS` status |
| sgd | starts with `! U1` | `! U1 getvar "media.sense_mode"` |

Anything else is refused. Arbitrary bytes on port 9100 come out as pages of
garbage, so this is worth being strict about.

Calibrate the media (feeds a few labels while it measures):

```
curl -X POST --data-raw "~JC" http://localhost:7000/print
```

Smoke test — prints one label:

```
curl -X POST --data-raw "^XA^FO50,50^A0N,40,40^FDTEST^FS^XZ" http://localhost:7000/print
```

Confirm it never touched the spooler:

```
Get-Printer -Name "NETWORK ZEBRA PRINTER" | Select-Object JobCount
```

`JobCount` should stay `0`. That is the whole point.

## Troubleshooting

**`"printer did not respond within 4000ms"`** — the ZT230 is off or asleep. If it
had merely changed IP, discovery would have found it; the log shows every host
it swept. Check the printer is powered on and on the same subnet.

**`"printer NOT found"` at startup** — nothing on the local `/24` identified
itself as a Zebra. If the printer sits on another subnet, set `scanSubnet` or
`printerIp` explicitly.

**`"WARNING: ... is not our Zebra - the address has been reassigned"`** — working
as intended. Another device inherited the printer's old IP; the service refused
to print to it and went looking for the real one.

**`/health` says `reachable: false`** — same cause. The page will refuse to print
rather than fall back to the browser, deliberately: spooling to an unreachable
printer is what leaves a job stuck in the Windows queue.

**Page loads but printing falls back to Browser Print** — the page could not
reach the service. If the page came from `https://` (GitHub Pages), it cannot
call `http://` at all. Open it from this service instead.

**Port 7000 already in use** — change `listenPort`, and point clients at it with
`?service=http://host:7001` (the page remembers it afterwards).
