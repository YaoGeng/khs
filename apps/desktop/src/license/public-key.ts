/**
 * 内置 Ed25519 公钥（02-系统架构设计.md §12.3「验签完全离线（客户端内嵌公钥）」）。
 *
 * 来源：apps/server/keys/license-public.pem（M0 固定测试密钥对的公钥半边，
 * 由 apps/server/scripts/license-keys.mjs 生成；kid=m0-license-test-1）。
 * 密钥管理取舍与 M5 轮换策略见 docs/adr/notes-license-m0.md §1——
 * M5 前必须轮换为离线保管的生产密钥对，届时本常量随 kid 机制演进为多钥表。
 *
 * 更新步骤：node scripts/license-keys.mjs --force（apps/server）→ 同步本常量。
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkjmUv0NsgotvxVtFIKpPcEMPieJOP26Rge8vUGuKcIU=
-----END PUBLIC KEY-----
`;
