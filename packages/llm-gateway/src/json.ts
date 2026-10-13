/**
 * 宽容 JSON 解析（结构化输出降级链 regex-extraction-fallback 段的提取核心）。
 * 依次尝试：直接 parse → 剥 Markdown 代码围栏 → 花括号配平扫描逐候选解析。
 */

/** 从任意文本中按花括号配平提取完整 {...} 候选（跳过字符串字面量与转义；最多返回 10 个） */
export function balancedJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
        if (candidates.length >= 10) break;
      }
    }
  }
  return candidates;
}

/** 解析失败抛错（message 不含原文全文，防泄漏进日志） */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('LLM 返回内容为空，无法解析 JSON');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 降级继续 */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 降级继续 */
    }
  }
  for (const candidate of balancedJsonObjects(trimmed)) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* 尝试下一候选 */
    }
  }
  throw new Error('LLM 返回内容中未找到可解析的 JSON 对象');
}
