# apps/server — NestJS 授权/会员服务端

## OVERVIEW

NestJS(Express) + Prisma(@prisma/adapter-pg) + ioredis：注册登录、卡密兑换、会员、设备激活（License）、桌面遥测接收。桌面端的商业侧后端。

## STRUCTURE

```
src/
├── main.ts / app.module.ts  # 入口与模块装配
├── auth/         # JWT 登录、验证码
├── cards/        # 卡密兑换（配套根 scripts/gen-card.mjs）
├── license/      # 设备激活；Ed25519 密钥对由 scripts/license-keys.mjs 生成，公钥烧进桌面端
├── membership/   # 会员
├── telemetry/    # 桌面遥测接收（R1 自检告警等，对应 desktop compliance/telemetry-reporter）
├── audit/ security/ common/ config/ infrastructure/
└── generated/    # Prisma 生成物（gitignore，重建勿手改）
test/             # e2e：embedded-postgres@55432 + mock redis，serial
prisma/           # schema 与迁移
scripts/          # license-keys.mjs、gate1-demo.mjs（全链路验收演示）
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| 新 API | 对应模块目录的 module/controller/service；数据结构改 prisma/schema.prisma | 先 generate 再编译 |
| 授权/激活 | license/ + scripts/license-keys.mjs | 桌面端对应 apps/desktop/src/license/ |
| 卡密 | cards/ + 根 scripts/gen-card.mjs | SQL 产出到 gitignore 的 scripts/out/ |
| 遥测事件 | telemetry/ | 与桌面端上报字段一一对应 |

## CONVENTIONS

- build/test 脚本已内置 `prisma generate`，删除它会挂编译。
- `src/*.test.ts` 必须无 DB 依赖（属根 vitest 冒烟集）；需要 PG 的测试放 `test/`（global-setup 起 embedded-postgres 55432，先杀残留监听）。
- vitest 串行（fileParallelism:false）、60s 超时、experimentalDecorators 经 tsconfigRaw 注入（esbuild 不产 decorator metadata）。
- 全链路验收：`node scripts/gate1-demo.mjs`（embedded PG + mock redis + 真实 HTTP：注册→兑卡→登录→激活→二设备 409→离线验签，exit 0 = 通过）。

## ANTI-PATTERNS

- 手改 src/generated/（重建：`pnpm --filter @xinglian/server generate`）。
- 把 DB 依赖测试放进 src/*.test.ts（会打爆根冒烟集）。

## COMMANDS

```bash
pnpm --filter @xinglian/server generate   # prisma client
pnpm --filter @xinglian/server build      # prisma generate + tsc
pnpm --filter @xinglian/server test       # embedded PG，无需 Docker
pnpm --filter @xinglian/server db:push    # 需先 docker compose up -d（仓库根）
node scripts/gate1-demo.mjs               # Gate1 全链路验收演示
```
