/**
 * 1688 官方 AI 网关客户端（T-M2-05a；B-2 调研 2026-10-18 追加节）。
 *
 * 通道来源：next-1688/1688-shopkeeper（「1688 AI版 开店Claw」官方 Skill，仓库 About
 * 外链 air.1688.com 官方域）。本文件按其源码逐行核验转写（_auth.py / _http.py /
 * _const.py / capabilities/search/service.py），要点：
 * - **AK**：AI版 APP 发的个人 AK 串，先尝试 base64url 解码（严格字符集 + 合法 UTF-8，
 *   失败回退原文——对齐 Python `urlsafe_b64decode` 异常回退语义），解码结果/原文
 *   **前 32 字符 = AccessKeySecret，其余 = AccessKeyID**（secret 在前）。
 * - **签名**：`x-csk-sign = base64(HMAC-SHA256(secret, stringToSign))`；
 *   stringToSign = `METHOD\n content-md5\n content-type\n timestamp\n canonicalHeaders
 *   canonicalResource`；canonicalHeaders 为 x-csk-* 五头按字典序、每行 `k:v\n`
 *   （含末行换行）；canonicalResource 为 path（本通道无 query）。
 * - **网关**：`https://ainext.1688.com` + `POST /1688claw/skill/searchoffer`，
 *   body `{query, channel}`（channel 空 = 全渠道）；响应
 *   `{success, model:{data:{offerId:{title,price,image,stats?}}}, msgCode?, msgInfo?}`。
 * - **错误口径**（_http.py）：HTTP 401=鉴权失效、429=限流、400=参数；HTTP 200 但
 *   `success:false` 时按 msgCode 中的状态码字样归一，否则归 service。网络类错误重试
 *   （指数退避封顶 10s），其余不重试。
 * 本模块是纯客户端（fetch 可注入、electron-free）；AK 存储归 desktop main 侧 ak-store。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** 官方网关基址（_http.py BASE_URL） */
export const API_1688_BASE_URL = 'https://ainext.1688.com';
/** 检索端点（search/service.py） */
export const API_1688_SEARCH_PATH = '/1688claw/skill/searchoffer';
/** x-csk-version 头取值（_const.py SKILL_VERSION；网关按此识别调用方 skill 版本） */
export const API_1688_SKILL_VERSION = '1.0.1';
/** 单次检索返回条数上限（_const.py SEARCH_LIMIT） */
export const API_1688_SEARCH_LIMIT = 20;

/** AK 拆分结果（secret 前 32 / id 其余） */
export interface AkParts {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
}

/**
 * AK 原始串 → {id, secret}。base64url 解码失败或解码结果非合法 UTF-8 时回退原文
 * （Python 版行为：解码异常即 pass）；长度 < 32 或拆分后 id 为空 → null（无法构成有效调用方）。
 */
export function extractAkKeys(raw: string): AkParts | null {
  let candidate = raw;
  if (/^[A-Za-z0-9_-]+$/.test(raw) && raw.length % 4 !== 1) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'base64url'));
      if (decoded.length > 0) candidate = decoded;
    } catch {
      /* 非 UTF-8 解码结果 → 按原文处理（对齐 Python 回退） */
    }
  }
  if (candidate.length < 32) return null;
  const accessKeySecret = candidate.slice(0, 32);
  const accessKeyId = candidate.slice(32);
  if (accessKeyId.length === 0) return null;
  return { accessKeyId, accessKeySecret };
}

function contentMd5B64(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('base64');
}

/** 签名头构造入参（timestamp/nonce 注入以便测试复现；生产用默认随机） */
export interface SignedHeaderParams {
  readonly method: string;
  readonly path: string;
  /** 实际发送的 body 原文——签名与 MD5 都必须对同一字节串计算 */
  readonly body: string;
  readonly contentType: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  /** unix 秒（默认当前时间） */
  readonly timestampSeconds?: number;
  /** 8 位 hex nonce（默认随机） */
  readonly nonce?: string;
  readonly skillVersion?: string;
}

/** 按 _auth.py build_signature 生成 x-csk-* 全套请求头（含 Content-Type 与 x-csk-sign） */
export function buildSignedHeaders(params: SignedHeaderParams): Record<string, string> {
  const timestamp = String(params.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = params.nonce ?? randomBytes(4).toString('hex');
  const md5 = contentMd5B64(params.body);
  const cskHeaders: Record<string, string> = {
    'x-csk-ak': params.accessKeyId,
    'x-csk-time': timestamp,
    'x-csk-nonce': nonce,
    'x-csk-content-md5': md5,
    'x-csk-version': params.skillVersion ?? API_1688_SKILL_VERSION,
  };
  let canonicalizedHeaders = '';
  for (const key of Object.keys(cskHeaders).sort()) {
    canonicalizedHeaders += `${key}:${cskHeaders[key].trim()}\n`;
  }
  const stringToSign = `${params.method.toUpperCase()}\n${md5}\n${params.contentType}\n${timestamp}\n${canonicalizedHeaders}${params.path}`;
  const sign = createHmac('sha256', params.accessKeySecret).update(stringToSign, 'utf8').digest('base64');
  return { 'Content-Type': params.contentType, 'x-csk-sign': sign, ...cskHeaders };
}

/** 归一化检索结果项（data map 的一个条目；stats 原样透传供上层扩展评分） */
export interface SearchOfferItem {
  readonly offerId: string;
  readonly title: string;
  /** API 返回的价格原样转 string（可能单值或区间） */
  readonly priceText: string;
  readonly imageUrl: string | null;
  /** stats.last30DaysSales 的文本形态（数字 → `N件`；字符串且以数字开头 → 原样） */
  readonly salesText: string | null;
  /** API stats 原样（last30DaysSales/goodRates/repurchaseRate/downstreamOffer/collectionRate24h） */
  readonly stats: Record<string, unknown> | null;
}

/** API 调用失败分类（_http.py 错误映射；renderer/服务层据此给用户可读文案） */
export type ApiFailureKind = 'auth' | 'ratelimit' | 'param' | 'service' | 'network';

export class ApiCallError extends Error {
  readonly kind: ApiFailureKind;
  readonly status?: number;
  readonly msgCode?: string;

  constructor(kind: ApiFailureKind, message: string, meta?: { status?: number; msgCode?: string }) {
    super(`E-1688-API-${kind.toUpperCase()}: ${message}`);
    this.name = 'ApiCallError';
    this.kind = kind;
    this.status = meta?.status;
    this.msgCode = meta?.msgCode;
  }
}

/** 最小结构 fetch 面（global fetch 满足；测试注入桩） */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface SearchOffersParams {
  readonly fetchImpl: FetchLike;
  readonly ak: AkParts;
  readonly query: string;
  /** 渠道过滤：'' = 全渠道（_const.py CHANNEL_MAP：douyin/pinduoduo/xiaohongshu/thyny） */
  readonly channel?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly now?: () => number;
  readonly nonce?: () => string;
  /** 重试退避注入（测试瞬时化；生产缺省 setTimeout） */
  readonly delayFn?: (ms: number) => Promise<void>;
}

function statusToKind(status: number): ApiFailureKind {
  if (status === 401) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status === 400) return 'param';
  return 'service';
}

/** HTTP 200 但 success:false → 按 msgCode 内嵌状态码归一（_http.py _handle_biz_error） */
function bizErrorKind(msgCode: string): ApiFailureKind {
  const m = /\b(400|401|429|500)\b/.exec(msgCode);
  if (!m) return 'service';
  if (m[1] === '401') return 'auth';
  if (m[1] === '429') return 'ratelimit';
  if (m[1] === '400') return 'param';
  return 'service';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function salesTextFromStats(stats: Record<string, unknown> | null): string | null {
  if (!stats) return null;
  const raw = stats.last30DaysSales;
  if (typeof raw === 'number' && Number.isFinite(raw)) return `${raw}件`;
  if (typeof raw === 'string' && /^\d/.test(raw)) return raw;
  return null;
}

/** searchoffer 调用（签名 + 超时 + 网络类重试 + 错误归一 + data map 归一化） */
export async function searchOffers1688(params: SearchOffersParams): Promise<SearchOfferItem[]> {
  const body = JSON.stringify({ query: params.query, channel: params.channel ?? '' });
  const path = API_1688_SEARCH_PATH;
  const maxAttempts = Math.max(1, params.maxRetries ?? 3);
  const timeoutMs = params.timeoutMs ?? 30_000;

  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = buildSignedHeaders({
      method: 'POST',
      path,
      body,
      contentType: 'application/json',
      accessKeyId: params.ak.accessKeyId,
      accessKeySecret: params.ak.accessKeySecret,
      timestampSeconds: params.now ? Math.floor(params.now() / 1000) : undefined,
      nonce: params.nonce?.(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await params.fetchImpl(`${API_1688_BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status !== 200) {
        // 鉴权/限流/参数等 HTTP 错误不重试（对齐 _http.py：只重试网络类异常）
        throw new ApiCallError(statusToKind(response.status), `HTTP ${response.status}`, { status: response.status });
      }
      let parsed: { success?: boolean; model?: unknown; msgCode?: unknown; msgInfo?: unknown };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new ApiCallError('service', '响应不是合法 JSON');
      }
      if (parsed.success === false) {
        const msgCode = typeof parsed.msgCode === 'string' ? parsed.msgCode : '';
        const detail = typeof parsed.msgInfo === 'string' && parsed.msgInfo.length > 0 ? parsed.msgInfo : msgCode || '未知业务错误';
        throw new ApiCallError(bizErrorKind(msgCode), detail, { msgCode });
      }
      const model = parsed.model;
      const data = (model && typeof model === 'object' && !Array.isArray(model) ? (model as Record<string, unknown>).data : null) ?? {};
      if (typeof data !== 'object' || Array.isArray(data)) {
        throw new ApiCallError('service', '搜索结果格式异常（data 不是对象）');
      }
      const items: SearchOfferItem[] = [];
      for (const [offerId, value] of Object.entries(data as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        const stats = (item.stats && typeof item.stats === 'object' && !Array.isArray(item.stats))
          ? (item.stats as Record<string, unknown>)
          : null;
        items.push({
          offerId,
          title: typeof item.title === 'string' ? item.title : '未知商品',
          priceText: item.price == null ? '' : String(item.price),
          imageUrl: typeof item.image === 'string' && item.image.length > 0 ? item.image : null,
          salesText: salesTextFromStats(stats),
          stats,
        });
      }
      return items;
    } catch (error) {
      if (error instanceof ApiCallError) throw error;
      // 网络类（fetch 抛错/超时 abort）→ 指数退避重试（对齐 _http.py _with_retry）
      lastNetworkError = error;
      if (attempt < maxAttempts) await (params.delayFn ?? delay)(Math.min(1000 * 2 ** (attempt - 1), 10_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ApiCallError('network', `网络异常，已重试${maxAttempts}次`, {
    status: undefined,
    msgCode: lastNetworkError instanceof Error ? lastNetworkError.message.slice(0, 120) : undefined,
  });
}
