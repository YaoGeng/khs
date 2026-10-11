# ADR 注记：M0 dev 传输与实现取舍（todo 2 = T-M0-03 + D9 扩展）

状态：M0 骨架期注记（随 T-PRE-04 三方追认 D9 与验证码投递收窄；正式 ADR 归对应里程碑）。
日期：2026-10-11。范围：apps/server M0 骨架 + 最小激活码兑换。

## 1. 验证码投递走 dev 传输（生产 SMTP 属 M5）

- **决策**：`POST /api/v1/auth/email-code` 在 M0 直接把 6 位验证码随响应体返回，并以 `[dev-transport]` 前缀写入日志；QA 也可直读 Redis 键 `m0:emailcode:{email}`（TTL 300s，02 §13「验证码 5 分钟有效」）。
- **依据**：计划 todo 2 指定「M0 投递走 dev 传输——QA 直读 Redis/非生产环境随响应返回，生产 SMTP 随 T-M5 落地并记 ADR 注记」。
- **TODO(M5)**：`src/auth/auth.service.ts sendEmailCode` 内已留 TODO；M5 接入真实 SMTP 后必须移除「响应体返回 code」分支（env 区分 dev/prod 传输）。
- 图形验证码（登录）同为 dev 姿态：SVG 算术码答案仅存 Redis（`m0:captcha:{id}`，TTL 300s，一次性消费）；QA 直读 Redis 取答案。

## 2. D9 最小兑换（用户 2026-10-10 批准，T-PRE-04 追认）

- **路径**：`POST /api/v1/cards/redeem`（02 §13 把兑换归 `/api/v1/orders` 全量；D9 在 M0 先行最小闭环，全量归 T-M5-02）。
- **绑定语义**：M0 兑换入参 `{code, email}`——激活码本身即凭据，绑定到已注册邮箱；这使 05:72 门禁① 顺序「注册→兑换→登录」可行（兑换无需会话）。
- **已知限制（接受）**：持有效未兑换码者可指定任意已注册邮箱入账（赠错/误绑风险）。M0 门禁演示面可接受；T-M5-02 全量兑换改为会话内兑换并加防爆破。
- **防重放**：事务内条件更新 `UPDATE activation_cards SET status='redeemed' WHERE id=? AND status='unused'`（Prisma `updateMany` + 返回计数判定）；并发冲突下 P2004/P2028 与 count=0 同判 409 `CARD_ALREADY_REDEEMED`。测试含 4 路并发兑换恰好一次成功的断言。
- **JWT**：兑换响应含 HS256 授权 JWT，claims `{sub, plan, tier, device_limit}`（02 §12.3 子集）；完整 Ed25519 license 链（exp/device_hash/jti/吊销）归 todo 8（T-M0-07）。

## 3. Prisma 7 + 驱动适配器

- **事实**：Prisma 7.10 移除了 Rust query engine，`datasource url` 属性不再允许；运行时连接必须经 driver adapter 注入 `PrismaClient`。schema 内不再写连接 URL，改由 `prisma.config.ts`（CLI：db push / db execute）+ `PrismaPg` adapter（运行时）提供。
- **安装方式偏离**：`@prisma/adapter-pg` 未在预装清单内，经 `npm pack` + 手工/自动落库后由 pnpm 解析并同步进 pnpm-lock.yaml（无 `pnpm add` 手工调用；registry.npmjs.org 可达）。后续 `pnpm install` 幂等。
- **prisma.config.ts**：`schema` 指向 `prisma/schema.prisma`；`datasource.url` 读 `DATABASE_URL`（默认 `postgresql://postgres:postgres@127.0.0.1:5432/app`，与根 docker-compose.yml 一致）。

## 4. Schema 管理：db push（不建 migrations 目录）

- **决策**：M0 骨架期用 `prisma db push`，不建 migration 目录。
- **依据**：任务卡明示「M0 骨架用 db push 足够，记录该决定」。表名/列名对齐 02 §14.2（users / memberships / activation_cards / audit_logs，snake_case 列）。
- **TODO(M5 前)**：进入 T-M5-02（卡批次全量）前建立 migrations 基线（`prisma migrate diff` 生成初始迁移）。

## 5. Redis：生产 ioredis / 测试 ioredis-mock（模块注入切换）

- `XINGLIAN_REDIS_DRIVER=mock|ioredis`（env 边界解析；`NODE_ENV=test` 默认 mock）。业务层只依赖 `RedisService` 的语义子集（get/setWithTtl/incrWithTtl/del/ttl），驱动切换对业务透明。
- 键名契约集中在 `src/auth/redis-keys.ts`（业务与测试单一事实来源）。

## 6. QA 数据面：embedded-postgres 替代 docker

- 本机无 docker 且 GitHub 不可达；`apps/server/test/global-setup.ts` 用 embedded-postgres@18.4（PG 16 二进制）起真实 PG：端口 55432、`persistent:false`（每次运行重建），随后 `prisma db push` 建表。
- 交付文件 `docker-compose.yml`（pg16 + redis7 + 健康检查 + 卷）按 02 §15.3 产出，供有 docker 环境者使用。

## 7. ESM / CJS 与 NestJS 装饰器

- 保持 `"type": "module"`（todo 1 既定）；tsc(NodeNext) 产物为 ESM，全部相对 import 带 `.js` 扩展。
- vitest 经 esbuild 转译，**esbuild 不支持 decorator metadata**：因此所有 Nest 注入点一律显式 `@Inject(TOKEN)`，两条编译路径（tsc 产物 / vitest 转译）都成立。`tsconfig.json` 仍开 `experimentalDecorators + emitDecoratorMetadata`（tsc 产物可继续吃隐式注入），vitest 侧由 `tsconfigRaw` 兜底。
- bcryptjs@3 为纯 JS 实现（含自身类型），替代原生 bcrypt 编译链；02 §3.1 强制栈为「Bcrypt 哈希」，算法一致，实现选型记录于此。

## 8. 刷新令牌：旋转但不做重用检测

- `POST /api/v1/auth/refresh` 验签后签发新 access+refresh（jti 随机）。02 §13 的「旋转 + 重用检测」中，重用检测需服务端 jti 存储体系（M5 配置中心/吊销名单同期落地），M0 仅旋转并记录于此。

## 9. 激活码脚本与 hash 契约

- `scripts/gen-card.mjs`（根目录）：生成 Crockford base32 明文码（仅 stdout 可见）+ sha256 codeHash + SQL 文件（`scripts/out/cards-<ts>.sql`，幂等 INSERT）。
- **选择**：SQL 文件方式入库（`prisma db execute --file`），根目录工具不直连 PG（根无 pg 依赖、不动根 package.json）。
- hash 契约 `sha256(明文码, utf8) hex`：脚本与 `apps/server` 的 `hashCardCode` 独立实现；T-M5-02 收敛到 packages/protocol。

## 10. 登录锁定语义

- 连续失败计数滚动 15 分钟窗口（每次失败重置 TTL）；第 5 次失败设 `m0:login:lock:{email}`（TTL 15 分钟）并清计数；被锁期间请求返回 423 `LOGIN_LOCKED` + `retryAfterSeconds`。图形验证码错误不计入失败次数（M0 简化，防爆破全量归 T-M5-02）。
