// 冷启动实测脚本（NFR-1 ≤3s；判定协议与完整结果见 docs/perf/cold-start-measured.md）。
//
// 方法：直接 spawn electron 跑 out/main.js（未打包壳，与本仓库 dev 态一致）；
// main 进程在 did-finish-load 时打印 `[cold-start] {"readyMs":..,"domReadyMs":..,"totalMs":..}`
// （process.hrtime.bigint 结算，main.ts），本脚本捕获 stdout 收集样本。
// 默认 7 次运行（≥5），取 p50 对照预算（COLD_START_BUDGET_MS，默认 3000）判定 PASS/FAIL。
/* global process, console, setTimeout, clearTimeout */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = Math.max(5, Number(process.env.COLD_START_RUNS ?? 7));
const BUDGET_MS = Number(process.env.COLD_START_BUDGET_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.COLD_START_TIMEOUT_MS ?? 20000);

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(path.join(pkgRoot, 'noop.js'));
const electronPath = requireFromDesktop('electron');

function machineSpec() {
  const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown';
  const cores = os.cpus().length;
  const ramGB = (os.totalmem() / 2 ** 30).toFixed(1);
  const osLine = `${os.type()} ${os.release()} (${os.platform()})`;
  let disk;
  try {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-PhysicalDisk | Select-Object -First 1).MediaType'],
      { encoding: 'utf8', timeout: 20000 },
    );
    disk = (r.stdout ?? '').trim() || 'unknown';
  } catch {
    disk = 'unknown';
  }
  return { cpu, cores, ramGB, osLine, disk };
}

function runOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, ['out/main.js', '--cold-start-bench'], {
      cwd: pkgRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`run timeout after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith('[cold-start]'))
        .pop();
      if (!line) {
        reject(new Error(`no [cold-start] line in stdout: ${stdout.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice('[cold-start]'.length).trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function p50(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const spec = machineSpec();
console.log(`[machine] CPU: ${spec.cpu} x${spec.cores} | RAM: ${spec.ramGB} GB | OS: ${spec.osLine} | Disk: ${spec.disk}`);
console.log(`[protocol] NFR-1 budget ${BUDGET_MS} ms, ${RUNS} runs, metric = p50(totalMs), source = main 'ready' -> did-finish-load (process.hrtime)`);

const samples = [];
for (let i = 1; i <= RUNS; i++) {
  try {
    const sample = await runOnce();
    samples.push(sample);
    console.log(
      `[run ${i}/${RUNS}] readyMs=${sample.readyMs} domReadyMs=${sample.domReadyMs} totalMs=${sample.totalMs}`,
    );
  } catch (error) {
    console.error(`[run ${i}/${RUNS}] FAILED: ${error.message}`);
  }
}

if (samples.length < 5) {
  console.error(`[cold-start] 仅 ${samples.length} 个有效样本（需 ≥5），判定 FAIL`);
  process.exit(1);
}

const totals = samples.map((s) => s.totalMs);
const median = p50(totals);
const best = Math.min(...totals);
const worst = Math.max(...totals);
const verdict = median <= BUDGET_MS ? 'PASS' : 'FAIL';
console.log(
  `[summary] n=${samples.length} p50=${median}ms min=${best}ms max=${worst}ms | budget ${BUDGET_MS}ms | ${verdict} (NFR-1)`,
);
fs.writeFileSync(
  path.join(pkgRoot, 'out', 'cold-start-samples.json'),
  JSON.stringify({ machine: spec, budgetMs: BUDGET_MS, samples, p50: median, verdict }, null, 2),
  'utf8',
);
console.log('[cold-start] samples written to out/cold-start-samples.json');
process.exit(verdict === 'PASS' ? 0 : 1);
