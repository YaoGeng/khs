// Shared helpers for S6 spike (Windows 11, node >= 20).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';

const pExecFile = promisify(execFile);

export const POWERSHELL = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** Median of a numeric array. */
export function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** All running processes: {pid, ppid, name}. Single CIM query. */
export async function listProcesses() {
  const { stdout } = await pExecFile(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }));
}

/**
 * True if targetPid is inside the process tree rooted at rootPid.
 * Uses ParentProcessId chain (Get-CimInstance Win32_Process) per plan requirement.
 */
export async function isInProcessTree(targetPid, rootPid, procs) {
  const list = procs ?? await listProcesses();
  const byPid = new Map(list.map(p => [p.pid, p]));
  let cur = targetPid;
  for (let hop = 0; hop < 32; hop++) {
    if (cur === rootPid) return true;
    const node = byPid.get(cur);
    if (!node || node.ppid === cur) return false; // unknown root / orphan cycle guard
    cur = node.ppid;
  }
  return false;
}

/**
 * Full `netstat -ano -p tcp` rows: [{proto?omitted, localAddr, port, remote, state, pid}].
 */
export async function netstatAll() {
  const { stdout } = await pExecFile(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-Command',
    'netstat -ano -p tcp'
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+(\S+)\s+(\S+)\s+(\d+)$/i);
    if (m) rows.push({ localAddr: m[1], port: Number(m[2]), remote: m[3], state: m[4], pid: Number(m[5]) });
  }
  return rows;
}

/** First non-internal IPv4 address of this host (for the non-loopback probe). */
export function firstLanIPv4() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const it of ifaces ?? []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return null;
}

/** Tree-kill a process on Windows. */
export async function taskKillTree(pid) {
  try {
    await pExecFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch { /* already gone */ }
}
