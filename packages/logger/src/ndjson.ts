/**
 * NDJSON 行与结构化条目的互转（pino 序列化产物 → LogEntry）。
 * 行即唯一事实源：文件 sink / store sink / 内存缓冲都从同一行派生。
 */
import { LOG_CATEGORIES, type LogCategory, type LogEntry, type LogLevel } from './types.js';

const LEVEL_NAMES: Record<number, LogLevel> = {
  10: 'debug',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error',
};

interface PinoLine {
  time?: unknown;
  level?: unknown;
  levelName?: unknown;
  category?: unknown;
  msg?: unknown;
  trace_id?: unknown;
  span_id?: unknown;
  payload?: unknown;
}

/** pino 输出行 → LogEntry；无法识别的行返回 null（不抛，防御半写损坏行） */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: PinoLine;
  try {
    raw = JSON.parse(trimmed) as PinoLine;
  } catch {
    return null;
  }
  if (typeof raw.category !== 'string' || !LOG_CATEGORIES.includes(raw.category as LogCategory)) {
    return null;
  }
  if (typeof raw.time !== 'string') return null;
  const level = typeof raw.level === 'number' ? raw.level : 30;
  const entry: LogEntry = {
    ts: raw.time,
    level,
    levelName: typeof raw.levelName === 'string' ? (raw.levelName as LogLevel) : (LEVEL_NAMES[level] ?? 'info'),
    category: raw.category as LogCategory,
    msg: typeof raw.msg === 'string' ? raw.msg : '',
  };
  if (typeof raw.trace_id === 'string' && raw.trace_id.length > 0) entry.traceId = raw.trace_id;
  if (typeof raw.span_id === 'string' && raw.span_id.length > 0) entry.spanId = raw.span_id;
  if (raw.payload !== undefined && raw.payload !== null) entry.payload = raw.payload;
  return entry;
}
