import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';

/** 02 §13：全局前缀 /api/v1。 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.PORT);
  new Logger('bootstrap').log(`server listening on http://127.0.0.1:${config.PORT}/api/v1`);
}

// 顶层边界：启动失败即退出进程（唯一允许的 catch-all 位置）。
void bootstrap().catch((e: unknown) => {
  console.error('bootstrap failed:', e);
  process.exit(1);
});
