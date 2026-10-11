/**
 * trace/span id 生成（02-系统架构设计.md §10.2 trace 模型；W3C Trace Context 风格简式）。
 */
import { randomBytes, randomUUID } from 'node:crypto';

/** trace_id：每任务一个（02 §10.2） */
export function newTraceId(): string {
  return randomUUID();
}

/** span_id：步骤级，16 位 hex（W3C spanId 宽度） */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}
