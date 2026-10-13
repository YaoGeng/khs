/**
 * 遥测事件 zod 契约（todo 9 = T-M1-07；02 §12.1/§13 v1.2，zod 唯一真源归本 todo 所有权）。
 *
 * 事件体 {consent, event, anon_user_hash, payload, at}（02:734）：
 * - event 七枚举：circuit_open / circuit_half_open / circuit_closed / selfcheck_fail /
 *   first_collection_completed / first_report_generated / key_failover（02:688）；
 * - anon_user_hash = 64hex 匿名用户假名（HMAC 化安装随机 id，desktop 侧生成，服务端只校验形态）；
 * - payload 白名单（02:354「不含任何笔记内容字段」）：按 event kind 列名白名单 + 标量类型约束，
 *   白名单外字段一律剥离（不入库不转发）——白名单内也只可能是限长标量，内容字段无法入库；
 * - consent ≠ true → 422 拒收（schema 层强制：形态解析与受理解析同为 zod schema，
 *   「缺失/false」同属未同意走 422，形态错误走 400——PC-02 未同意不采集不上报）。
 *
 * 批量语义（02:734「批量 + 采样」）：请求体 = 事件数组（≤100，对齐 store MAX_BATCH_ROWS 惯例）；
 * 采样为服务端固定采样率常量（TELEMETRY_SAMPLING_RATE，默认 1.0）；重试 = 客户端侧 ≤1 次静默，服务端不管。
 */
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';

/** 事件七枚举（02:688 v1.2；顺序即枚举声明序） */
export const TELEMETRY_EVENT_KINDS = [
  'circuit_open',
  'circuit_half_open',
  'circuit_closed',
  'selfcheck_fail',
  'first_collection_completed',
  'first_report_generated',
  'key_failover',
] as const;

export type TelemetryEventKind = (typeof TELEMETRY_EVENT_KINDS)[number];

/** 匿名用户假名形态：64hex（HMAC-SHA256 输出；desktop 生成，服务端只校验形态） */
export const ANON_USER_HASH_REGEX = /^[0-9a-f]{64}$/;

/** 批量上限（对齐 store MAX_BATCH_ROWS=100 惯例；空批/超限→400） */
export const TELEMETRY_MAX_BATCH = 100;

/** 服务端固定采样率常量（默认全量；>1 视作 1.0，<0 视作 0） */
export const TELEMETRY_SAMPLING_RATE = 1.0;

const anonUserHashSchema = z.string().regex(ANON_USER_HASH_REGEX, 'anon_user_hash 须为 64hex 匿名假名');
const atSchema = z.iso.datetime({ offset: true });

// payload 白名单：列名 + 标量类型 + 限长；zod object 默认剥离未知键（白名单强制，防内容字段入库）。
// 来源对齐：circuit_*（stealth-middleware emitter 三字段 kind/at/reason——kind/at 走事件顶层，payload 只收 reason）、
// selfcheck_fail（adapter-loader emitTelemetry {platform, version, failedCases}）、
// first_collection_completed（todo-7 接线）、first_report_generated（todo-8 接线）、key_failover（todo-12）。
const circuitPayloadSchema = z.object({ reason: z.string().max(64).optional() });
const selfcheckFailPayloadSchema = z.object({
  platform: z.string().max(32).optional(),
  version: z.string().max(32).optional(),
  failedCases: z.number().int().nonnegative().optional(),
});
const firstCollectionPayloadSchema = z.object({
  runId: z.string().max(64).optional(),
  topicId: z.string().max(64).optional(),
  collectedCount: z.number().int().nonnegative().optional(),
});
const firstReportPayloadSchema = z.object({
  topicId: z.string().max(64).optional(),
  reportId: z.string().max(64).optional(),
  model: z.string().max(64).optional(),
});
const keyFailoverPayloadSchema = z.object({
  provider: z.string().max(32).optional(),
  reason: z.string().max(64).optional(),
});

const payloadField = (shape: z.ZodType) => z.union([z.null(), shape]).optional();

/**
 * 事件变体构造器：consent 仅查形（boolean 可缺省——缺失归入「未同意」走 422 而非 400）。
 * 泛型 E 让 z.literal 收窄到单一字面量（discriminatedUnion 依赖逐 variant 的字面量判别）。
 */
function eventVariant<E extends TelemetryEventKind>(event: E, payloadSchema: z.ZodType) {
  return z.object({
    consent: z.boolean().optional(),
    event: z.literal<E>(event),
    anon_user_hash: anonUserHashSchema,
    payload: payloadField(payloadSchema),
    at: atSchema,
  });
}

const SHAPE_OPTIONS = [
  eventVariant('circuit_open', circuitPayloadSchema),
  eventVariant('circuit_half_open', circuitPayloadSchema),
  eventVariant('circuit_closed', circuitPayloadSchema),
  eventVariant('selfcheck_fail', selfcheckFailPayloadSchema),
  eventVariant('first_collection_completed', firstCollectionPayloadSchema),
  eventVariant('first_report_generated', firstReportPayloadSchema),
  eventVariant('key_failover', keyFailoverPayloadSchema),
] as const;

const ACCEPTED_OPTIONS = [
  eventVariant('circuit_open', circuitPayloadSchema).extend({ consent: z.literal(true) }),
  eventVariant('circuit_half_open', circuitPayloadSchema).extend({ consent: z.literal(true) }),
  eventVariant('circuit_closed', circuitPayloadSchema).extend({ consent: z.literal(true) }),
  eventVariant('selfcheck_fail', selfcheckFailPayloadSchema).extend({ consent: z.literal(true) }),
  eventVariant('first_collection_completed', firstCollectionPayloadSchema).extend({ consent: z.literal(true) }),
  eventVariant('first_report_generated', firstReportPayloadSchema).extend({ consent: z.literal(true) }),
  eventVariant('key_failover', keyFailoverPayloadSchema).extend({ consent: z.literal(true) }),
] as const;

/** 形态 schema（事件体结构/枚举/64hex/ISO 时间/payload 白名单） */
const telemetryEventShapeSchema = z.discriminatedUnion('event', SHAPE_OPTIONS);
/** 受理 schema（schema 层强制 consent === true，否则拒收） */
const telemetryAcceptedEventSchema = z.discriminatedUnion('event', ACCEPTED_OPTIONS);
const shapeBatchSchema = z.array(telemetryEventShapeSchema).min(1).max(TELEMETRY_MAX_BATCH);
const acceptedBatchSchema = z.array(telemetryAcceptedEventSchema).min(1).max(TELEMETRY_MAX_BATCH);

export interface TelemetryEventDto {
  readonly event: TelemetryEventKind;
  readonly anonUserHash: string;
  readonly payload: Record<string, unknown> | null;
  readonly at: string;
}

function issuesOf(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/**
 * 批量解析（HTTP 边界唯一入口）：
 * - 形态不合法（非数组/空批/超限/枚举外/64hex 不符/时间戳非法/payload 类型不符）→ 400 VALIDATION_ERROR；
 * - 形态合法但任一事件 consent !== true（false 或缺失）→ 422 TELEMETRY_CONSENT_REQUIRED，整批拒收不落库。
 */
export function parseTelemetryBatch(body: unknown): TelemetryEventDto[] {
  if (!Array.isArray(body)) {
    throw new BadRequestException({
      error: 'VALIDATION_ERROR',
      issues: [{ path: '', message: `请求体须为事件数组（1..${TELEMETRY_MAX_BATCH}）` }],
    });
  }
  const accepted = acceptedBatchSchema.safeParse(body);
  if (accepted.success) {
    return accepted.data.map((event) => ({
      event: event.event,
      anonUserHash: event.anon_user_hash,
      payload: (event.payload ?? null) as Record<string, unknown> | null,
      at: event.at,
    }));
  }
  // 形态问题与未同意问题分流出 400/422：受理解析失败后按形态 schema 归因，形态通过才判 422。
  const shape = shapeBatchSchema.safeParse(body);
  if (shape.success) {
    const indices = shape.data.reduce<number[]>((acc, event, index) => (event.consent !== true ? [...acc, index] : acc), []);
    throw new UnprocessableEntityException({
      error: 'TELEMETRY_CONSENT_REQUIRED',
      message: 'consent ≠ true（PC-02：未同意不采集不上报），整批拒收',
      indices,
    });
  }
  throw new BadRequestException({ error: 'VALIDATION_ERROR', issues: issuesOf(shape.error) });
}
