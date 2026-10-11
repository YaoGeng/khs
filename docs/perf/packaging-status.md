# 打包管线状态

> M0 降级记录（对照 05:56 基线「asar/签名/notarize 走通空壳」；02:751-766 §15.1）。本机网络 GitHub 与 npmmirror 均不可达（2026-10-11 实测），影响 NSIS 工具包与 winCodeSign 下载。

| 目标 | 状态 | 证据 |
| --- | --- | --- |
| asar | ✅ 已验证：打包产物 asar 内含编译产物 out/main.js（esbuild CJS bundle, 1768B）+ index.html，无 stale .ts；exe 冒烟启动存活（8s 无崩溃，stderr 空） | app.asar header JSON（files.out.main.js offset=168）+ 2026-10-11 冒烟记录（ALIVE_AFTER_8S=True, STDERR empty） |
| 免安装可运行产物（win-unpacked） | ✅ dist 退出码 0 | `pnpm --filter @xinglian/desktop dist` → dist/win-unpacked/xinglian.exe（Electron 33.4.11） |
| NSIS 安装器 | ⚠️ 降级（网络阻断）：GitHub 下载 nsis-3.0.4.1 超时、npmmirror 镜像不可达；win.target 暂切 `dir` | 2026-10-11 dist 日志（dial tcp 20.205.243.166:443 失败 ×4 重试）；镜像 HEAD 请求 fetch failed |
| exe 资源编辑（图标/版本） | ⚠️ 跳过：rcedit 依赖 winCodeSign-2.6.0 无法下载；`signAndEditExecutable: false` | 同上网络证据；electron-builder.yml 内注记 |
| win 签名 | 降级（证书缺失，M5 T-M5-04 前必须补齐） | 无代码签名证书 |
| macOS notarize | 降级（无 Apple Developer 与 macOS runner） | 无 Apple Developer 账号（$99/年）且无 macOS CI runner |

**恢复动作（镜像可达后）**：win.target 切回 `nsis`、移除 `signAndEditExecutable: false`、重跑 dist 验证安装器产物；M5 前补齐签名证书与 Notarize（自动更新强依赖）。
