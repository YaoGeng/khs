// 环境变量边界：process.env 只在这里被 zod 解析一次，之后全仓拿到只读的 AppConfig。
// 测试驱动（ioredis-mock / ioredis）切换也由此处的 XINGLIAN_REDIS_DRIVER 决定。
import { z } from 'zod';

export const APP_CONFIG = 'APP_CONFIG';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@127.0.0.1:5432/app'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  JWT_SECRET: z.string().min(16).default('m0-dev-secret-change-me-please'),
  XINGLIAN_REDIS_DRIVER: z
    .enum(['ioredis', 'mock'])
    .default(() => (process.env.NODE_ENV === 'test' ? 'mock' : 'ioredis')),
  XINGLIAN_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  XINGLIAN_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  // FR-1.2 / 02 §13：验证码 5 分钟有效
  XINGLIAN_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // FR-1.2：连续失败 5 次锁 15 分钟
  XINGLIAN_LOCK_THRESHOLD: z.coerce.number().int().positive().default(5),
  XINGLIAN_LOCK_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  // todo 8（T-M0-07）：Ed25519 license 密钥路径（相对 apps/server 根解析；测试密钥对见 scripts/license-keys.mjs）
  XINGLIAN_LICENSE_PRIVATE_KEY_PATH: z.string().min(1).default('keys/license-private.pem'),
  XINGLIAN_LICENSE_PUBLIC_KEY_PATH: z.string().min(1).default('keys/license-public.pem'),
  // FR-1.5 配套语义：自助解绑每 30 天限 1 次
  XINGLIAN_UNBIND_COOLDOWN_DAYS: z.coerce.number().int().positive().default(30),
});

// 生产态禁用开发默认密钥：Q1（F2）——已知默认值 = HS256 access/refresh 可伪造，故生产必须显式注入 ≥32 字符随机密钥。
const DEV_JWT_SECRET = 'm0-dev-secret-change-me-please';
const envSchemaGuarded = envSchema.superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV === 'production' && (!cfg.JWT_SECRET || cfg.JWT_SECRET === DEV_JWT_SECRET || cfg.JWT_SECRET.length < 32)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'production 环境必须显式注入 ≥32 字符且非开发默认值的 JWT_SECRET',
    });
  }
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

/** 启动边界：解析失败即拒绝启动（fail-fast），不允许半解析配置进入业务层。 */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchemaGuarded.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid env: ${detail}`);
  }
  return Object.freeze(parsed.data);
}
