import { Inject, Injectable } from '@nestjs/common';
import type { Plan, Prisma, Tier } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma.service.js';

/** FR-1.3：月卡 31 天 / 季卡 93 天 / 年卡 372 天。 */
const PLAN_DAYS: Readonly<Record<Plan, number>> = { month: 31, quarter: 93, year: 372 };

/** 02 §12.3：tier → device_limit（个人 1 台 / 团队 3 台）。 */
const TIER_DEVICE_LIMIT: Readonly<Record<Tier, number>> = { personal: 1, team: 3 };

const DAY_MS = 24 * 60 * 60 * 1000;

export type AppliedMembership = Readonly<{
  plan: Plan;
  tier: Tier;
  deviceLimit: number;
  startsAt: Date;
  endsAt: Date;
}>;

const toApplied = (row: {
  plan: Plan;
  tier: Tier;
  deviceLimit: number;
  startsAt: Date;
  endsAt: Date;
}): AppliedMembership => ({
  plan: row.plan,
  tier: row.tier,
  deviceLimit: row.deviceLimit,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
});

@Injectable()
export class MembershipService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  deviceLimitFor(tier: Tier): number {
    return TIER_DEVICE_LIMIT[tier];
  }

  /** 兑换入账（事务内调用）：有未到期会员则顺延叠加并把套餐/档位更新为本次兑换的值；否则新开会员期。 */
  async applyCard(
    client: Prisma.TransactionClient,
    userId: string,
    plan: Plan,
    tier: Tier,
  ): Promise<AppliedMembership> {
    const now = new Date();
    const active = await client.membership.findFirst({
      where: { userId, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });
    const endsAt = new Date(
      (active && active.endsAt > now ? active.endsAt.getTime() : now.getTime()) +
        PLAN_DAYS[plan] * DAY_MS,
    );
    if (active) {
      const updated = await client.membership.update({
        where: { id: active.id },
        data: { plan, tier, deviceLimit: this.deviceLimitFor(tier), endsAt },
      });
      return toApplied(updated);
    }
    const created = await client.membership.create({
      data: {
        userId,
        plan,
        tier,
        deviceLimit: this.deviceLimitFor(tier),
        startsAt: now,
        endsAt,
        source: 'card',
      },
    });
    return toApplied(created);
  }

  /** 登录/刷新时取当前有效会员（无则 null，JWT claims 不含会员字段）。 */
  async currentFor(userId: string): Promise<AppliedMembership | null> {
    const row = await this.prisma.membership.findFirst({
      where: { userId, endsAt: { gt: new Date() } },
      orderBy: { endsAt: 'desc' },
    });
    return row ? toApplied(row) : null;
  }
}
