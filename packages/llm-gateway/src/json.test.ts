/**
 * 宽容 JSON 解析单测（降级链 regex 段提取核心）。
 */
import { describe, it, expect } from 'vitest';
import { balancedJsonObjects, parseJsonLoose } from './json.js';

describe('parseJsonLoose', () => {
  it('直接 JSON 命中', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('Markdown 代码围栏剥离', () => {
    expect(parseJsonLoose('好的，以下是结果：\n```json\n{"a": [1,2]}\n```\n希望有帮助')).toEqual({ a: [1, 2] });
  });

  it('前后噪声文本中提取（regex-extraction-fallback 语义）', () => {
    const messy = '分析结论如下 {"topic":"敏感肌","score":3.5,"tags":["修护","屏障"]} 以上。';
    expect(parseJsonLoose(messy)).toEqual({ topic: '敏感肌', score: 3.5, tags: ['修护', '屏障'] });
  });

  it('嵌套对象与字符串内花括号/引号转义安全', () => {
    const messy = '前缀 {"outer":{"inner":"包含 } 与 \\" 与 { 的字符串"},"n":2} 后缀';
    expect(parseJsonLoose(messy)).toEqual({ outer: { inner: '包含 } 与 " 与 { 的字符串' }, n: 2 });
  });

  it('全文无 JSON 时抛错（message 不回显原文）', () => {
    expect(() => parseJsonLoose('完全没有结构化内容')).toThrow(/未找到可解析的 JSON/);
    expect(() => parseJsonLoose('')).toThrow(/为空/);
  });
});

describe('balancedJsonObjects', () => {
  it('配平扫描：跳过字符串字面量中的花括号', () => {
    expect(balancedJsonObjects('x {"a":"}"} y')).toEqual(['{"a":"}"}']);
  });

  it('多个顶层候选按序返回', () => {
    expect(balancedJsonObjects('{"a":1} 中间 {"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('未配平的孤立花括号不产出候选', () => {
    expect(balancedJsonObjects('{"a":1')).toEqual([]);
  });
});
