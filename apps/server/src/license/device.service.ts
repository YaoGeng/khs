/**
 * 设备绑定与解绑（todo 8 = T-M0-07；FR-1.4 设备上限 / FR-1.5 解绑 30 天限 1 次）。
 *
 * - 客户端只上报 device_hash（02 §11.4：指纹=机器标识稳定量的 sha256，原始指纹不出机器）。
 * - device_limit 由 tier 映射（个人 1 / 团队 3，02 §12.3）；个人版第 2 台激活 → 409 阻断（门禁①验收口径）。
 * - 30 天解绑限 1 次：以该用户 devices 的 max(revokedAt) 为「上次解绑时间戳」（M0 决策，
 *   不另设 user 级列；见 docs/adr/notes-license-m0.md §4）。
 * - jti 在线吊销归 M5 配置中心；M0 仅把 jti 记入 audit（docs/adr/notes-license-m0.md §3）。
 */
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { MembershipService } from '../membership/membership.service.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { LicenseSigningService, LicenseVerificationError, type LicenseClaims } from './license-signing.service.js';

export type ActivationResult = Readonly<{
  licenseJwt: string;
  jti: string;
  device: { deviceHash: string; activatedAt: string; lastSeenAt: string };
  membership: { plan: string; tier: string; deviceLimit: number; endsAt: string };
}>;

export type UnbindResult = Readonly<{
  ok: true;
  deviceHash: string;
  unboundAt: string;
  nextUnbindAllowedAt: string;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 事务内部信号：设备超限（对外映射 409；审计在本事务回滚后单独落库，防「阻断不留痕」） */
class DeviceLimitSignal extends Error {}

@Injectable()
export class DeviceService {
  private readonly cooldownDays: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LicenseSigningService) private readonly licenses: LicenseSigningService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cooldownDays = config.XINGLIAN_UNBIND_COOLDOWN_DAYS;
  }

  /**
   * 激活：出示兑换签发的 license + 本机 device_hash。
   * 校验链：验签(401) → 归属(401) → 会员有效(403) → 设备指纹一致(403) → 设备上限(409) → 绑定 + 换发绑定版 license。
   * 事务内 count + create（SERIALIZABLE）：并发激活同一账号时至少一方以 P2034 回退为 409，防止超限。
   */
  async activate(email: string, licenseJwt: string, deviceHash: string): Promise<ActivationResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND' });

    const claims = this.licenses.verifyLicense(licenseJwt);
    if (claims.sub !== user.id) throw new LicenseVerificationError('LICENSE_SIGNATURE_INVALID');
    // 已绑定到其他设备的 license 不能在本机激活（绑定语义；'' = 未绑定待激活）
    if (claims.device_hash.length > 0 && claims.device_hash !== deviceHash) {
      throw new ForbiddenException({ error: 'DEVICE_MISMATCH' });
    }

    const membership = await this.memberships.currentFor(user.id);
    if (!membership) throw new ForbiddenException({ error: 'MEMBERSHIP_INACTIVE' });

    const { token, jti } = this.licenses.signLicense({
      sub: user.id,
      plan: membership.plan,
      tier: membership.tier,
      deviceLimit: membership.deviceLimit,
      deviceHash,
      expiresAt: membership.endsAt,
    });

    const device = await this.prisma
      .$transaction(
        async (tx) => {
          const active = await tx.device.findMany({ where: { userId: user.id, revokedAt: null } });
          const existing = active.find((d) => d.deviceHash === deviceHash);
          if (!existing && active.length >= claims.device_limit) {
            throw new DeviceLimitSignal();
          }
          const row = existing
            ? await tx.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } })
            : await tx.device.create({
                data: { userId: user.id, deviceHash, activatedAt: new Date(), lastSeenAt: new Date() },
              });
          await this.audit.write(tx, user.id, 'license.activate', { deviceId: row.id, jti });
          return row;
        },
        // 超限判定与写入同事务串行化：并发竞争输方收到 P2034 → 同判 409
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch(async (e: unknown) => {
        if (e instanceof DeviceLimitSignal || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034')) {
          // 阻断审计不能与 409 同事务（throw 即回滚）：单独事务落库后抛 409
          await this.prisma.$transaction((tx) =>
            this.audit.write(tx, user.id, 'license.blocked', { deviceHash, deviceLimit: claims.device_limit }),
          );
          throw new ConflictException({ error: 'DEVICE_LIMIT_REACHED' });
        }
        throw e;
      });

    return {
      licenseJwt: token,
      jti,
      device: {
        deviceHash: device.deviceHash,
        activatedAt: device.activatedAt.toISOString(),
        lastSeenAt: device.lastSeenAt.toISOString(),
      },
      membership: {
        plan: membership.plan,
        tier: membership.tier,
        deviceLimit: membership.deviceLimit,
        endsAt: membership.endsAt.toISOString(),
      },
    };
  }

  /**
   * 解绑：30 天限 1 次（FR-1.5 配套语义）。以 max(revokedAt) 判定冷却窗口；
   * 冷却期内请求 403 UNBIND_COOLDOWN（附 retryAfterDays）并留审计 device.unbind.blocked。
   */
  async unbind(email: string, deviceHash: string): Promise<UnbindResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND' });

    const device = await this.prisma.device.findUnique({
      where: { userId_deviceHash: { userId: user.id, deviceHash } },
    });
    if (!device) throw new NotFoundException({ error: 'DEVICE_NOT_FOUND' });
    if (device.revokedAt) throw new ConflictException({ error: 'DEVICE_ALREADY_UNBOUND' });

    const now = Date.now();
    const history = await this.prisma.device.findMany({
      where: { userId: user.id, revokedAt: { not: null } },
      orderBy: { revokedAt: 'desc' },
      take: 1,
    });
    const lastUnbindAt = history[0]?.revokedAt?.getTime() ?? null;
    if (lastUnbindAt !== null) {
      const elapsedDays = (now - lastUnbindAt) / DAY_MS;
      if (elapsedDays < this.cooldownDays) {
        const retryAfterDays = Math.ceil(this.cooldownDays - elapsedDays);
        await this.prisma.$transaction(async (tx) =>
          this.audit.write(tx, user.id, 'device.unbind.blocked', { deviceId: device.id, retryAfterDays }),
        );
        throw new ForbiddenException({ error: 'UNBIND_COOLDOWN', retryAfterDays });
      }
    }

    const unboundAt = await this.prisma.$transaction(async (tx) => {
      const row = await tx.device.update({ where: { id: device.id }, data: { revokedAt: new Date(now) } });
      await this.audit.write(tx, user.id, 'device.unbind', { deviceId: row.id });
      return row.revokedAt as Date;
    });
    return {
      ok: true,
      deviceHash: device.deviceHash,
      unboundAt: unboundAt.toISOString(),
      nextUnbindAllowedAt: new Date(unboundAt.getTime() + this.cooldownDays * DAY_MS).toISOString(),
    };
  }

  /** 激活断言所需的 claims 透出（测试/上层复用同一验签入口） */
  inspectClaims(licenseJwt: string): LicenseClaims {
    return this.licenses.verifyLicense(licenseJwt);
  }
}
