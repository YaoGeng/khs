# 打包管线状态

> M0 基线（对照 05:56「asar/签名/notarize 走通空壳」；02:751-766 §15.1）。
> 网络事实（2026-10-11 实测）：github.com 不可达；registry.npmmirror.com 可达 → 已在 .npmrc / scripts/dist.mjs 配置二进制镜像（electron / electron-builder-binaries / better-sqlite3 prebuilds）。

| 目标 | 状态 | 证据 |
| --- | --- | --- |
| asar | ✅ 已验证：asar 内含编译产物 out/main.js（esbuild CJS bundle）+ index.html，无 stale .ts | app.asar header JSON（files.out.main.js）+ 2026-10-11 冒烟（ALIVE_AFTER_8S=True, STDERR empty） |
| NSIS 安装器 | ✅ dist 退出 0，产物 `dist/xinglian Setup 0.1.0.exe`（81.6MB）+ blockmap | 2026-10-11 dist 日志（NSIS 经 npmmirror 镜像下载成功） |
| win 签名 | 降级（无证书；electron-builder 识别后跳过：`no signing info identified, signing is skipped`） | dist 日志 signHook=false cscInfo=null；M5 T-M5-04 前必须补齐 |
| macOS notarize | 降级（无 Apple Developer 与 macOS runner） | 无 Apple Developer 账号（$99/年）且无 macOS CI runner |
| 原生模块预编译 | ✅ 可用（npmmirror 镜像）：better_sqlite3_binary_host_mirror 已配置 .npmrc | 镜像 HEAD 200（/-/binary/better-sqlite3/） |

**降级恢复动作**：签名证书与 Notarize 在 M5 T-M5-04 自动更新前必须补齐（付费项，发起人可随时改判采购升级）。
