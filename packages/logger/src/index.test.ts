/**
 * logger 管线单测：五类样例（FR-10.1）+ trace 串联查询（02 §10.2）+ 保留清理（FR-10.3）
 * + sink 异常隔离 + 内存缓冲环形。
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, parseLogLine, newTraceId, type LogSink, type LogEntry } from './index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-logger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(file: string): LogEntry[] {
  const raw = readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => parseLogLine(l))
    .filter((e): e is LogEntry => e !== null);
}

describe('五类日志样例（FR-10.1）', () => {
  it('五类便捷方法各产一条样例，category 落 NDJSON 顶层', () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs') });
    logger.userAction('用户点击导出', { target: 'export-btn' });
    logger.automationStep('步骤开始', { stepId: 's1' });
    logger.llmCall('调用完成', { provider: 'deepseek', tokensIn: 12, tokensOut: 34 });
    logger.networkMeta('GET 200', { domain: 'example.com', status: 200, ms: 12 });
    logger.systemError('崩溃', { stack: 'Error: x' });

    const files = readdirSync(path.join(dir, 'logs'));
    const appFiles = files.filter((f) => f.startsWith('app-'));
    const networkFiles = files.filter((f) => f.startsWith('network-'));
    expect(appFiles).toHaveLength(1);
    expect(networkFiles).toHaveLength(1);

    const appEntries = readLines(path.join(dir, 'logs', appFiles[0] as string));
    expect(appEntries.map((e) => e.category)).toEqual([
      'user-action',
      'automation-step',
      'llm-call',
      'system-error',
    ]);
    const networkEntries = readLines(path.join(dir, 'logs', networkFiles[0] as string));
    expect(networkEntries.map((e) => e.category)).toEqual(['network-meta']);
    // network_meta 不录 body 与 Cookie（02 §10.1 列约束）：payload 由调用方控制，管线原样落
    expect(networkEntries[0]?.payload).toEqual({ domain: 'example.com', status: 200, ms: 12 });
  });

  it('log() 通用入口 + level 分档（systemError 固定 error）', () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs') });
    logger.log('user-action', 'warn', '配置即将过期');
    logger.systemError('失败');
    const file = readdirSync(path.join(dir, 'logs'))[0] as string;
    const entries = readLines(path.join(dir, 'logs', file));
    expect(entries.map((e) => e.levelName)).toEqual(['warn', 'error']);
    expect(entries[1]?.level).toBe(50);
  });

  it('level 过滤：debug 级默认不落盘', () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs'), level: 'info' });
    logger.log('user-action', 'debug', '不应出现');
    const files = readdirSync(path.join(dir, 'logs'));
    expect(files).toHaveLength(0);
  });
});

describe('trace 串联（02 §10.2）', () => {
  it('child 绑定 trace_id/span_id 贯穿全部记录；span 入口开/出口闭合', () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs') });
    const traceId = newTraceId();
    const task = logger.child({ traceId });
    const span = task.startSpan('demo-step-1', { stepId: 's1' });
    span.logger.automationStep('步骤执行中', { stepId: 's1' });
    span.end('ok', { result: 'done' });

    const file = readdirSync(path.join(dir, 'logs'))[0] as string;
    const entries = readLines(path.join(dir, 'logs', file));
    expect(entries.length).toBe(3);
    for (const e of entries) {
      expect(e.traceId).toBe(traceId);
      expect(e.spanId).toBe(span.spanId);
    }
    const [start, mid, end] = entries as [LogEntry, LogEntry, LogEntry];
    // 入口开 span、出口闭合：span:start / span:end 同一 span_id
    expect(start.msg).toBe('span:start:demo-step-1');
    expect(end.msg).toBe('span:end:demo-step-1');
    expect(start.spanId).toBe(span.spanId);
    expect(end.spanId).toBe(span.spanId);
    expect((end.payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    expect((end.payload as { status: string }).status).toBe('ok');
    expect(mid.msg).toBe('步骤执行中');
  });

  it('按 trace_id 串联查询：两个任务互不串线', () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs') });
    const traceA = newTraceId();
    const traceB = newTraceId();
    logger.child({ traceId: traceA }).automationStep('A-1');
    logger.child({ traceId: traceB }).automationStep('B-1');
    logger.child({ traceId: traceA }).automationStep('A-2');

    const file = readdirSync(path.join(dir, 'logs'))[0] as string;
    const all = readLines(path.join(dir, 'logs', file));
    const byA = all.filter((e) => e.traceId === traceA);
    const byB = all.filter((e) => e.traceId === traceB);
    expect(byA.map((e) => e.msg)).toEqual(['A-1', 'A-2']);
    expect(byB.map((e) => e.msg)).toEqual(['B-1']);
  });

  it('child 链式绑定：trace 继承 + span 覆盖', () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs') });
    const traceId = newTraceId();
    const task = logger.child({ traceId });
    const nested = task.child({ spanId: 'aaaaaaaaaaaaaaaa' });
    nested.userAction('嵌套记录');
    const span = task.startSpan('x');
    span.end();

    const file = readdirSync(path.join(dir, 'logs'))[0] as string;
    const entries = readLines(path.join(dir, 'logs', file));
    expect(entries[0]?.spanId).toBe('aaaaaaaaaaaaaaaa');
    expect(entries[0]?.traceId).toBe(traceId);
    expect(entries[1]?.spanId).toBe(span.spanId);
  });
});

describe('保留清理（FR-10.3：本地 90 天 / 网络元数据 30 天）', () => {
  function writeFakeFile(name: string, content = '{}\n'): void {
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    writeFileSync(path.join(dir, 'logs', name), content, 'utf8');
  }

  it('app-* 过 90 天删除、network-* 过 30 天删除、边界内保留', () => {
    const logsDir = path.join(dir, 'logs');
    writeFakeFile('app-2026-01-01.ndjson');
    writeFakeFile('network-2026-01-01.ndjson');
    // 边界：app 第 90 天保留、第 91 天删除；network 第 30 天保留、第 31 天删除
    writeFakeFile('app-2026-07-03.ndjson'); // 2026-10-11 前整 100 天 → 删
    writeFakeFile('network-2026-09-12.ndjson'); // 29 天 → 留
    const now = new Date('2026-10-11T12:00:00Z');
    const logger = createLogger({ logsDir });
    return logger.enforceRetention(now).then((report) => {
      expect(report.filesDeleted).toBe(3); // app-2026-01-01、network-2026-01-01、app-2026-07-03
      expect(existsSync(path.join(logsDir, 'app-2026-01-01.ndjson'))).toBe(false);
      expect(existsSync(path.join(logsDir, 'network-2026-01-01.ndjson'))).toBe(false);
      expect(existsSync(path.join(logsDir, 'app-2026-07-03.ndjson'))).toBe(false);
      expect(existsSync(path.join(logsDir, 'network-2026-09-12.ndjson'))).toBe(true);
    });
  });

  it('sink.prune 扇出携带策略；sink 抛错隔离为 -1', async () => {
    const logsDir = path.join(dir, 'logs');
    const pruned: Array<{ policy: unknown; now: Date | undefined }> = [];
    const storeSink: LogSink = {
      name: 'store',
      write() {},
      prune(policy, now) {
        pruned.push({ policy, now });
        return 42;
      },
    };
    const evilSink: LogSink = {
      name: 'evil',
      write() {},
      prune() {
        throw new Error('boom');
      },
    };
    const logger = createLogger({ logsDir, sinks: [storeSink, evilSink] });
    const now = new Date('2026-10-11T12:00:00Z');
    const report = await logger.enforceRetention(now);
    expect(report.filesDeleted).toBe(0);
    expect(report.sinkRowsDeleted).toEqual({ store: 42, evil: -1 });
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.policy).toEqual({ localDays: 90, networkMetaDays: 30 });
    expect(pruned[0]?.now).toBe(now);
  });
});

describe('sink 注入与内存缓冲', () => {
  it('外部 sink 收到与 NDJSON 等价的结构化条目', () => {
    const received: LogEntry[] = [];
    const sink: LogSink = { name: 'mem', write: (e) => received.push(e) };
    const logger = createLogger({ sinks: [sink], memoryBufferSize: 0 });
    logger.userAction('点击', { x: 1 });
    expect(received).toHaveLength(1);
    expect(received[0]?.category).toBe('user-action');
    expect(received[0]?.msg).toBe('点击');
    expect(received[0]?.payload).toEqual({ x: 1 });
    expect(typeof received[0]?.ts).toBe('string');
  });

  it('sink 抛错不阻断管线与文件输出', () => {
    const sink: LogSink = {
      name: 'evil',
      write() {
        throw new Error('sink down');
      },
    };
    const logger = createLogger({ logsDir: path.join(dir, 'logs'), sinks: [sink] });
    expect(() => {
      logger.userAction('仍应落盘');
    }).not.toThrow();
    const file = readdirSync(path.join(dir, 'logs'))[0] as string;
    const entries = readLines(path.join(dir, 'logs', file));
    expect(entries).toHaveLength(1);
  });

  it('内存环形缓冲：默认开、上限 shift、可关闭', () => {
    const ringLogger = createLogger({ memoryBufferSize: 3 });
    for (let i = 0; i < 5; i += 1) ringLogger.userAction(`m${i}`);
    expect(ringLogger.getBuffer().map((e) => e.msg)).toEqual(['m2', 'm3', 'm4']);

    const offLogger = createLogger({ memoryBufferSize: 0 });
    offLogger.userAction('x');
    expect(offLogger.getBuffer()).toHaveLength(0);
  });

  it('close 后不再产出记录', async () => {
    const logger = createLogger({ logsDir: path.join(dir, 'logs') });
    logger.userAction('before');
    await logger.close();
    logger.userAction('after');
    const file = readdirSync(path.join(dir, 'logs'))[0] as string;
    expect(readLines(path.join(dir, 'logs', file))).toHaveLength(1);
  });
});

describe('parseLogLine 防御', () => {
  it('半写行/空行/未知类别返回 null', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('{"truncated')).toBeNull();
    expect(parseLogLine('{"time":"2026-10-11T00:00:00.000Z","level":30,"category":"evil","msg":"x"}')).toBeNull();
    expect(parseLogLine('{"level":30,"category":"user-action","msg":"no-time"}')).toBeNull();
  });

  it('合法行往返（含可选 trace/span/payload）', () => {
    const line = '{"level":30,"levelName":"info","time":"2026-10-11T00:00:00.000Z","category":"automation-step","trace_id":"t","span_id":"s","payload":{"a":1},"msg":"m"}';
    const entry = parseLogLine(line);
    expect(entry).toEqual({
      ts: '2026-10-11T00:00:00.000Z',
      level: 30,
      levelName: 'info',
      category: 'automation-step',
      msg: 'm',
      traceId: 't',
      spanId: 's',
      payload: { a: 1 },
    });
  });
});
