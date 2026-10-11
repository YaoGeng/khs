/**
 * 保留策略执行（FR-10.3：本地 90 天 / 网络元数据 30 天）。
 * 范围：NDJSON 文件按文件名日期整档清理 + 各 sink 自行按行清理（store sink → DELETE）。
 * 触发职责归宿主（desktop：启动时 + 定时；logger 只提供幂等函数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LogSink, PruneReport, RetentionPolicy } from './types.js';

/** 文件名类别前缀：network-* 走 30 天，app-* 走 90 天（02 §10.1 保留列） */
const FILENAME_PATTERN = /^(app|network)-(\d{4}-\d{2}-\d{2})\.ndjson$/;

function cutoffDate(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 删除过期 NDJSON 文件（按文件名日期；不可解析的文件不动） */
export function pruneLogFiles(logsDir: string, policy: RetentionPolicy, now: Date = new Date()): number {
  let filesDeleted = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const match = FILENAME_PATTERN.exec(name);
    if (!match) continue;
    const kind = match[1];
    const day = match[2];
    const limitDays = kind === 'network' ? policy.networkMetaDays : policy.localDays;
    if (day <= cutoffDate(now, limitDays)) {
      try {
        fs.unlinkSync(path.join(logsDir, name));
        filesDeleted += 1;
      } catch {
        // 单文件删除失败不阻断清理（下轮重试）
      }
    }
  }
  return filesDeleted;
}

/** 完整保留清理：文件 + 各 sink 的 prune 扇出（sink 异常隔离，计入 -1） */
export async function enforceRetention(
  logsDir: string,
  policy: RetentionPolicy,
  sinks: LogSink[],
  now: Date = new Date(),
): Promise<PruneReport> {
  const filesDeleted = pruneLogFiles(logsDir, policy, now);
  const sinkRowsDeleted: Record<string, number> = {};
  for (const sink of sinks) {
    if (!sink.prune) continue;
    try {
      sinkRowsDeleted[sink.name] = await sink.prune(policy, now);
    } catch {
      sinkRowsDeleted[sink.name] = -1;
    }
  }
  return { filesDeleted, sinkRowsDeleted };
}
