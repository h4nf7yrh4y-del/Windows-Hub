'use strict';

const processes = require('./processes');
const logger = require('./logger');

const log = logger.scoped('network');
const IS_WIN = process.platform === 'win32';

let si = null;
try {
  si = require('systeminformation');
} catch (err) {
  log.warn(`systeminformation nicht verfügbar: ${err.message}`);
}

/**
 * Adapters and open connections.
 *
 * The system view already shows throughput for whichever adapter is busiest,
 * which answers "is something downloading". This answers the other question:
 * what is downloading. Connections are read through Get-NetTCPConnection rather
 * than netstat, because it hands over the owning process id as a number instead
 * of a column that has to be parsed out of localised text.
 */

const CONNECTION_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$names = @{}
foreach ($p in Get-Process) { $names[[string]$p.Id] = $p.ProcessName }

$rows = @(Get-NetTCPConnection | ForEach-Object {
  [PSCustomObject]@{
    local   = [string]$_.LocalAddress
    lport   = $_.LocalPort
    remote  = [string]$_.RemoteAddress
    rport   = $_.RemotePort
    state   = [string]$_.State
    owner   = $_.OwningProcess
    process = $names[[string]$_.OwningProcess]
  }
})

ConvertTo-Json -Compress -Depth 3 -InputObject $rows
`;

/** Addresses that mean "this machine" and are never worth calling a peer. */
const LOCAL_ADDRESSES = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', '*']);

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* ------------------------------------------------------------- interfaces */

async function interfaces() {
  if (!si) return { adapters: [], supported: false };

  const [list, stats] = await Promise.all([
    si.networkInterfaces().catch(() => []),
    // '*' asks for every adapter; the rates are computed against the previous
    // call, so the first answer after a start legitimately has none.
    si.networkStats('*').catch(() => [])
  ]);

  const byIface = new Map(asArray(stats).map((s) => [s.iface, s]));

  const adapters = asArray(list)
    .filter((n) => n && !n.internal)
    .map((n) => {
      const s = byIface.get(n.iface) || {};
      return {
        iface: n.iface,
        name: n.ifaceName || n.iface,
        type: n.type || 'unbekannt',
        state: n.operstate || 'unknown',
        isDefault: !!n.default,
        virtual: !!n.virtual,
        ip4: n.ip4 || '',
        ip6: n.ip6 || '',
        mac: n.mac || '',
        speedMbit: n.speed || null,
        dhcp: !!n.dhcp,
        rxSec: s.rx_sec != null && s.rx_sec >= 0 ? s.rx_sec : null,
        txSec: s.tx_sec != null && s.tx_sec >= 0 ? s.tx_sec : null,
        rxTotal: s.rx_bytes || 0,
        txTotal: s.tx_bytes || 0,
        dropped: (s.rx_dropped || 0) + (s.tx_dropped || 0),
        errors: (s.rx_errors || 0) + (s.tx_errors || 0)
      };
    });

  // Connected adapters first, then by throughput: an idle virtual adapter is
  // never the one someone opened this view for.
  adapters.sort((a, b) => {
    const up = (x) => (x.state === 'up' ? 0 : 1);
    if (up(a) !== up(b)) return up(a) - up(b);
    return ((b.rxSec || 0) + (b.txSec || 0)) - ((a.rxSec || 0) + (a.txSec || 0));
  });

  return { adapters, supported: true };
}

/* ------------------------------------------------------------ connections */

function normalise(row) {
  const remote = String(row.remote || '');
  return {
    local: String(row.local || ''),
    localPort: Number(row.lport) || 0,
    remote,
    remotePort: Number(row.rport) || 0,
    state: String(row.state || '').replace(/^Listen$/i, 'Listen'),
    pid: Number(row.owner) || 0,
    process: row.process || (Number(row.owner) ? `PID ${row.owner}` : 'unbekannt'),
    listening: LOCAL_ADDRESSES.has(remote) || !Number(row.rport)
  };
}

async function connections() {
  if (IS_WIN) {
    const out = await processes.runPowerShell(CONNECTION_SCRIPT, 30000).catch((err) => {
      log.warn(`Verbindungen nicht lesbar: ${err.message}`);
      return '';
    });
    const trimmed = (out || '').trim();
    if (!trimmed) return { rows: [], supported: true };
    try {
      return { rows: asArray(JSON.parse(trimmed)).map(normalise), supported: true };
    } catch (err) {
      log.warn(`Verbindungsliste unlesbar: ${err.message}`);
      return { rows: [], supported: true };
    }
  }

  // Development fallback. It needs ss or netstat on the machine and quietly
  // returns nothing when neither is there, which is fine: this path exists so
  // the view can be worked on outside Windows, not to be complete.
  if (!si) return { rows: [], supported: false };
  const list = await si.networkConnections().catch(() => []);
  return {
    rows: asArray(list).map((c) => normalise({
      local: c.localAddress,
      lport: c.localPort,
      remote: c.peerAddress,
      rport: c.peerPort,
      state: c.state,
      owner: c.pid,
      process: c.process
    })),
    supported: true
  };
}

/**
 * Both halves at once, plus a per-process roll-up.
 *
 * The roll-up is the part that answers the actual question. Two hundred rows of
 * sockets say nothing; "this program holds forty connections to eleven hosts"
 * does.
 */
async function overview() {
  const [ifaceResult, connResult] = await Promise.all([interfaces(), connections()]);

  const byProcess = new Map();
  for (const row of connResult.rows) {
    const key = row.process;
    const entry = byProcess.get(key) || { process: key, pid: row.pid, total: 0, established: 0, listening: 0, peers: new Set() };
    entry.total += 1;
    if (row.listening) entry.listening += 1;
    else {
      entry.established += 1;
      if (row.remote) entry.peers.add(row.remote);
    }
    byProcess.set(key, entry);
  }

  const programs = [...byProcess.values()]
    .map((e) => ({ ...e, peers: e.peers.size }))
    .sort((a, b) => b.established - a.established || b.total - a.total);

  return {
    ts: Date.now(),
    adapters: ifaceResult.adapters,
    connections: connResult.rows,
    programs,
    supported: ifaceResult.supported || connResult.supported
  };
}

module.exports = { interfaces, connections, overview, CONNECTION_SCRIPT, normalise };
