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
  "printerIp": "192.168.1.130",
  "printerPort": 9100,
  "listenPort": 7000,
  "connectTimeoutMs": 4000
}
```

`printerIp` must match the ZT230. Give the printer a **DHCP reservation or a
static IP** — if it moves, both this service and the Windows driver port break,
and the failure looks like "printing just stopped".

Environment variables override the file, which is handy for testing a second
instance: `PRINTER_IP`, `PRINTER_PORT`, `LISTEN_PORT`.

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

**`"printer did not respond within 4000ms"`** — the ZT230 is off, asleep, or has
changed IP. Check with `Test-NetConnection 192.168.1.130 -Port 9100`.

**`/health` says `reachable: false`** — same cause. The page will refuse to print
rather than fall back to the browser, deliberately: spooling to an unreachable
printer is what leaves a job stuck in the Windows queue.

**Page loads but printing falls back to Browser Print** — the page could not
reach the service. If the page came from `https://` (GitHub Pages), it cannot
call `http://` at all. Open it from this service instead.

**Port 7000 already in use** — change `listenPort`, and point clients at it with
`?service=http://host:7001` (the page remembers it afterwards).
