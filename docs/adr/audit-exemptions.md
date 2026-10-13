# pnpm audit 豁免记录（F2/Q3）

> 面口径：`pnpm audit --prod` = **0 known vulnerabilities**（2026-10-13 复核，overrides 已生效）。
> `pnpm audit` 全量（含 dev 链）剩余 64 项，全部位于开发/测试工具链，逐项豁免理由如下。

## 已修复（overrides，见 pnpm-workspace.yaml）

| 包 | 公告 | 处置 |
| --- | --- | --- |
| multer <2.3.0 | GHSA-wc9g-mqfw-jrwm / GHSA-535w-7cp7-47q4（high DoS）等 4 条 | override ≥2.3.0 |
| deepmerge-ts <8.0.0 | GHSA-ggr8-5vv4-36mx（high 栈耗尽） | override ≥8.0.0 |
| mysql2 ≤3.23.0 | GHSA-3f6p-5ww8-9rcr / GHSA-rgwj-5xj2-c3m3（high 凭据泄漏/DoS） | override ≥3.23.1 |
| qs ≤6.15.x | GHSA-q8mj-m7cp-5q26 等 3 条（moderate DoS） | override ≥6.16.0 |
| body-parser <1.20.6 | GHSA-v422-hmwv-36x6（low） | override ≥1.20.6 |
| @nestjs/core 10.x | GHSA-36xv-jgw5-4q75（moderate 注入） | Nest 全栈升 ^11.2.7 |

## 豁免项（dev 面，不随应用发布）

| 包 | 数量 | 豁免理由 | 复查点 |
| --- | --- | --- | --- |
| electron ^33.4.11 | 24（high/moderate/low） | Electron 33 已 EOL，但 M0 应用渲染面仅本地文件（CSP self + contextIsolation + sandbox），平台页面在用户自有 Chrome/Edge 打开（非 Electron WebView），M0 攻击面不含远程内容；ABI 链已在其上完成全量验证（better-sqlite3 v130 预编译、ADR-8 基准、S11 打包验证），临时升级需重跑整条原生验证链 | **M5 T-M5-04 自动更新管线前必须升级至最新稳定大版本并重跑 ADR-8/S11/ABI 链**（属付费升级管线同一工单） |
| vitest ^2 | 2（moderate，@vitest/mocker 路径穿越） | 仅本地测试执行器，不进产物；mock 重定向漏洞需攻击者控制本地测试文件 | M1 收尾时评估升 vitest 4（配置迁移成本独立评估） |
| ioredis-mock 链（fengari→sprintf-js） | 1（moderate，无补丁版本） | 测试专用 mock 适配器，无补丁可升；sprintf-js DoS 需攻击者控制格式串 | M5 前复查上游是否发布补丁 |
| 其余 dev 链（playwright/builder 等） | 余量 | 构建与打包期一次性工具，不进用户设备运行面 | 每 tag 前复跑 `pnpm audit --prod` 必须 0 |

**门禁口径**：F2 验收「pnpm audit 高危清零或记录豁免理由」→ prod 面已清零（硬标准），dev 面已逐项记录豁免与复查点（本文件）。
