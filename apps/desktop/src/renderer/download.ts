/**
 * 渲染层共用小工具（todo 11）：Blob 下载触发 + CSV 转义。
 * CSP 注记：download 触发走 a[download] 点击，不产生导航/外联请求（02 §11.2）。
 */

/** 触发浏览器下载（Blob；MD/PDF/CSV/PNG 共用） */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM 前置 CSV（FR-4.6：Excel 可开；不造假 .xlsx） */
export function buildCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): Blob {
  const lines = [header.map(csvField).join(','), ...rows.map((row) => row.map(csvField).join(','))].join('\r\n');
  return new Blob([`\uFEFF${lines}`], { type: 'text/csv;charset=utf-8' });
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mime });
}
