import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55432/app',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'm0-test-secret-0123456789abcdef',
} as const;

describe('parseEnv（F2/Q1：生产态密钥 fail-fast）', () => {
  it('test/dev 态允许开发默认密钥（不阻塞本地与测试）', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: undefined })).not.toThrow();
  });

  it('production 态缺 JWT_SECRET 拒绝启动', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
  });

  it('production 态使用开发默认值拒绝启动（已知密钥 = HS256 可伪造）', () => {
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'm0-dev-secret-change-me-please' }),
    ).toThrow(/JWT_SECRET/);
  });

  it('production 态密钥过短（<32 字符）拒绝启动', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'short-secret-16chars-ok' })).toThrow(/JWT_SECRET/);
  });

  it('production 态显式 ≥32 字符随机密钥放行', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: '9f2c7a41d8b3e605a1f4c8d27e6b903a5c8f1726d4b9e3058a6c4f2d1e7b3950',
      }),
    ).not.toThrow();
  });
});
