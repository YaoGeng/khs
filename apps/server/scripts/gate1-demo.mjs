#!/usr/bin/env node
// F3 门禁① 真机演示脚本（可重复演示载体；非产品代码，不加任何业务逻辑）。
//
// 对照 .omo/plans/mvp0-dev-plan.md F3 ①（05:72 门禁 1，todo 2/8）：
//   起 dist 产物真服务（node dist/main.js + embedded-postgres@55432 + mock Redis，
//   env 约定同 apps/server/test/global-setup.ts）→ 真实 HTTP（127.0.0.1:PORT，非 supertest）
//   逐步执行：注册 → gen-card 生成激活码并入库 → 兑换（签发 license）→ 登录（SVG 算术码人解）→
//   解码全部 JWT claims → 激活设备① → 第 2 台 409 阻断（个人版）→ Ed25519 公钥离线复验。
//
// 运行：node apps/server/scripts/gate1-demo.mjs   （工作目录任意；exit 0 = 全部断言通过）
//   可选 env：GATE1_PORT（默认 3921）、GATE1_EMAIL、GATE1_KEEP（=1 保留现场）
/* global process, console */
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* global Buffer, fetch, setTimeout */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const PORT = Number(process.env.GATE1_PORT ?? 3921);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const EMAIL = process.env.GATE1_EMAIL ?? `gate1-demo-${Date.now()}@example.com`;
const PASSWORD = 'Passw0rd123';
const PG_PORT = 55432;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/app`;
const DATA_DIR = path.join(serverRoot, 'node_modules', '.demo-pgdata');
const JWT_SECRET = 'm0-gate1-demo-secret-0123456789abcdef';

/* ------------------------------ 断言与输出 ------------------------------ */

const results = [];
let stepNo = 0;
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const b64urlJson = (seg) => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));

function step(name, fn) {
  stepNo += 1;
  const label = `[STEP ${stepNo}] ${name}`;
  return fn()
    .then((detail) => {
      results.push({ name, ok: true, detail });
      console.log(`${label}: PASS ✅${detail ? ` — ${detail}` : ''}`);
    })
    .catch((error) => {
      results.push({ name, ok: false, detail: error?.detail ?? String(error) });
      console.error(`${label}: FAIL ❌ — ${error?.detail ?? (error?.stack ?? String(error))}`);
      throw error;
    });
}

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应按 null 处理 */ }
  return { res, json };
}

function expect(cond, detail) {
  if (!cond) {
    const e = new Error(`assert`);
    e.detail = detail;
    throw e;
  }
}

/* ------------------------------ 基础设施 ------------------------------ */

function killStalePgListeners() {
  try {
    const netstat = execSync('netstat -ano | findstr :55432', { shell: 'cmd.exe' }).toString();
    const pids = [...new Set(netstat.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p ?? '')))];
    for (const pid of pids) if (pid && pid !== '0') execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe', stdio: 'ignore' });
    if (pids.length > 0) console.log(`[pg-setup] killed stale listener(s) on ${PG_PORT}: ${pids.join(',')}`);
  } catch { /* 端口空闲 */ }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  if (!existsSync(path.join(serverRoot, 'dist', 'main.js'))) {
    console.error('前置缺失：apps/server/dist/main.js 不存在（先 pnpm --filter @xinglian/server build）');
    process.exit(1);
  }

  console.log('==============================================================');
  console.log('F3 门禁① 真机演示（真实 HTTP 服务 = node dist/main.js + 真 PG）');
  console.log(`server: ${BASE}   pg: ${PG_PORT}/app   driver: ioredis-mock`);
  console.log('==============================================================');

  /* STEP 0：起基础设施 */
  killStalePgListeners();
  rmSync(DATA_DIR, { recursive: true, force: true });
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  console.log('[pg-setup] embedded-postgres (persistent:false) 初始化中…');
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    onError: (m) => console.error('[pg]', m),
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('app');
  console.log('[pg-setup] started');
  const push = spawnSync('pnpm', ['exec', 'prisma', 'db', 'push'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
    shell: true,
  });
  expect(push.status === 0 && /in sync with your Prisma schema|already in sync/.test(`${push.stdout}${push.stderr}`),
    `prisma db push 失败：${(push.stderr || push.stdout || '').slice(0, 400)}`);
  console.log('[pg-setup] schema pushed');

  /* 起 dist 服务（真实进程、真实 HTTP） */
  const serverEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    DATABASE_URL,
    XINGLIAN_REDIS_DRIVER: 'mock',
    JWT_SECRET,
  };
  const server = spawn(process.execPath, ['dist/main.js'], { cwd: serverRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.on('data', (c) => { serverOut += String(c); });
  server.stderr.on('data', (c) => { serverOut += String(c); });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    if (/server listening on/.test(serverOut)) { ready = true; break; }
    await wait(200);
  }
  expect(ready, `dist 服务未在 20s 内就绪；输出片段：${serverOut.slice(0, 600)}`);
  const routeLine = serverOut.split(/\r?\n/).filter((l) => /:POST|:GET/.test(l)).slice(0, 12).join(' | ');
  console.log(`[server] listening（路由映射片段）：\n  ${routeLine.replace(/\|/g, '\n  ')}`);

  let state = {};
  try {
    /* STEP 1：注册（邮箱验证码 dev 传输 + 密码 BCrypt） */
    await step('注册 email-code → register（1.x）', async () => {
      const codeRes = await post('/auth/email-code', { email: EMAIL });
      expect(codeRes.res.status === 200 && /^\d{6}$/.test(codeRes.json?.code ?? ''), `email-code: HTTP ${codeRes.res.status} body=${JSON.stringify(codeRes.json).slice(0, 200)}`);
      const regRes = await post('/auth/register', { email: EMAIL, password: PASSWORD, code: codeRes.json.code });
      expect(regRes.res.status === 201 && typeof regRes.json?.userId === 'string', `register: HTTP ${regRes.res.status} body=${JSON.stringify(regRes.json).slice(0, 200)}`);
      state = { ...state, ...regRes.json };
      return `HTTP ${codeRes.res.status} → HTTP ${regRes.res.status}；userId=${regRes.json.userId} email=${EMAIL} 验证码经 dev 传输直读（发信与密码哈希服务端完成）`;
    });

    /* STEP 2：gen-card 生成激活码（明文一次性可见）→ SQL 入库 */
    let code, sqlPath;
    await step('gen-card（scripts/gen-card.mjs，明文码仅本次输出可见）→ db execute 入库', async () => {
      const gen = spawnSync('node', ['scripts/gen-card.mjs', '--count', '1', '--plan', 'month', '--tier', 'personal'],
        { cwd: repoRoot, encoding: 'utf8' });
      expect(gen.status === 0, `gen-card exit=${gen.status}: ${(gen.stderr || gen.stdout || '').slice(0, 300)}`);
      const lines = gen.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      code = lines.find((l) => /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(l));
      const arrow = lines.find((l) => l.startsWith(`${code}  ->`)) ?? lines.find((l) => l.includes('  ->  ') && l.startsWith(code));
      expect(Boolean(code && arrow), `gen-card 输出解析失败：${gen.stdout.slice(0, 400)}`);
      const sqlLine = lines.find((l) => l.includes('SQL 文件已写出'));
      sqlPath = sqlLine.split('：')[1]?.trim();
      expect(Boolean(sqlPath) && existsSync(path.resolve(repoRoot, sqlPath)), `SQL 文件未生成：${sqlLine ?? '(无)'}`);
      const impl = spawnSync('pnpm', ['--filter', '@xinglian/server', 'exec', 'prisma', 'db', 'execute', '--file', path.resolve(repoRoot, sqlPath)],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL }, shell: true });
      expect(impl.status === 0 && /success/i.test(`${impl.stdout}${impl.stderr}`),
        `db execute exit=${impl.status}: ${((impl.stderr || impl.stdout) + '').slice(0, 300)}`);
      state = { ...state, code, codeHash: arrow.split('->')[1].trim(), sqlPath: path.resolve(repoRoot, sqlPath) };
      return `明文码 ${code}（sha256 入库 ${state.codeHash.slice(0, 12)}…）；SQL ${sqlPath} 已执行（Script executed successfully）`;
    });

    /* STEP 3：兑换 → 会员入账 + 授权 JWT + 签发 license（device_hash='' 未绑定态） */
    await step('POST /cards/redeem（兑换）→ membership + authorizationJwt + licenseJwt', async () => {
      const { res, json } = await post('/cards/redeem', { code, email: EMAIL });
      expect(res.status === 200, `HTTP ${res.status} body=${JSON.stringify(json).slice(0, 300)}`);
      const m = json.membership ?? {};
      expect(m.plan === 'month' && m.tier === 'personal' && m.deviceLimit === 1, `membership 语义不符：${JSON.stringify(m)}`);
      const authClaims = b64urlJson(json.authorizationJwt.split('.')[1]);
      expect(authClaims.typ === 'authorization' && authClaims.sub === state.userId && authClaims.device_limit === 1,
        `authorizationJwt claims 异常：${JSON.stringify(authClaims)}`);
      const licHeader = b64urlJson(json.licenseJwt.split('.')[0]);
      const licClaims = b64urlJson(json.licenseJwt.split('.')[1]);
      expect(licHeader.alg === 'EdDSA' && licHeader.typ === 'license', `license header 异常：${JSON.stringify(licHeader)}`);
      expect(licClaims.sub === state.userId && licClaims.plan === 'month' && licClaims.tier === 'personal'
        && licClaims.device_limit === 1 && licClaims.device_hash === '' && typeof licClaims.jti === 'string',
        `license claims 异常：${JSON.stringify(licClaims)}`);
      state = { ...state, membership: json.membership, authorizationJwt: json.authorizationJwt, licenseJwt: json.licenseJwt, licenseClaims: licClaims };
      return `HTTP 200；membership={plan:${m.plan}, tier:${m.tier}, deviceLimit:${m.deviceLimit}}；license claims={sub:${licClaims.sub.slice(0, 8)}…, plan:month, tier:personal, device_limit:1, device_hash:'', jti:${licClaims.jti.slice(0, 8)}…, typ:license, alg:EdDSA}`;
    });

    /* STEP 4：登录（SVG 算术图形验证码——演示脚本按"人眼读码"口径解析 SVG 文本算式） */
    await step('POST /auth/captcha → SVG 算式解析 → POST /auth/login → accessToken', async () => {
      const cap = await post('/auth/captcha', {});
      expect(cap.res.status === 200 && cap.json?.captchaId, `captcha: HTTP ${cap.res.status}`);
      const chars = [...cap.json.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('');
      const mq = chars.match(/^(\d+)\s*([+])\s*(\d+)\s*=\s*\?$/);
      expect(Boolean(mq), `SVG 算式解析失败：${chars}`);
      const answer = mq[2] === '+' ? Number(mq[1]) + Number(mq[3]) : Number(mq[1]) - Number(mq[3]);
      const login = await post('/auth/login', { email: EMAIL, password: PASSWORD, captchaId: cap.json.captchaId, captchaAnswer: String(answer) });
      expect(login.res.status === 200 && typeof login.json?.accessToken === 'string', `login: HTTP ${login.res.status} body=${JSON.stringify(login.json).slice(0, 300)}`);
      const header = b64urlJson(login.json.accessToken.split('.')[0]);
      const claims = b64urlJson(login.json.accessToken.split('.')[1]);
      expect(header.alg === 'HS256' && claims.typ === 'access' && claims.sub === state.userId,
        `accessToken header/claims 异常：${JSON.stringify({ header, claims })}`);
      state = { ...state, accessToken: login.json.accessToken, accessClaims: claims };
      return `图形验证码「${chars}」→ 答 ${answer}；HTTP 200；access claims={sub:${claims.sub.slice(0, 8)}…, typ:'access'}（未兑换用户才会缺 plan/tier/device_limit——本链在兑换后登录）`;
    });

    /* STEP 5：解码 license JWT claims 逐项展示（门禁①「解码 JWT claims」口径） */
    await step('解码 JWT claims（accessToken + license 绑定链全集）', async () => {
      const exactly = {
        accessToken: {
          alg: b64urlJson(state.accessToken.split('.')[0]).alg,
          sub: state.accessClaims.sub,
          typ: state.accessClaims.typ,
        },
        licenseJwt: {
          alg: state.licenseClaims ? b64urlJson(state.licenseJwt.split('.')[0]).alg : null,
          typ: state.licenseClaims?.typ,
          kid: state.licenseClaims ? b64urlJson(state.licenseJwt.split('.')[0]).kid : null,
          sub: state.licenseClaims?.sub,
          plan: state.licenseClaims?.plan,
          tier: state.licenseClaims?.tier,
          device_limit: state.licenseClaims?.device_limit,
          device_hash: state.licenseClaims?.device_hash,
          jti: state.licenseClaims?.jti,
          exp: state.licenseClaims?.exp,
        },
      };
      expect(exactly.licenseJwt.typ === 'license' && exactly.licenseJwt.device_limit === 1
        && exactly.accessToken.typ === 'access' && exactly.accessToken.sub === exactly.licenseJwt.sub,
        `claims 交叉断言失败：${JSON.stringify(exactly)}`);
      return JSON.stringify(exactly);
    });

    /* STEP 6：激活设备① → 换发绑定版 license → 公钥离线复验 Ed25519 */
    await step('POST /license/activate 设备①（绑定换发）→ 公钥离线复验 Ed25519 签名', async () => {
      const hashA = sha256Hex('gate1-demo-device-A');
      const act = await post('/license/activate', { email: EMAIL, licenseJwt: state.licenseJwt, device_hash: hashA });
      expect(act.res.status === 200 && typeof act.json?.licenseJwt === 'string', `activate: HTTP ${act.res.status} body=${JSON.stringify(act.json).slice(0, 300)}`);
      const boundClaims = b64urlJson(act.json.licenseJwt.split('.')[1]);
      expect(boundClaims.device_hash === hashA && boundClaims.jti !== state.licenseClaims.jti,
        `绑定版 license 异常：${JSON.stringify(boundClaims)}`);
      const [h, p, s] = act.json.licenseJwt.split('.');
      const pub = createPublicKey(readFileSync(path.join(serverRoot, 'keys', 'license-public.pem'), 'utf8'));
      const ok = edVerify(null, Buffer.from(`${h}.${p}`, 'utf8'), pub, Buffer.from(s, 'base64url'));
      expect(ok, '公钥离线验签失败（desktop 离线验签姿态不应失败）');
      state = { ...state, hashA, boundClaims };
      return `HTTP 200；device_hash=${hashA.slice(0, 12)}…、jti 换新（${boundClaims.jti.slice(0, 8)}…）；公钥离线验签=TRUE`;
    });

    /* STEP 7：个人版第 2 台 → 409 DEVICE_LIMIT_REACHED（FR-1.4 / 门禁①口径） */
    await step('第 2 台设备激活 → 409 DEVICE_LIMIT_REACHED（第 2 台阻断）', async () => {
      const hashB = sha256Hex('gate1-demo-device-B');
      const res2 = await post('/license/activate', { email: EMAIL, licenseJwt: state.licenseJwt, device_hash: hashB });
      expect(res2.res.status === 409 && res2.json?.error === 'DEVICE_LIMIT_REACHED',
        `第 2 台未按口径阻断：HTTP ${res2.res.status} body=${JSON.stringify(res2.json).slice(0, 200)}`);
      return `HTTP 409 DEVICE_LIMIT_REACHED（个人版 device_limit=1；同链 e2e 另断言 audit license.blocked 落库与活动设备数=1）`;
    });

    /* STEP 8（对照注释）：重复兑换同码 → 409（D9 防重放真服务态复证） */
    await step('同码二次兑换（真 HTTP 服务）→ 409 CARD_ALREADY_REDEEMED', async () => {
      const replay = await post('/cards/redeem', { code, email: EMAIL });
      expect(replay.res.status === 409 && replay.json?.error === 'CARD_ALREADY_REDEEMED',
        `重放未按口径拒绝：HTTP ${replay.res.status} body=${JSON.stringify(replay.json).slice(0, 200)}`);
      return 'HTTP 409 CARD_ALREADY_REDEEMED（事务内 status 条件更新防重放在真服务态生效）';
    });
  } finally {
    console.log('==============================================================');
    const pass = results.filter((r) => r.ok).length;
    console.log(`GATE1-DEMO SUMMARY: ${pass}/${results.length} 断言组通过`);
    for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'} — ${r.name}`);
    console.log('==============================================================');
    try {
      if (server.pid) execSync(`taskkill /PID ${server.pid} /T /F`, { shell: 'cmd.exe', stdio: 'ignore' });
    } catch { /* 进程可能已退出 */ }
    if (process.env.GATE1_KEEP !== '1') {
      try { await pg.stop(); rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
  }

  if (results.some((r) => !r.ok)) process.exit(1);
  console.log('GATE1-DEMO OK（exit 0）');
  process.exit(0);
}

main().catch((error) => {
  console.error('GATE1-DEMO FAILED:', error?.stack ?? String(error));
  process.exit(1);
});
