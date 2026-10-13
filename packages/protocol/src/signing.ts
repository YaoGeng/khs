import type { AdapterManifest } from './dsl.js';

/**
 * 参与签名的规范化 manifest 载荷（固定键序的紧凑 JSON；sig 字段本身不参与签名）。
 * 签名/验签双方（dev CLI 与 loader）必须共用本函数，杜绝双方规范化漂移。
 */
export function manifestSignablePayload(manifest: Omit<AdapterManifest, 'sig'>): string {
  return JSON.stringify({
    platform: manifest.platform,
    version: manifest.version,
    minEngineVersion: manifest.minEngineVersion,
    sha256: manifest.sha256,
  });
}

/**
 * 宽容读取 PEM：剥掉文件头部注释行（如测试密钥的「TEST ONLY」头），
 * 返回从首个 -----BEGIN 行开始的纯 PEM 文本。
 */
export function normalizePem(input: string): string {
  const begin = input.indexOf('-----BEGIN');
  return begin > 0 ? input.slice(begin) : input;
}
