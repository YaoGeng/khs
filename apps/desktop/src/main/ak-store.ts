/**
 * 1688 官方 API AK 存储（T-M2-05a）——key-service 同款安全纪律的最小集：
 * - AK 原始串全值只落 kv_config（Buffer 密文 | 降级明文 string），永不进任何 IPC 出口；
 * - safeStorage 不可用 → 显式降级：明文落库**前**先写审计条目，告警随 set 结果返回；
 * - 出口一律 masked（akId 后 4 位）；secret 全值仅主进程内存（get() 供 API 端口调用）。
 * AK 语义见 adapters-1688 api-client.extractAkKeys（AI版 APP 原始串：前 32 = secret，其余 = id）。
 */
import { extractAkKeys, type AkParts } from '@xinglian/adapters-1688';
import type { SafeStoragePort } from './key-service';
import type { StoreClient } from '../store/client';

const KV_AK = 'sourcing:ak:v1';
const KV_AK_META = 'sourcing:ak:meta:v1';

export type AkEncryption = 'safeStorage' | 'plaintext-fallback';

export interface AkStatus {
  readonly configured: boolean;
  /** masked 出口（`****` + akId 后 4 位）；未配置为 null */
  readonly accessKeyIdMasked: string | null;
  readonly encryption: AkEncryption | null;
  readonly setAt: string | null;
}

export interface AkSetResult {
  readonly accessKeyIdMasked: string;
  readonly encryption: AkEncryption;
  /** 显式降级告警文案（界面 toast，绝不静默） */
  readonly warning?: string;
}

export interface AkStore {
  /** 覆盖式保存；AK 无法解析 → 抛 E-SOURCING-AK-INVALID（不落库） */
  setRaw(raw: string): Promise<AkSetResult>;
  /** 供主进程 API 调用；未配置 / 密文解不开 / 值损坏 → null */
  get(): Promise<AkParts | null>;
  status(): Promise<AkStatus>;
  clear(): Promise<void>;
}

interface AkMetaJson {
  masked: string;
  encryption: AkEncryption;
  setAt: string;
}

export function maskAkId(accessKeyId: string): string {
  return `****${accessKeyId.slice(-4)}`;
}

export function createAkStore(deps: {
  store: Pick<StoreClient, 'kvGet' | 'kvSet'>;
  safeStorage: SafeStoragePort | null;
  /** 降级审计注入（组合根接 logger.userAction；electron-free 可省） */
  onAudit?: (msg: string, payload: Record<string, unknown>) => void;
}): AkStore {
  const readValue = async (): Promise<string | null> => {
    const value = await deps.store.kvGet(KV_AK);
    if (value === null || value === undefined) return null;
    // 密文过 store worker 进程边界后可能丢失 Buffer 原型（结构化克隆为普通 Uint8Array），
    // 必须 instanceof Uint8Array 统一收口（Buffer 是其子类），否则密文字节会被当原文解析
    if (value instanceof Uint8Array) {
      if (!deps.safeStorage) return null;
      try {
        return deps.safeStorage.decryptString(Buffer.from(value));
      } catch {
        return null;
      }
    }
    return value;
  };

  const readMeta = async (): Promise<AkMetaJson | null> => {
    const raw = await deps.store.kvGet(KV_AK_META);
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw) as AkMetaJson;
      return parsed.masked && parsed.encryption ? parsed : null;
    } catch {
      return null;
    }
  };

  return {
    async setRaw(raw) {
      const parts = extractAkKeys(raw);
      if (!parts) {
        throw new Error('E-SOURCING-AK-INVALID: AK 无法解析（需 1688 AI版 APP 复制的原始串，有效长度 ≥ 32）');
      }
      const at = new Date().toISOString();
      const available = deps.safeStorage?.isEncryptionAvailable() ?? false;
      let encryption: AkEncryption;
      let warning: string | undefined;
      if (available && deps.safeStorage) {
        await deps.store.kvSet(KV_AK, deps.safeStorage.encryptString(raw));
        encryption = 'safeStorage';
      } else {
        await deps.onAudit?.('sourcing:ak-stored-plaintext-fallback', {
          safeStorageAvailable: false,
          at,
          note: 'safeStorage 不可用，AK 以明文落 kv_config（FR-2.7 同款显式降级）',
        });
        await deps.store.kvSet(KV_AK, raw);
        encryption = 'plaintext-fallback';
        warning = 'safeStorage 不可用：AK 已按明文本地保存（已写入审计日志）。建议在支持系统级凭据保护的环境中尽快更换。';
      }
      const masked = maskAkId(parts.accessKeyId);
      const meta: AkMetaJson = { masked, encryption, setAt: at };
      await deps.store.kvSet(KV_AK_META, JSON.stringify(meta));
      return { accessKeyIdMasked: masked, encryption, warning };
    },

    async get() {
      const raw = await readValue();
      if (!raw) return null;
      return extractAkKeys(raw);
    },

    async status() {
      const meta = await readMeta();
      if (!meta) return { configured: false, accessKeyIdMasked: null, encryption: null, setAt: null };
      return {
        configured: true,
        accessKeyIdMasked: meta.masked,
        encryption: meta.encryption,
        setAt: meta.setAt,
      };
    },

    async clear() {
      await deps.store.kvSet(KV_AK, '');
      await deps.store.kvSet(KV_AK_META, '');
    },
  };
}
