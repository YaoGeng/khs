import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { Plan, Tier } from '../generated/prisma/client.js';

export type TokenKind = 'access' | 'refresh' | 'authorization';

export type AccessClaims = Readonly<{
  sub: string;
  typ: 'access';
  email?: string;
  plan?: Plan;
  tier?: Tier;
  device_limit?: number;
}>;

export type RefreshClaims = Readonly<{ sub: string; typ: 'refresh'; jti: string }>;

/** 02 §12.3：兑换签发的授权 JWT claims（sub/plan/tier/device_limit）；完整 Ed25519 license 链归 todo 8（T-M0-07）。 */
export type AuthorizationClaims = Readonly<{
  sub: string;
  typ: 'authorization';
  plan: Plan;
  tier: Tier;
  device_limit: number;
}>;

const asPlan = (value: unknown): Plan | undefined =>
  value === 'month' || value === 'quarter' || value === 'year' ? value : undefined;

const asTier = (value: unknown): Tier | undefined =>
  value === 'personal' || value === 'team' ? value : undefined;

const asPositiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

type VerifiedCore = Readonly<{ sub: string; payload: Readonly<Record<string, unknown>> }>;

@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secret = config.JWT_SECRET;
    this.accessTtl = config.XINGLIAN_ACCESS_TTL_SECONDS;
    this.refreshTtl = config.XINGLIAN_REFRESH_TTL_SECONDS;
  }

  signAccessToken(claims: Omit<AccessClaims, 'typ'>): string {
    return jwt.sign({ ...claims, typ: 'access' }, this.secret, { expiresIn: this.accessTtl });
  }

  signRefreshToken(sub: string): string {
    return jwt.sign({ sub, typ: 'refresh', jti: randomUUID() }, this.secret, {
      expiresIn: this.refreshTtl,
    });
  }

  signAuthorizationToken(claims: Omit<AuthorizationClaims, 'typ'>): string {
    return jwt.sign({ ...claims, typ: 'authorization' }, this.secret, {
      expiresIn: this.accessTtl,
    });
  }

  verifyAccessToken(token: string): AccessClaims {
    const { sub, payload } = this.verifyCore(token);
    this.expectKind(payload, 'access');
    return {
      sub,
      typ: 'access',
      email: asOptionalString(payload['email']),
      plan: asPlan(payload['plan']),
      tier: asTier(payload['tier']),
      device_limit: asPositiveInt(payload['device_limit']),
    };
  }

  verifyRefreshToken(token: string): RefreshClaims {
    const { sub, payload } = this.verifyCore(token);
    this.expectKind(payload, 'refresh');
    const jti = asOptionalString(payload['jti']);
    if (!jti) throw this.invalid();
    return { sub, typ: 'refresh', jti };
  }

  verifyAuthorizationToken(token: string): AuthorizationClaims {
    const { sub, payload } = this.verifyCore(token);
    this.expectKind(payload, 'authorization');
    const plan = asPlan(payload['plan']);
    const tier = asTier(payload['tier']);
    const deviceLimit = asPositiveInt(payload['device_limit']);
    if (!plan || !tier || deviceLimit === undefined) throw this.invalid();
    return { sub, typ: 'authorization', plan, tier, device_limit: deviceLimit };
  }

  private verifyCore(token: string): VerifiedCore {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.secret);
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException({ error: 'TOKEN_EXPIRED' });
      }
      if (e instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException({ error: 'TOKEN_INVALID' });
      }
      throw e;
    }
    if (typeof decoded === 'string') throw this.invalid();
    const sub = asOptionalString(decoded['sub']);
    if (!sub) throw this.invalid();
    return { sub, payload: decoded };
  }

  private expectKind(payload: Readonly<Record<string, unknown>>, kind: TokenKind): void {
    if (payload['typ'] !== kind) throw this.invalid();
  }

  private invalid(): UnauthorizedException {
    return new UnauthorizedException({ error: 'TOKEN_INVALID' });
  }
}
