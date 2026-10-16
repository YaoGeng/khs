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
  // 防僵尸：被强杀的测试运行可能留下占用 55432 的旧 PG（Windows 文件锁导致其数据目录清不掉），
  // 新实例起不来时会静默连上旧库 → 旧数据触发唯一约束冲突。启动前清理端口占用者。
  try {
    const netstat = execSync('netstat -ano | findstr :55432', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(netstat.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p ?? '')))];
    for (const pid of pids) {
      if (pid && pid !== '0') execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe', stdio: 'ignore' });
    }
    if (pids.length > 0) console.warn(`[pg-setup] killed stale listener(s) on ${PORT}: ${pids.join(',')}`);
  } catch {
    // 端口空闲（findstr 无匹配退出码非 0）
  }
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
    try {
      await pg.stop();
    } catch (error) {
      // persistent:false 在 stop() 内部删数据目录；Windows 下 postgres 句柄异步释放
      // 偶发 EBUSY（进程已停、纯目录清理竞态）——不该让拆库竞态红掉整套测试。
      // 非 EBUSY 的真实停库失败照抛。
      const msg = String(error);
      if (!msg.includes('EBUSY') && !msg.includes('resource busy')) throw error;
      console.warn('[pg-teardown] stop() 目录清理 EBUSY（进程已停），转入重试清理');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(DATA_DIR, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    console.warn(`[pg-teardown] 数据目录残留（下次运行启动期自清）：${DATA_DIR}`);
  };
}
