/**
 * 遥测上报器（todo 9 = T-M1-07 装配面；本文件不改 telemetry-guard 三态语义本体）。
 *
 * 职责：作为 guard 的 fetchFn 注入（compliance-service 装配处，endpoint 来自 env
 * XINGLIAN_TELEMETRY_ENDPOINT，缺省不注入 = 与 M0 完全一致），把 guard 的单事件 wire 体
 * {name, payload, at} 翻译成服务端 v1.2 批量契约 [{consent, event, anon_user_hash, payload, at}]
 * （02 §13:734）并经底层 fetch POST：
 * - consent 恒为 true：guard 仅在同意态（=== true）才调 fetchFn，未同意零网络（守卫语义不变）；
 * - anon_user_hash：安装时随机 id（存 store kv，首次生成）→ HMAC-SHA256 → 64hex 假名
 *   （02 §12.1 匿名口径；HMAC 密钥为本地常量，本地可重放、构建不可逆）；
 * - 失败静默重试 ≤1：网络异常或 ≥500 视为瞬时失败重试一次；仍失败/4xx 不再重试、
 *   绝不上抛（返回合成 Response，guard 侧 sendTelemetry 永不因网络失败 reject——遥测尽力而为）；
 * - 不做 durable outbox/断网重放队列（M5 再议）；payload 原样透传，白名单由服务端强制。
 */
import { createHmac, randomUUID } from 'node:crypto';

/** kv 键：安装随机 id（首次生成后持久化；遥测假名种子，非机密） */
export const ANON_INSTALL_ID_KV_KEY = 'telemetry.anon_install_id';

/**
 * HMAC 密钥本地常量（盐口径：任务书「盐/密钥本地常量」）。
 * 用途仅假名化（防止安装 id 明文上行），与账号体系无关联；不做机密轮换（M1 范围外）。
 */
const ANON_HASH_HMAC_KEY = 'xinglian.telemetry.anon-user-hash.v1';

/** 服务端 v1.2 事件 wire 契约（02 §13:734） */
export interface TelemetryWireEvent {
  readonly consent: true;
  readonly event: string;
  readonly anon_user_hash: string;
  readonly payload: unknown;
  readonly at: string;
}

/** kv 存取最小面（StoreClient 的 kvGet/kvSet；测试桩对齐） */
export interface AnonIdKvStore {
  kvGet(key: string): Promise<string | Buffer | null>;
  kvSet(key: string, value: string | Buffer): Promise<unknown>;
}

/** HMAC-SHA256(密钥, 安装 id) hex 64（64hex 形态契约见 server telemetry.dto） */
export function createAnonUserHash(installId: string): string {
  return createHmac('sha256', ANON_HASH_HMAC_KEY).update(installId, 'utf8').digest('hex');
}

/** 安装随机 id：kv 读→无则生成并持久化；kv 不可用→会话级临时 id（遥测不因存储故障中断） */
export async function resolveInstallId(kv: AnonIdKvStore): Promise<string> {
  try {
    const existing = await kv.kvGet(ANON_INSTALL_ID_KV_KEY);
    if (existing !== null) {
      const id = typeof existing === 'string' ? existing : existing.toString('utf8');
      if (id.length > 0) return id;
    }
    const generated = randomUUID();
    await kv.kvSet(ANON_INSTALL_ID_KV_KEY, generated);
    return generated;
  } catch {
    return randomUUID();
  }
}

export interface TelemetryUploaderDeps {
  /** 上报端点（=guard.endpoint，双处一致由装配处保证） */
  readonly endpoint: string;
  /** 安装 id 持久化面（compliance-service 传入 store client） */
  readonly kv: AnonIdKvStore;
  /** 底层网络实现（缺省 globalThis.fetch；测试注入 mock） */
  readonly fetchFn?: typeof fetch;
}

/**
 * 产出 guard 可用的 fetchFn：输入 guard 的 (url, init)（body={name,payload,at}），
 * 转批量契约后 POST endpoint；失败静默重试 ≤1；任何异常都不上抛（合成 599 Response 兜底）。
 */
export function createTelemetryUploader(deps: TelemetryUploaderDeps): typeof fetch {
  const fetchImpl = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  // 安装 id 进程内只解析一次（kv 读 + HMAC 均为稳定值）
  let anonHashPromise: Promise<string> | null = null;
  const anonUserHash = (): Promise<string> => {
    anonHashPromise ??= resolveInstallId(deps.kv).then(createAnonUserHash);
    return anonHashPromise;
  };

  return async (_url, init) => {
    let batch: TelemetryWireEvent[];
    try {
      const guardBody = JSON.parse(String(init?.body ?? '{}')) as { name?: unknown; payload?: unknown; at?: unknown };
      if (typeof guardBody.name !== 'string' || guardBody.name === '') {
        // guard wire 体不合法：不发垃圾流量（服务端会 400），本地合成失败响应
        return new Response(null, { status: 599 });
      }
      batch = [
        {
          consent: true,
          event: guardBody.name,
          anon_user_hash: await anonUserHash(),
          payload: guardBody.payload ?? null,
          at: typeof guardBody.at === 'string' ? guardBody.at : new Date().toISOString(),
        },
      ];
    } catch {
      return new Response(null, { status: 599 });
    }
    try {
      const request: Parameters<typeof fetchImpl>[1] = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
      };
      let response: Response;
      try {
        response = await fetchImpl(deps.endpoint, request);
      } catch {
        // 瞬时失败（网络异常）：静默重试 ≤1（唯一一次）
        response = await fetchImpl(deps.endpoint, request);
      }
      if (response.status >= 500) {
        // 服务端瞬时不可用：同样只补发一次
        try {
          return await fetchImpl(deps.endpoint, request);
        } catch {
          return new Response(null, { status: 599 });
        }
      }
      return response;
    } catch {
      // 兜底：任何环节失败都不上抛（guard 三态 outcome 语义不被网络层破坏）
      return new Response(null, { status: 599 });
    }
  };
}
