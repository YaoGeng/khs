import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CardsModule } from './cards/cards.module.js';
import { EnvModule } from './config/env.module.js';
import { LicenseModule } from './license/license.module.js';
import { PrismaModule } from './infrastructure/prisma.module.js';
import { RedisModule } from './infrastructure/redis.module.js';
import { MembershipModule } from './membership/membership.module.js';
import { SecurityModule } from './security/security.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';

/**
 * M0 服务端模块化单体（02 §12.1：NestJS + PostgreSQL + Redis，仅账户与授权模块）。
 * 基础设施模块全部 @Global；auth/cards/license 为特性模块。订单/配置等模块属 M1+/M5，不在此预建。
 * M1 解禁：telemetry 模块自 T-M1-07 起接入（02:734 /api/v1/telemetry/events + R1 告警）。
 */
@Module({
  imports: [
    EnvModule,
    PrismaModule,
    RedisModule,
    SecurityModule,
    AuditModule,
    MembershipModule,
    AuthModule,
    CardsModule,
    LicenseModule,
    TelemetryModule,
  ],
})
export class AppModule {}
