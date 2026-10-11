import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { RedisService } from '../infrastructure/redis.service.js';
import type { AppliedMembership } from '../membership/membership.service.js';
import { MembershipService } from '../membership/membership.service.js';
import { PasswordService } from '../security/password.service.js';
import { TokenService, type AccessClaims } from '../security/token.service.js';
import { CaptchaService } from './captcha.service.js';
import type { LoginRequest, RegisterRequest } from './auth.dto.js';
import { emailCodeKey, loginFailKey, loginLockKey } from './redis-keys.js';

export type RegisterResult = Readonly<{ userId: string; email: string }>;

export type LoginResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  user: Readonly<{ id: string; email: string }>;
  membership: AppliedMembership | null;
}>;

export type RefreshResult = Readonly<{ accessToken: string; refreshToken: string }>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly codeTtlSeconds: number;
  private readonly lockThreshold: number;
  private readonly lockSeconds: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
  ) {
    this.codeTtlSeconds = config.XINGLIAN_CODE_TTL_SECONDS;
    this.lockThreshold = config.XINGLIAN_LOCK_THRESHOLD;
    this.lockSeconds = config.XINGLIAN_LOCK_SECONDS;
  }

  /**
   * 发送邮箱验证码（FR-1.1）。M0 走 dev 传输：验证码随响应返回并打日志（QA 直读 Redis 亦可）。
   * TODO(M5, T-M5-02 同期): 生产改投 SMTP；决策记录见 docs/adr/notes-dev-transports.md。
   */
  async sendEmailCode(email: string): Promise<Readonly<{ code: string }>> {
    const code = String(randomInt(100000, 1000000));
    await this.redis.setWithTtl(emailCodeKey(email), code, this.codeTtlSeconds);
    this.logger.log(`[dev-transport] email code for ${email}: ${code}`);
    return { code };
  }

  async register(dto: RegisterRequest): Promise<RegisterResult> {
    const key = emailCodeKey(dto.email);
    const expected = await this.redis.get(key);
    if (expected === null || expected !== dto.code) {
      throw new BadRequestException({ error: 'EMAIL_CODE_INVALID' });
    }
    await this.redis.del(key);
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const user = await this.prisma.user.create({ data: { email: dto.email, passwordHash } });
      await this.audit.write(this.prisma, user.id, 'user.register', { email: dto.email });
      return { userId: user.id, email: user.email };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ error: 'EMAIL_TAKEN' });
      }
      throw e;
    }
  }

  /** FR-1.2：密码比对 + 图形验证码 + 连续失败 5 次锁 15 分钟（02 §11.3）。 */
  async login(dto: LoginRequest): Promise<LoginResult> {
    await this.assertNotLocked(dto.email);
    if (!(await this.captcha.verify(dto.captchaId, dto.captchaAnswer))) {
      throw new BadRequestException({ error: 'CAPTCHA_INVALID' });
    }
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const passwordOk =
      user === null ? false : await this.passwords.verify(dto.password, user.passwordHash);
    if (user === null || !passwordOk) {
      const failures = await this.recordFailure(dto.email);
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        remainingAttempts: Math.max(0, this.lockThreshold - failures),
      });
    }
    await this.redis.del(loginFailKey(dto.email));
    const membership = await this.memberships.currentFor(user.id);
    const claims: Omit<AccessClaims, 'typ'> = {
      sub: user.id,
      email: user.email,
      plan: membership?.plan,
      tier: membership?.tier,
      device_limit: membership?.deviceLimit,
    };
    return {
      accessToken: this.tokens.signAccessToken(claims),
      refreshToken: this.tokens.signRefreshToken(user.id),
      user: { id: user.id, email: user.email },
      membership,
    };
  }

  /** 刷新：旋转 refresh token（M0 不做重用检测，见 docs/adr/notes-dev-transports.md）。 */
  async refresh(refreshToken: string): Promise<RefreshResult> {
    const claims = this.tokens.verifyRefreshToken(refreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) throw new UnauthorizedException({ error: 'TOKEN_INVALID' });
    const membership = await this.memberships.currentFor(user.id);
    return {
      accessToken: this.tokens.signAccessToken({
        sub: user.id,
        email: user.email,
        plan: membership?.plan,
        tier: membership?.tier,
        device_limit: membership?.deviceLimit,
      }),
      refreshToken: this.tokens.signRefreshToken(user.id),
    };
  }

  private async assertNotLocked(email: string): Promise<void> {
    const ttl = await this.redis.ttl(loginLockKey(email));
    if (ttl > 0) {
      throw new HttpException({ error: 'LOGIN_LOCKED', retryAfterSeconds: ttl }, 423);
    }
  }

  /** 失败计数：滚动 15 分钟窗口；第 N 次（阈值）失败即上锁并清计数。 */
  private async recordFailure(email: string): Promise<number> {
    const failures = await this.redis.incrWithTtl(loginFailKey(email), this.lockSeconds);
    if (failures >= this.lockThreshold) {
      await this.redis.setWithTtl(loginLockKey(email), '1', this.lockSeconds);
      await this.redis.del(loginFailKey(email));
      this.logger.warn(`login locked for ${this.lockSeconds}s: ${email}`);
    }
    return failures;
  }
}
