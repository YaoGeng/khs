# apps/server/keys — M0 测试密钥对（kid=m0-license-test-1）

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `license-public.pem` | Ed25519 SPKI 公钥 | 服务端验签入口；**同一把公钥**以常量内置 `apps/desktop/src/license/public-key.ts`（离线验签信任锚） |
| `license-private.pem` | Ed25519 PKCS8 私钥 | 仅 M0 dev/test 签发（兑换响应 license、测试签发）。**严禁用于生产** |

- 生成/轮换命令：`node scripts/license-keys.mjs`（缺失生成；`--force` 覆盖，覆盖后需同步 desktop 内置公钥常量）。
- 生产部署：`NODE_ENV=production` 且私钥缺失时服务端拒绝启动（fail-fast）；生产私钥走离线保管 + M5 kid 轮换。
- 权衡与轮换策略详见 `docs/adr/notes-license-m0.md` §1/§3。
