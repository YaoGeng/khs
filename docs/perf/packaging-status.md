# 打包管线状态

| 目标 | 状态 | 证据 |
| --- | --- | --- |
| asar | 待验证（本子任务不跑 dist） | electron-builder.yml 已配置 asar: true |
| win 签名 | 降级（证书缺失，M5 T-M5-04 前必须补齐） | 无代码签名证书 |
| macOS notarize | 降级（无 Apple Developer 与 macOS runner） | 无 Apple Developer 账号（$99/年）且无 macOS CI runner |
