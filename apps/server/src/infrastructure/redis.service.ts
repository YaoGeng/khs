import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

/**
 * Redis 封装：生产路径 ioredis，测试路径 ioredis-mock。
 * 切换由 env 边界的 XINGLIAN_REDIS_DRIVER 决定（Nest 模块注入，业务层无感知）。
 * 只暴露 M0 用到的心智子集，避免业务层直接依赖完整客户端面。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client =
      config.XINGLIAN_REDIS_DRIVER === 'mock' ? new RedisMock() : new Redis(config.REDIS_URL);
  }

  /** 测试/运维逃生口（清空、直读键值）；业务代码一律走下面的语义方法。 */
  get raw(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  /** INCR + 滚动续期：每次自增都重置 TTL（「连续」失败窗口语义）。 */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    await this.client.expire(key, ttlSeconds);
    return count;
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  /** 剩余秒数；键不存在返回 <=0。 */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch (e) {
      if (e instanceof Error) this.logger.warn(`redis quit ignored: ${e.message}`);
    }
  }
}
