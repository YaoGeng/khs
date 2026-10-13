/**
 * telemetry e2e（todo 9 = T-M1-07）：
 * - ingest：同意批次 202 入库 + 行数断言 / consent 缺失或 false → 422 整批拒收 /
 *   anon_user_hash 64hex 形态 / payload 白名单剥离（内容字段无法入库）/ 采样率常量生效（注入随机源）；
 * - R1 告警（04:99）：fake clock 滚动 24h 窗口，6 事件触发 alerts 行、恰 24h 边界滑出、
 *   同窗口抑制与过期复触发、失败率 >20% 分支。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, resetState } from './helpers.js';
import { PrismaService } from '../src/infrastructure/prisma.service.js';
import { AppModule } from '../src/app.module.js';
import { EnvModule } from '../src/config/env.module.js';
import { PrismaModule } from '../src/infrastructure/prisma.module.js';
import { TELEMETRY_SAMPLING_RATE, type TelemetryEventDto } from '../src/telemetry/telemetry.dto.js';
import {
  R1_ALERT_KIND,
  R1_WINDOW_MS,
  TelemetryService,
  TELEMETRY_CLOCK,
  TELEMETRY_SAMPLING,
  type TelemetrySampling,
} from '../src/telemetry/telemetry.service.js';
import { TelemetryModule } from '../src/telemetry/telemetry.module.js';

const EVENTS_URL = '/api/v1/telemetry/events';
const HASH = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';

function evt(event: string, at: string, payload?: unknown, anonUserHash: string = HASH, consent = true) {
  return { consent, event, anon_user_hash: anonUserHash, payload: payload ?? null, at };
}

describe('telemetry ingest e2e（POST /api/v1/telemetry/events）', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
  });

  it('采样率常量默认 1.0：同意事件批次 202 全量入库 + 行数/字段断言', async () => {
    expect(TELEMETRY_SAMPLING_RATE).toBe(1.0);
    const at = '2026-10-01T00:00:00.000Z';
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([
        evt('circuit_open', at, { reason: 'captcha-hit' }),
        evt('selfcheck_fail', at, { platform: 'xhs', version: '1.0.0', failedCases: 2 }),
        evt('first_report_generated', at, { topicId: 't1' }),
      ]);
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(3);

    const rows = await prisma.telemetryEvent.findMany({ orderBy: { kind: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kind)).toEqual(['circuit_open', 'first_report_generated', 'selfcheck_fail']);
    for (const row of rows) {
      expect(row.userId).toMatch(/^[0-9a-f]{64}$/);
      expect(row.at.toISOString()).toBe(at);
    }
    expect(rows.find((r) => r.kind === 'selfcheck_fail')?.payloadJson).toEqual({
      platform: 'xhs',
      version: '1.0.0',
      failedCases: 2,
    });
  });

  it('consent=false → 422 整批拒收不落库（PC-02）', async () => {
    const at = '2026-10-01T00:00:00.000Z';
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([evt('circuit_open', at, { reason: 'captcha-hit' }), evt('selfcheck_fail', at, null, HASH, false)]);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('TELEMETRY_CONSENT_REQUIRED');
    expect(res.body.indices).toEqual([1]);
    expect(await prisma.telemetryEvent.count()).toBe(0);
  });

  it('consent 缺失 → 422（缺失同属未同意）', async () => {
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([{ event: 'circuit_open', anon_user_hash: HASH, payload: null, at: '2026-10-01T00:00:00.000Z' }]);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('TELEMETRY_CONSENT_REQUIRED');
    expect(await prisma.telemetryEvent.count()).toBe(0);
  });

  it('anon_user_hash 非 64hex → 400（服务端只校验形态）', async () => {
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([evt('circuit_open', '2026-10-01T00:00:00.000Z', null, 'short-hash')]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('event 枚举外 → 400', async () => {
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([evt('circuit_half_closed', '2026-10-01T00:00:00.000Z')]);
    expect(res.status).toBe(400);
  });

  it('payload 白名单外字段剥离入库：笔记内容字段无法落库（02:354）', async () => {
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([evt('circuit_open', '2026-10-01T00:00:00.000Z', { reason: 'captcha-hit', noteTitle: '秘密笔记标题', content: '笔记正文' })]);
    expect(res.status).toBe(202);
    const row = await prisma.telemetryEvent.findFirstOrThrow();
    expect(row.payloadJson).toEqual({ reason: 'captcha-hit' });
  });

  it('payload 白名单内类型不符 → 400', async () => {
    const res = await request(app.getHttpServer())
      .post(EVENTS_URL)
      .send([evt('selfcheck_fail', '2026-10-01T00:00:00.000Z', { platform: 'xhs', version: '1.0.0', failedCases: 'many' })]);
    expect(res.status).toBe(400);
  });

  it('at 非 ISO → 400', async () => {
    const res = await request(app.getHttpServer()).post(EVENTS_URL).send([evt('circuit_open', 'not-a-date')]);
    expect(res.status).toBe(400);
  });

  it('空批 / 非数组体 / 超 100 上限 → 400', async () => {
    expect((await request(app.getHttpServer()).post(EVENTS_URL).send([])).status).toBe(400);
    expect((await request(app.getHttpServer()).post(EVENTS_URL).send({ events: [] })).status).toBe(400);
    const at = '2026-10-01T00:00:00.000Z';
    const overflow = Array.from({ length: 101 }, () => evt('circuit_open', at));
    expect((await request(app.getHttpServer()).post(EVENTS_URL).send(overflow)).status).toBe(400);
  });

  it('采样率 0.5 + 注入固定随机序列 → 恰半数入库（常量生效断言）', async () => {
    let call = 0;
    const sampling: TelemetrySampling = { rate: 0.5, random: () => (call++ % 2 === 0 ? 0.1 : 0.9) };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TELEMETRY_SAMPLING)
      .useValue(sampling)
      .compile();
    const sampledApp = moduleRef.createNestApplication();
    sampledApp.setGlobalPrefix('api/v1');
    await sampledApp.init();
    try {
      const at = '2026-10-01T00:00:00.000Z';
      const batch = Array.from({ length: 10 }, (_, i) => evt('circuit_open', at, { reason: `r-${i}` }));
      const res = await request(sampledApp.getHttpServer()).post(EVENTS_URL).send(batch);
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(5);
      expect(await prisma.telemetryEvent.count()).toBe(5);
    } finally {
      await sampledApp.close();
    }
  });
});

describe('R1 自检失败率告警（fake clock 滚动 24h 窗口，04:99）', () => {
  const T0 = new Date('2026-01-01T00:00:00.000Z');
  let app: INestApplication;
  let service: TelemetryService;
  let prisma: PrismaService;
  let now: Date;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EnvModule, PrismaModule, TelemetryModule] })
      .overrideProvider(TELEMETRY_CLOCK)
      .useValue({ now: () => now })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(TelemetryService);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 直接入库 N 条 selfcheck_fail（绕过 HTTP；采样默认 1.0 全收，ingest 内自动评估 R1） */
  async function ingestFails(count: number, at: Date, extraEvents: TelemetryEventDto[] = []): Promise<void> {
    const events: TelemetryEventDto[] = Array.from({ length: count }, () => ({
      event: 'selfcheck_fail',
      anonUserHash: HASH,
      payload: { platform: 'xhs', version: '1.0.0', failedCases: 1 },
      at: at.toISOString(),
    }));
    await service.ingest([...events, ...extraEvents]);
  }

  beforeEach(async () => {
    now = new Date(T0.getTime() + 2 * 3_600_000);
    await prisma.telemetryEvent.deleteMany();
    await prisma.alert.deleteMany();
  });

  it('24h 内 6 事件 → alerts 行触发（阈值 ≥5）+ triggered_at 即 SLA 锚点', async () => {
    await ingestFails(6, new Date(T0.getTime() + 3_600_000));
    const rows = await prisma.alert.findMany();
    expect(rows).toHaveLength(1);
    const alert = rows[0]!;
    expect(alert.kind).toBe(R1_ALERT_KIND);
    expect(alert.count).toBe(6);
    expect(alert.rate).toBe(1);
    expect(alert.windowEnd.getTime()).toBe(now.getTime());
    expect(alert.windowStart.getTime()).toBe(now.getTime() - R1_WINDOW_MS);
    expect(alert.triggeredAt.getTime()).toBe(now.getTime());
  });

  it('恰满 24h 的旧事件滑出窗口不再计入（半开区间下界）', async () => {
    const t0 = new Date(T0.getTime() + 3_600_000);
    await ingestFails(1, t0);
    await prisma.alert.deleteMany();
    for (let i = 1; i <= 5; i += 1) {
      await ingestFails(1, new Date(t0.getTime() + 30 * 60_000));
      await prisma.alert.deleteMany();
    }
    // 边界前 1ms：首事件仍在窗口 → count=6
    now = new Date(t0.getTime() + R1_WINDOW_MS - 1);
    expect((await service.computeSelfcheckWindow()).count).toBe(6);
    // now = 首事件 + 恰 24h：窗口 (now-24h, now] 不含恰在边界的首事件 → 滑出，count=5
    now = new Date(t0.getTime() + R1_WINDOW_MS);
    expect((await service.computeSelfcheckWindow()).count).toBe(5);
    expect(await prisma.alert.count()).toBe(0);
  });

  it('阈值跌落后跨抑制期的新故障窗可复触发（ suppressing 只限 24h 内）', async () => {
    const first = new Date(T0.getTime() + 3_600_000);
    await ingestFails(6, first);
    expect(await prisma.alert.count()).toBe(1);

    // 同 24h 内再次超阈值（追加 1 条 fail）：抑制，不重复写行
    now = new Date(T0.getTime() + 10 * 3_600_000);
    await ingestFails(1, now);
    expect(await prisma.alert.count()).toBe(1);

    // 30h 后新一批 5 条 fail（抑制期已过）：新告警行（窗口含 T0+10h 的 1 条 + 新 5 条 = count 6）
    now = new Date(T0.getTime() + 30 * 3_600_000);
    await ingestFails(5, now);
    const rows = await prisma.alert.findMany({ orderBy: { triggeredAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.triggeredAt.getTime()).toBe(now.getTime());
    expect(rows[1]!.count).toBe(6);
  });

  it('失败率 >20% 分支：3 fail / 4 事件（rate 0.75）即触发，count<5', async () => {
    // 先入 1 条 circuit_open：分母先行，避免 3 fail 批次在 rate=1.0 时抢先触发
    await ingestFails(0, new Date(T0.getTime() + 3_600_002), [
      { event: 'circuit_open', anonUserHash: HASH, payload: { reason: 'captcha-hit' }, at: new Date(T0.getTime() + 3_600_002).toISOString() },
    ]);
    expect(await prisma.alert.count()).toBe(0);
    await ingestFails(3, new Date(T0.getTime() + 3_600_001));
    const rows = await prisma.alert.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
    expect(rows[0]!.rate).toBeCloseTo(0.75, 10);
  });

  it('窗口内无事件 → 不触发', async () => {
    expect(await service.evaluateSelfcheckFailAlert()).toBe(false);
    expect(await prisma.alert.count()).toBe(0);
  });
});
