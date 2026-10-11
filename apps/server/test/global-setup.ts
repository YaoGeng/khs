import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * embedded-postgres 替代 docker（本机无 docker，02 §15.3 的 docker-compose 仅作为交付文件）。
 * 端口 55432 避免与本机/CI 常用 5432 冲突；Windows 下首次 initdb 约 30-60s。
 * persistent:false：stop() 即删除数据目录，测试可重复运行。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const DATA_DIR = path.join(serverRoot, 'node_modules', '.test-pgdata');
const PORT = 55432;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/app`;

export default async function globalSetup(): Promise<() => Promise<void>> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    onError: (messageOrError: string | Error | unknown) => {
      console.error('[pg]', messageOrError);
    },
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('app');

  // 先设 env 再跑 db push；env 会随进程继承传给后续 worker（测试内 AppModule 读到同一 DATABASE_URL）。
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.XINGLIAN_REDIS_DRIVER = 'mock';
  process.env.JWT_SECRET = 'm0-test-secret-0123456789abcdef';
  execSync('pnpm exec prisma db push', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: 'inherit',
  });

  return async () => {
    await pg.stop();
  };
}
