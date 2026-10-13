import { describe, expect, it } from 'vitest';
import { manifestSignablePayload, normalizePem } from './signing.js';

describe('manifestSignablePayload', () => {
  it('输出固定键序的紧凑 JSON（签名/验签双方共用的规范化字节）', () => {
    const payload = manifestSignablePayload({
      platform: 'xhs',
      version: '1.0.0',
      minEngineVersion: '1.0.0',
      sha256: 'a'.repeat(64),
    });
    expect(payload).toBe(
      `{"platform":"xhs","version":"1.0.0","minEngineVersion":"1.0.0","sha256":"${'a'.repeat(64)}"}`,
    );
  });

  it('键插入顺序不影响规范化结果', () => {
    const a = manifestSignablePayload({
      platform: 'xhs',
      version: '2.0.0',
      minEngineVersion: '1.0.0',
      sha256: 'b'.repeat(64),
    });
    const b = manifestSignablePayload({
      sha256: 'b'.repeat(64),
      minEngineVersion: '1.0.0',
      version: '2.0.0',
      platform: 'xhs',
    });
    expect(a).toBe(b);
  });
});

describe('normalizePem', () => {
  it('剥掉 PEM 头之前的注释行（测试密钥「TEST ONLY」头）', () => {
    const withHeader = [
      '// TEST ONLY - 非生产密钥',
      '-----BEGIN PUBLIC KEY-----',
      'MCowBQYDK2VwAyEA',
      '-----END PUBLIC KEY-----',
      '',
    ].join('\n');
    expect(normalizePem(withHeader)).toBe(withHeader.slice(withHeader.indexOf('-----BEGIN')));
  });

  it('纯 PEM 原样返回', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    expect(normalizePem(pem)).toBe(pem);
  });
});
