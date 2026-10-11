# ADR 注记：M0 license 授权链路取舍（todo 8 = T-M0-07）

状态：M0 骨架期注记（正式 ADR 归 M5 授权服务强化时）。
日期：2026-10-11。范围：apps/server license/devices 链路 + apps/desktop license-manager。

## 1. Ed25519 密钥管理：提交固定测试密钥对（两案权衡）

- **决策**：`apps/server/keys/` 提交**一副固定的 M0 测试密钥对**（`license-public.pem` + `license-private.pem`，
  `scripts/license-keys.mjs` 生成，kid=`m0-license-test-1`），公钥同时以常量内置 desktop
  （`apps/desktop/src/license/public-key.ts`）。
- **另一案（未选）**：gitignore 私钥并让测试脚本自动生成临时对。未选原因：desktop e2e 需要「能在
  内置公钥下验签通过」的签名私钥；若私钥不提交，e2e 必须在 app 内开 env 换钥口子（攻击面+测试
  与生产行为分叉），或跨包生成/注入，复杂度更高。测试密钥对提交的风险是「私钥泄漏」，但它
  只签 M0 dev/test 数据，不构成生产信任锚。
- **护栏**：`LicenseSigningService` 在 `NODE_ENV=production` 且私钥文件缺失时**拒绝启动**（fail-fast），
  从机制上阻止测试密钥混入生产；dev/test 文件缺失时降级为进程内临时密钥对并告警（保证不含
  keys/ 的工作副本可跑通非 license 测试）。
- **TODO(M5 轮换策略)**：生产私钥离线保管（KMS/HSM），license JWT header 携带 kid；客户端内置
  公钥表按 kid 选钥 + 轮换期双钥并验（宽限窗口内新旧钥共存）；轮换完成销毁测试密钥对并撤销
  该 kid 下全部历史 license（吊销名单随配置下发，见 §3）。

## 2. 激活路径：M0 桌面端走本地注入 + 离线验签（联网流归 M5）

- **服务端链**（supertest e2e 已覆盖）：注册 → 生成卡 → `POST /api/v1/cards/redeem`（响应含
  `licenseJwt`，Ed25519 签名，claims `sub/plan/tier/device_limit/exp/device_hash/jti`，
  `device_hash=''` 未绑定态）→ `POST /api/v1/license/activate`（上报 `device_hash`，仅哈希，
  02 §11.4）→ 服务端验签/归属/会员/设备上限校验后绑定并**换发绑定版 license**（新 jti）→
  `POST /api/v1/devices/unbind`（30 天限 1 次）。
- **客户端链**（Playwright e2e 已覆盖）：M0 不接服务端网络栈，激活 = settings 页粘贴 license JWT →
  主进程 `license:activate`（IPC 白名单+zod）→ node:crypto Ed25519 离线验签 → envelope
  （`{licenseJwt, lastVerifiedAt, deviceHash}`）落 `userData/license.json` → 状态机出
  unlocked/locked。真机联网激活流（02 §9.5 全时序）与在线复验归 M5。
- **typ 头区分**：license JWT `header.typ='license'`（+payload.typ 双保险），与 access JWT
  （payload.typ='access'，HS256）在不同信任锚与不同 typ 下互斥；两类混淆均有拒绝用例。

## 3. jti：M0 仅记录不吊销（在线吊销归 M5 配置中心）

- jti 每次签发随机；签发（`license.issue`）与激活（`license.activate`）均把 jti 写入 audit_logs。
- **不实现**吊销名单：02 §12.3「吊销通过 jti 名单随配置下发」依赖配置中心/Feature Flag 下发通道
  （02 §12.1 配置服务），归 M5。M0 客户端不查任何名单——已知边界：被盗 license 在其 exp 前持续
  有效（以 exp+设备绑定+72h 窗口收敛风险）。
- **TODO(M5)**：配置中心下发 jti 名单 → 客户端在线复验时校验；名单签名同 Ed25519 通道。

## 4. 解绑 30 天限 1 次：以 max(revokedAt) 为「上次解绑时间戳」

- `devices` 表仅含 `activatedAt/lastSeenAt/revokedAt`（任务卡指定增补字段），**不另设 user 级
  lastUnbindAt 列**：解绑冷却以该用户 devices 的 `max(revokedAt)` 判定（解绑=写 revokedAt，行不删，
  保留审计事实）。测试两种手法都有：真实流（解绑→重绑→再解绑被 403）与直接改库
  （revokedAt 回拨 31 天 → 放行）。
- 语义口径：冷却按「自然流逝 ≥30 天」判定（`elapsedDays < 30` 拒绝），403 附 `retryAfterDays`；
  阻断亦留审计（`device.unbind.blocked`）。

## 5. 设备指纹：M0 弱化实现（hostname + CPU 型号 + MAC），M5 强化

- **M0 算法**：`sha256(normalize(hostname) + '\n' + normalize(cpu 型号) + '\n' + normalize(mac))`
  （`apps/desktop/src/license/device-fingerprint.ts`）。**已知弱化点**：①hostname/机器名可被用户
  修改导致指纹漂移（误判换机）；②MAC 随网卡/虚拟网卡变化；③无安装 ID 兜底。均为 M0 接受的
  假阳性风险（后果=用户需重新激活），非安全问题（原始指纹不出机器，仅哈希上行）。
- 02 §12.3 目标口径（主板序列号+磁盘序列号+随机安装 ID）需平台原生 API，**TODO(M5)** 强化并
  迁移；迁移时旧指纹哈希失效=用户重新激活一次，M5 发布说明需覆盖。

## 6. 72h 离线宽限：M0 的 lastVerifiedAt 口径

- 宽限窗 = `lastVerifiedAt + 72h`（FR-1.5），**边界整点即锁**（`now >= graceEndsAt` → GRACE_EXCEEDED）。
- **M0 限制（接受）**：`lastVerifiedAt` 仅在激活（及本地重激活）时推进，M0 无在线复验触发器，
  故宽限窗从激活起算，最多 72h 后必须重新激活/联网复验。M5 接入周期性在线验签后按服务端
  响应推进 lastVerifiedAt，宽限语义不变。
- 锁定只锁工作流写入口（dashboard/insight/sourcing/publish/promo/review 六视图执行入口置灰），
  logs/settings/report 路由保持可达（FR-1.6「历史数据查看+日志导出」；report=历史数据查看占位，
  真实导出能力归 M1/M5 对应卡）。

## 7. 并发超限：SERIALIZABLE 事务 + P2034 同判 409

- 设备上限判定与写入同事务（`isolationLevel: Serializable`）；并发竞争输方收到 P2034 → 同判
  409 `DEVICE_LIMIT_REACHED`（与 D9 卡防重放的「条件更新+回退判定」同思路）。**残留边界**：
  超长重试风暴下 PG serializable abort 需客户端重试，M5 若接真实客户端并发再考虑计数表/唯一
  约束化方案。
- 阻断（409/403）审计**不能与拒绝同事务**（throw 即回滚）：`license.blocked`、
  `device.unbind.blocked` 在独立事务落库后抛错，保证「阻断必有痕」。

## 8. e2e 跨包密钥读取（fixture 性质，非模块依赖）

- desktop e2e（`e2e/license.spec.ts`）以 `fs.readFileSync` 读 `apps/server/keys/license-private.pem`
  在测试进程内签发 license——只读 fixture 文件，**不构成 apps 间模块 import**（目录边界 lint 规则
  仍约束 import 语句）；测试密钥对本身是提交物（§1），读它不引入新泄漏面。
- `XINGLIAN_LICENSE_FILE` 为 main 进程 dev/test seam（license 文件位置注入）；生产固定
  `userData/license.json`。无「换公钥」类 seam——信任锚只有内置常量，测试经测试密钥对满足。
