import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AppliedMembership } from '../membership/membership.service.js';
import { MembershipService } from '../membership/membership.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { TokenService } from '../security/token.service.js';
import { Prisma } from '../generated/prisma/client.js';

/** 库内只存 hash：sha256(明文码, utf8) hex；明文只在生成脚本输出时可见。 */
export function hashCardCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export type RedeemResult = Readonly<{
  membership: AppliedMembership;
  authorizationJwt: string;
}>;

@Injectable()
export class CardsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * D9 最小兑换：防重放 = 事务内对 status 的条件更新
   * （等价 UPDATE activation_cards SET status='redeemed' WHERE id=? AND status='unused'，并发下只有一个事务能改到行）。
   * 兑换成功：会员入账 + 审计留痕 + 签发授权 JWT（claims：sub/plan/tier/device_limit，02 §12.3）。
   */
  async redeem(userEmail: string, code: string): Promise<RedeemResult> {
    const user = await this.prisma.user.findUnique({ where: { email: userEmail } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND' });

    const codeHash = hashCardCode(code);
    const card = await this.prisma.card.findUnique({ where: { codeHash } });
    if (!card) throw new NotFoundException({ error: 'CARD_NOT_FOUND' });

    const membership = await this.prisma
      .$transaction(async (tx) => {
        const updated = await tx.card.updateMany({
          where: { id: card.id, status: 'unused' },
          data: { status: 'redeemed', redeemedBy: user.id, redeemedAt: new Date() },
        });
        if (updated.count === 0) {
          throw new ConflictException({ error: 'CARD_ALREADY_REDEEMED' });
        }
        const applied = await this.memberships.applyCard(tx, user.id, card.plan, card.tier);
        await this.audit.write(tx, user.id, 'card.redeem', {
          cardId: card.id,
          plan: card.plan,
          tier: card.tier,
        });
        return applied;
      })
      .catch((e: unknown) => {
        // P2004/P2028：事务冲突/超时——并发竞争下与「已被兑换」同义（D9 指定的回退判定）。
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          (e.code === 'P2004' || e.code === 'P2028')
        ) {
          throw new ConflictException({ error: 'CARD_ALREADY_REDEEMED' });
        }
        throw e;
      });

    const authorizationJwt = this.tokens.signAuthorizationToken({
      sub: user.id,
      plan: membership.plan,
      tier: membership.tier,
      device_limit: membership.deviceLimit,
    });
    return { membership, authorizationJwt };
  }
}
