import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Prisma 7 运行时连接：query compiler + driver adapter（@prisma/adapter-pg）。
 * 连接串来自 AppConfig.DATABASE_URL（env 边界已解析）。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg(config.DATABASE_URL) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
