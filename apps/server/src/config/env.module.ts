import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, parseEnv } from './env.js';

/** 全局配置模块：唯一提供 APP_CONFIG 的地方（zod 解析后的只读快照）。 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => parseEnv() }],
  exports: [APP_CONFIG],
})
export class EnvModule {}
