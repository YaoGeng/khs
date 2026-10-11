// Prisma 7 CLI 配置：datasource url 从 schema 移到此处（schema 内不再允许 url 属性）。
// 运行时连接不经过此文件 —— PrismaClient 经 @prisma/adapter-pg 注入连接串（见 src/infrastructure/prisma.service.ts）。
// 默认值与根 docker-compose.yml 对齐；QA 用 embedded-postgres 时由 DATABASE_URL 覆盖（端口 55432）。
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app',
  },
});
