/**
 * BYOK Key 服务（m1-insight-plan todo 10 = T-M1-08①；FR-2.1/FR-2.7/PC-03①）。
 *
 * electron-free：safeStorage 经注入 Port（main/safe-storage-port.ts 是 electron 薄壳），
 * store 走 StoreClient 的 kv/日志/keyword_hits 面，fetch 注入（keys:test 真实链路可单测）。
 *
 * 安全不变量：
 * - Key 全值只落 kv_config（value_blob=Buffer 密文 | 降级明文 string），永不进任何 IPC 出口；
 * - masked 读回仅 `sk-****`+后 4 位（非 sk- 前缀用 `****`+后 4 位）；
 * - safeStorage 不可用 → 显式降级：明文落库**前**先写审计条目进 logs 表 + 告警文案随
 *   keys:set 结果返回（界面 toast，绝不静默）；
 * - keys:get-masked 出口断言（ipc-core 层）：响应对 exitAuditRawValues() 深扫描不得出现全值。
 *
 * keys:test 注记（todo-8 实测）：推理型模型的 reasoning 计入 completion 配额，max_tokens
 * 需 ≥8192 否则易返回空内容；opencode 类网关需要自定义 UA + x-opencode-session 头
 * （仅注记——预设五家官方端点都不需要，故不默认携带）。
 */
import {
  KEY_ERRORS,
  KEY_PROVIDER_IDS,
  type KeyProviderId,
} from '../shared/channels';
import {
  KeysSetResultSchema,
  type KeysGetMaskedResult,
  type KeysPrecallConfirmParams,
  type KeysPrecallConfirmResult,
  type KeysScanTestParams,
  type KeysScanTestResult,
  type KeysSetParams,
  type KeysSetResult,
  type KeysTestParams,
  type KeysTestResult,
} from '../shared/schemas';
import type { WordlistScanHit } from '@xinglian/protocol';
import type { StoreClient } from '../store/client';

/** electron safeStorage 注入面（main/safe-storage-port.ts 薄壳；测试注入 fake） */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** 词库扫描消费面（compliance/wordlist-service.ts 提供；此处仅依赖最小 Pick 面） */
export interface WordlistScanFacade {
  readonly whenReady: Promise<string | null>;
  activeVersion(): string | null;
  scanText(text: string): WordlistScanHit[];
  scanKeywords(keywords: string[]): WordlistScanHit[];
}

export interface KeyServiceDeps {
  readonly store: Pick<StoreClient, 'kvGet' | 'kvSet' | 'kvDel' | 'insertLogs' | 'insertKeywordHit'>;
  /** null = 运行环境无 safeStorage（非 electron/测试桩显式关闭）→ 同「不可用」显式降级路径 */
  readonly safeStorage: SafeStoragePort | null;
  readonly fetchFn: typeof fetch;
  readonly wordlist: WordlistScanFacade;
  readonly now?: () => Date;
  /** keys:test 网络超时（默认 10s） */
  readonly testTimeoutMs?: number;
}

export interface KeyService {
  setKey(params: KeysSetParams): Promise<KeysSetResult>;
  getMasked(): Promise<KeysGetMaskedResult>;
  /** keys:get-masked 出口断言输入：明文形态全值列表（仅主进程内存；Buffer 密文不适用 JSON 泄漏） */
  exitAuditRawValues(): Promise<string[]>;
  test(params: KeysTestParams): Promise<KeysTestResult>;
  precallConfirm(params: KeysPrecallConfirmParams): Promise<KeysPrecallConfirmResult>;
  scanTest(params: KeysScanTestParams): Promise<KeysScanTestResult>;
}

const KV_KEY_PREFIX = 'byok:key:';
const KV_META_PREFIX = 'byok:meta:';
const KV_BACKUP_PREFIX = 'byok:key-backup:';
export const KV_WORDLIST_ACTIVE = 'wordlist:active';
export { KV_KEY_PREFIX, KV_META_PREFIX, KV_BACKUP_PREFIX };

interface KeyMetaJson {
  provider: KeyProviderId;
  masked: string;
  /** FR-2.4 备用 Key 的 masked 列表（与主 Key 同形态脱敏） */
  backupMasked?: string[];
  encryption: 'safeStorage' | 'plaintext-fallback';
  baseUrl: string | null;
  model: string | null;
  setAt: string;
}

/** 备用 Key 存储形态（逐把独立加密；与主 Key 同一降级纪律） */
interface BackupStoreJson {
  encryption: 'safeStorage' | 'plaintext-fallback';
  /** safeStorage=base64(ciphertext)；plaintext-fallback=明文（仅显式降级路径） */
  items: string[];
}

/** 预设五家官方默认 base_url（与 llm-gateway presets.ts 互链镜像；custom 必须用户自填） */
const DEFAULT_BASE_URLS: Partial<Record<KeyProviderId, string>> = {
  deepseek: 'https://api.deepseek.com/v1',
  tongyi: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
};

/** 预设五家缺省测试模型（keys:test 未指定 model 时的缺省；custom 必须用户自填） */
const DEFAULT_MODELS: Partial<Record<KeyProviderId, string>> = {
  deepseek: 'deepseek-chat',
  tongyi: 'qwen-plus',
  zhipu: 'glm-4.7-flash',
  openai: 'gpt-4o-mini',
  siliconflow: 'Qwen/Qwen2.5-7B-Instruct',
};

export function maskKey(key: string): string {
  const last4 = key.slice(-4);
  const prefix = key.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}****${last4}`;
}

/** 报告网关 Key 条目（明文仅主进程内存；结构与 report-service.ReportLlmConfig 对齐） */
export interface GatewayKeyEntry {
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** FR-2.4 备用 Key（同 provider，主 Key 鉴权失败时网关轮换；顺序即优先级） */
  backupKeys: string[];
  model: string;
}

/** 备用 Key 解密读取（明文形态仅主进程内存；无记录/解析失败 → 空数组不抛） */
async function readBackupKeys(deps: Pick<StoreClient, 'kvGet'>, safeStorage: SafeStoragePort | null, provider: KeyProviderId): Promise<string[]> {
  const raw = await deps.kvGet(KV_BACKUP_PREFIX + provider);
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: BackupStoreJson;
  try {
    parsed = JSON.parse(raw) as BackupStoreJson;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.items)) return [];
  return parsed.items
    .map((item) => {
      if (parsed.encryption !== 'safeStorage') return item;
      if (!safeStorage) return '';
      try {
        return safeStorage.decryptString(Buffer.from(item, 'base64'));
      } catch {
        return '';
      }
    })
    .filter((key) => key.length >= 8);
}

/**
 * BYOK Key → 报告网关配置读取器（m1 todo 11 组合根消费）：复用本模块的官方缺省
 * base_url/model 表；密文经 safeStorage 解密，明文形态原样返回。未配置返回 null。
 */
export function createGatewayKeyReader(
  deps: Pick<StoreClient, 'kvGet'>,
  safeStorage: SafeStoragePort | null,
): (provider: string) => Promise<GatewayKeyEntry | null> {
  async function readMeta(provider: KeyProviderId): Promise<KeyMetaJson | null> {
    const raw = await deps.kvGet(KV_META_PREFIX + provider);
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as KeyMetaJson;
    } catch {
      return null;
    }
  }
  return async (providerId: string) => {
    const provider = providerId as KeyProviderId;
    const raw = await deps.kvGet(KV_KEY_PREFIX + provider);
    const meta = await readMeta(provider);
    if (!raw || !meta) return null;
    let apiKey: string;
    if (typeof raw === 'string') {
      apiKey = raw;
    } else if (safeStorage) {
      apiKey = safeStorage.decryptString(raw);
    } else {
      return null;
    }
    const baseUrl = meta.baseUrl ?? DEFAULT_BASE_URLS[provider] ?? null;
    const model = meta.model ?? DEFAULT_MODELS[provider] ?? null;
    if (!baseUrl || !model) return null;
    const backupKeys = await readBackupKeys(deps, safeStorage, provider);
    return { provider, baseUrl, apiKey, backupKeys, model };
  };
}

function providerLabel(provider: KeyProviderId): string {
  return provider === 'custom' ? '自定义网关' : provider;
}

export function createKeyService(deps: KeyServiceDeps): KeyService {
  const now = deps.now ?? (() => new Date());
  const testTimeoutMs = deps.testTimeoutMs ?? 10_000;
  /** 调用前提示的会话内状态：每 provider 确认一次；reset 可重置（FR-2.7③） */
  const precallConfirmed = new Set<KeyProviderId>();

  async function writeAudit(msg: string, payload: Record<string, unknown>): Promise<void> {
    const at = now().toISOString();
    await deps.store.insertLogs([
      { ts: at, level: 40, levelName: 'warn', category: 'user-action', msg, payload },
    ]);
  }

  async function readMetaAsync(provider: KeyProviderId): Promise<KeyMetaJson | null> {
    const raw = await deps.store.kvGet(KV_META_PREFIX + provider);
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as KeyMetaJson;
    } catch {
      return null;
    }
  }

  return {
    async setKey(params: KeysSetParams): Promise<KeysSetResult> {
      const at = now().toISOString();
      const masked = maskKey(params.key);
      const backups = (params.backupKeys ?? []).filter((k) => k.length >= 8);
      const available = deps.safeStorage?.isEncryptionAvailable() ?? false;
      let encryption: 'safeStorage' | 'plaintext-fallback';
      let warning: string | undefined;
      if (available && deps.safeStorage) {
        // safeStorage 密文（Buffer 形态）落 kv_config——todo-6 kv 契约的双形态消费点
        await deps.store.kvSet(KV_KEY_PREFIX + params.provider, deps.safeStorage.encryptString(params.key));
        encryption = 'safeStorage';
      } else {
        // 显式降级（绝不静默）：明文落库**前**先写审计条目（logs 表），再存明文
        await writeAudit('keys:key-stored-plaintext-fallback', {
          provider: params.provider,
          safeStorageAvailable: false,
          at,
          backupCount: backups.length,
          note: 'safeStorage 不可用，Key 以明文落 kv_config（FR-2.7 显式降级）',
        });
        await deps.store.kvSet(KV_KEY_PREFIX + params.provider, params.key);
        encryption = 'plaintext-fallback';
        warning =
          'safeStorage 不可用：Key 已按明文本地保存（已写入审计日志）。建议在支持操作系统级凭据保护的环境中尽快更换。';
      }
      // FR-2.4 备用 Key：逐把独立加密，同一降级纪律（无 safeStorage 时随审计条目一并告警）
      const backupMasked = backups.map(maskKey);
      if (backups.length > 0) {
        const items =
          available && deps.safeStorage
            ? backups.map((key) => deps.safeStorage!.encryptString(key).toString('base64'))
            : backups;
        await deps.store.kvSet(KV_BACKUP_PREFIX + params.provider, JSON.stringify({ encryption, items } satisfies BackupStoreJson));
        if (!(available && deps.safeStorage)) {
          await writeAudit('keys:backup-stored-plaintext-fallback', {
            provider: params.provider,
            count: backups.length,
            at,
            note: 'safeStorage 不可用，备用 Key 以明文落 kv_config（FR-2.4 显式降级）',
          });
          warning = `${warning ?? ''}备用 Key（${backups.length} 把）同样以明文保存并已写审计日志。`;
        }
      } else {
        await deps.store.kvDel(KV_BACKUP_PREFIX + params.provider);
      }
      const meta: KeyMetaJson = {
        provider: params.provider,
        masked,
        backupMasked,
        encryption,
        baseUrl: params.baseUrl ?? null,
        model: params.model ?? null,
        setAt: at,
      };
      await deps.store.kvSet(KV_META_PREFIX + params.provider, JSON.stringify(meta));
      return KeysSetResultSchema.parse({
        provider: params.provider,
        masked,
        backupMasked,
        encryption,
        ...(warning ? { warning } : {}),
      });
    },

    async getMasked(): Promise<KeysGetMaskedResult> {
      const keys = [];
      for (const provider of KEY_PROVIDER_IDS) {
        const meta = await readMetaAsync(provider);
        keys.push(
          meta
            ? { ...meta, backupMasked: meta.backupMasked ?? [] }
            : {
                provider,
                masked: null,
                backupMasked: [],
                encryption: null,
                baseUrl: null,
                model: null,
                setAt: null,
              },
        );
      }
      return { keys };
    },

    async exitAuditRawValues(): Promise<string[]> {
      const values: string[] = [];
      for (const provider of KEY_PROVIDER_IDS) {
        const raw = await deps.store.kvGet(KV_KEY_PREFIX + provider);
        if (typeof raw === 'string' && raw.length > 0) values.push(raw);
        // FR-2.4：备用 Key 全值同在深扫描范围（masked 出口泄漏检测不漏备用 Key）
        for (const backup of await readBackupKeys(deps.store, deps.safeStorage, provider)) values.push(backup);
      }
      return values;
    },

    async test(params: KeysTestParams): Promise<KeysTestResult> {
      const provider = params.provider;
      const meta = await readMetaAsync(provider);
      const raw = await deps.store.kvGet(KV_KEY_PREFIX + provider);
      if (!raw || !meta) {
        throw new Error(
          `${KEY_ERRORS.NOT_CONFIGURED}: ${providerLabel(provider)} 未配置 API Key——请先在上方保存 Key 后再测试连接（FR-2.7 引导配置，而非报裸错误）`,
        );
      }
      const baseUrl = params.baseUrl ?? meta.baseUrl ?? DEFAULT_BASE_URLS[provider] ?? null;
      if (!baseUrl) {
        throw new Error(`${KEY_ERRORS.BASE_URL_REQUIRED}: 自定义网关需要 base_url——请在设置页填写后保存`);
      }
      const model = params.model ?? meta.model ?? DEFAULT_MODELS[provider] ?? null;
      if (!model) {
        throw new Error(`${KEY_ERRORS.NOT_CONFIGURED}: 自定义网关需要模型名——请在设置页填写后保存`);
      }
      let plain: string;
      if (typeof raw === 'string') {
        plain = raw;
      } else if (deps.safeStorage) {
        plain = deps.safeStorage.decryptString(raw);
      } else {
        throw new Error(`${KEY_ERRORS.NOT_CONFIGURED}: Key 存储形态与运行环境不一致（密文但无 safeStorage）——请重新保存 Key`);
      }

      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), testTimeoutMs);
        // max_tokens ≥8192：推理型模型 reasoning 计入 completion 配额，过小会得到空内容（todo-8 实测注记）
        const response = await deps.fetchFn(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${plain}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 8192,
            stream: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - started;
        if (response.ok) {
          // 消费响应体但不外泄：只取 ok 结论（不落响应原文——防服务商回显机密进日志/UI）
          await response.arrayBuffer();
          return { ok: true, provider, model, latencyMs, httpStatus: response.status, error: null };
        }
        return { ok: false, provider, model, latencyMs, httpStatus: response.status, error: `HTTP ${response.status}` };
      } catch (error) {
        const latencyMs = Date.now() - started;
        const err = error as Error;
        const summary =
          err.name === 'AbortError' || err.name === 'TimeoutError'
            ? `网络超时（>${testTimeoutMs}ms）`
            : `网络错误：${String(err.message).slice(0, 120)}`;
        return { ok: false, provider, model, latencyMs, httpStatus: null, error: summary };
      }
    },

    async precallConfirm(params: KeysPrecallConfirmParams): Promise<KeysPrecallConfirmResult> {
      if (params.action === 'confirm') {
        precallConfirmed.add(params.provider);
        return { needConfirm: false };
      }
      if (params.action === 'reset') {
        precallConfirmed.delete(params.provider);
        return { needConfirm: true };
      }
      return { needConfirm: !precallConfirmed.has(params.provider) };
    },

    async scanTest(params: KeysScanTestParams): Promise<KeysScanTestResult> {
      await deps.wordlist.whenReady;
      const version = deps.wordlist.activeVersion();
      if (!version) {
        throw new Error(`${KEY_ERRORS.WORDLIST_NOT_READY}: 词库配置包未就绪（active 版本缺失或全部损坏）`);
      }
      const hits: Array<{ term: string; category: string | null; kind: 'extreme' | 'redirect' | 'blacklist'; source: 'text' | 'keyword' }> = [];
      if (params.text) {
        for (const hit of deps.wordlist.scanText(params.text)) hits.push({ ...hit, source: 'text' });
      }
      for (const keyword of params.keywords ?? []) {
        for (const hit of deps.wordlist.scanKeywords([keyword])) hits.push({ ...hit, source: 'keyword' });
      }
      let persisted = 0;
      for (const hit of hits) {
        await deps.store.insertKeywordHit({
          wordlistVersion: version,
          term: hit.term,
          category: hit.category ?? undefined,
          topicId: params.topicId,
        });
        persisted += 1;
      }
      return { wordlistVersion: version, hits, persisted };
    },
  };
}
