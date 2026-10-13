/**
 * 遥测 ingest + R1 告警（todo 9 = T-M1-07；02:731 telemetry_events；04:99 R1 硬规格）。
 *
 * ingest：批量入库（采样率常量过滤，随机源可注入）→ 滚动 24h 窗口评估 R1 自检失败率告警。
 * R1 口径（04:99：「24h 响应」从自检失败率告警触发起算，非用户投诉起算）：
 * - 窗口 = 半开区间 (now-24h, now]：恰好满 24h 的旧事件滑出不再计入；
 * - 触发 = 窗口内 selfcheck_fail ≥5 次 或 失败率 >20%（失败率分母 = 窗口内全部遥测事件数——
 *   七枚举无 selfcheck_pass 事件，selfcheck 成功不上报，分母以窗口内事件总量作代理口径）；
 * - 触发 → 写 alerts 记录行（triggered_at = 24h SLA 起算锚点）+ 服务端日志；
 *   不接邮件/企微/任何通知通道（归 M5 T-M5-05）；
 * - 同窗口期抑制：距上次同类告警 <24h 内不重复写行（滚动窗口下每次 ingest 都会超阈值，
 *   否则同一故障窗会刷出大量重复告警行）。
 * clock 随机源均可注入（测试以 fake clock 覆盖窗口滑出边界 / 以固定序列断言采样）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { TelemetryEventDto } from './telemetry.dto.js';

/** 采样率常量 + 随机源（测试注入固定序列断言采样率生效） */
export interface TelemetrySampling {
  readonly rate: number;
  readonly random: () => number;
}

/** 可注入时钟（R1 滚动窗口 / triggered_at 锚点；测试以 fake clock 覆盖边界） */
export interface TelemetryClock {
  readonly now: () => Date;
}

export const TELEMETRY_SAMPLING = 'TELEMETRY_SAMPLING';
export const TELEMETRY_CLOCK = 'TELEMETRY_CLOCK';

/** 滚动窗口宽度：24h（04:99 硬规格） */
export const R1_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 阈值①：窗口内 selfcheck_fail ≥5 次 */
export const R1_SELFCHECK_FAIL_COUNT_THRESHOLD = 5;
/** 阈值②：窗口内失败率 >20% */
export const R1_FAILURE_RATE_THRESHOLD = 0.2;
/** alerts.kind（本卡唯一告警类别） */
export const R1_ALERT_KIND = 'selfcheck_fail_rate';

export interface SelfcheckWindowStats {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly count: number;
  readonly total: number;
  readonly rate: number;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TELEMETRY_SAMPLING) private readonly sampling: TelemetrySampling,
    @Inject(TELEMETRY_CLOCK) private readonly clock: TelemetryClock,
  ) {}

  /** 批量入库（采样后）+ R1 窗口评估；返回采样后实际入库数 */
  async ingest(events: readonly TelemetryEventDto[]): Promise<{ accepted: number }> {
    // 采样口径：keep = random() < rate（rate=1.0 恒真；rate=0.5 半数；恒定率 + 注入随机源 → 确定性可断言）
    const sampled = events.filter(() => this.sampling.random() < this.sampling.rate);
    if (sampled.length > 0) {
      await this.prisma.telemetryEvent.createMany({
        data: sampled.map((event) => ({
          userId: event.anonUserHash,
          kind: event.event,
          payloadJson: (event.payload ?? {}) as Prisma.InputJsonValue,
          at: new Date(event.at),
        })),
      });
    }
    await this.evaluateSelfcheckFailAlert();
    return { accepted: sampled.length };
  }

  /** 滚动 24h 窗口统计（半开区间 (now-24h, now]：恰满 24h 的旧事件滑出不再计入） */
  async computeSelfcheckWindow(now: Date = this.clock.now()): Promise<SelfcheckWindowStats> {
    const windowEnd = now;
    const windowStart = new Date(windowEnd.getTime() - R1_WINDOW_MS);
    const inWindow = { at: { gt: windowStart, lte: windowEnd } };
    const [count, total] = await Promise.all([
      this.prisma.telemetryEvent.count({ where: { kind: 'selfcheck_fail', ...inWindow } }),
      this.prisma.telemetryEvent.count({ where: inWindow }),
    ]);
    return { windowStart, windowEnd, count, total, rate: total === 0 ? 0 : count / total };
  }

  /**
   * R1 评估：超阈值且不在同窗口抑制期 → 写 alerts 行（triggered_at = SLA 锚点）+ 服务端日志。
   * 返回本次是否新写告警行。
   */
  async evaluateSelfcheckFailAlert(now: Date = this.clock.now()): Promise<boolean> {
    const stats = await this.computeSelfcheckWindow(now);
    const triggered = stats.count >= R1_SELFCHECK_FAIL_COUNT_THRESHOLD || stats.rate > R1_FAILURE_RATE_THRESHOLD;
    if (!triggered) return false;

    const last = await this.prisma.alert.findFirst({
      where: { kind: R1_ALERT_KIND },
      orderBy: { triggeredAt: 'desc' },
    });
    if (last && now.getTime() - last.triggeredAt.getTime() < R1_WINDOW_MS) return false;

    await this.prisma.alert.create({
      data: {
        kind: R1_ALERT_KIND,
        triggeredAt: now,
        windowStart: stats.windowStart,
        windowEnd: stats.windowEnd,
        count: stats.count,
        rate: stats.rate,
      },
    });
    // 仅服务端日志（04:99 R1）；SLA：24h 响应自本 triggered_at 起算
    this.logger.warn(
      `R1 selfcheck alert triggered: count=${stats.count}/${stats.total} rate=${stats.rate.toFixed(4)} window=[${stats.windowStart.toISOString()}, ${stats.windowEnd.toISOString()}] slaAnchor=${now.toISOString()}`,
    );
    return true;
  }
}
