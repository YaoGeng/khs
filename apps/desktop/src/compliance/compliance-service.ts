/**
 * 合规服务 —— main 进程绑定（todo 9 = T-M0-11；FR-1.9 / FR-12.6）。
 *
 * 职责：
 * - consent 四通道（state/acceptEula/rejectEula/setTelemetry）的 main 进程实现；
 *   确认记录持久化**只经 T11 store client**（consents 表，0002 迁移）；
 * - EULA 路由锁的同步快照 isViewAllowed（app:navigate 主进程强制点）——
 *   安全缺省为「锁」（快照未加载/查询失败时工作流视图一律拒绝，宁锁勿放）；
 * - 遥测同意快照 + sendTelemetry 唯一出口（telemetry-guard 装配；M0 无端点不上网）。
 *
 * 本文件不 import electron（store/eulaVersion 由 main.ts 注入），vitest 可直测。
 */
import {
  resolveEulaGate,
  type EulaConsentRow,
  type EulaGateState,
  type TelemetryConsentValue,
} from './eula';
import { createTelemetryGuard, type TelemetryConsent, type TelemetryEvent, type TelemetryGuard, type TelemetryLocalRecord, type TelemetrySendOutcome } from './telemetry-guard';
import type { StoreClient } from '../store/client';
import type { ConsentStateResult } from '../shared/schemas';

/** consent 通道依赖注入面（ipc-core 注册表消费；与 LicenseIpcDeps 同风格） */
export interface ConsentIpcDeps {
  readonly state: () => Promise<ConsentStateResult>;
  readonly acceptEula: (params: { telemetryConsent: boolean }) => Promise<ConsentStateResult>;
  readonly rejectEula: () => Promise<ConsentStateResult>;
  readonly setTelemetry: (params: { enabled: boolean }) => Promise<ConsentStateResult>;
  /** EULA 路由锁同步快照（app:navigate 主进程强制点；安全缺省=锁） */
  readonly isViewAllowed: (view: string) => boolean;
}

export interface ComplianceService {
  readonly ipc: ConsentIpcDeps;
  /** 遥测同意快照（守卫与其他 M0 模块读取；M1 上报器经 sendTelemetry 走唯一出口） */
  readonly telemetryConsent: () => TelemetryConsent;
  /** 全应用遥测发送唯一出口（M0 生产装配无端点：同意态下事件也仅本地留存） */
  readonly sendTelemetry: (event: TelemetryEvent) => Promise<TelemetrySendOutcome>;
  /** store ready 后首次加载快照完成（诊断/测试用；失败不抛——安全缺省仍是锁） */
  readonly whenSnapshotLoaded: Promise<void>;
}

export interface ComplianceServiceDeps {
  readonly store: StoreClient;
  readonly eulaVersion: string;
  /** EULA 路由锁覆盖的视图（main 从 shared 常量注入，保持本模块视图无关可单测） */
  readonly lockedViews: readonly string[];
  /** 本地留痕出口（main.ts 注入 T11 logger；测试注入 spy） */
  readonly onLocalRecord?: (record: TelemetryLocalRecord) => void;
}

type GateSnapshot = { requiresConfirm: boolean; telemetryConsent: TelemetryConsentValue };

function toGateState(state: EulaGateState): ConsentStateResult {
  return {
    eulaVersion: state.eulaVersion,
    eulaStatus: state.eulaStatus,
    requiresConfirm: state.requiresConfirm,
    confirmedVersion: state.confirmedVersion,
    confirmedAt: state.confirmedAt,
    rejectedAt: state.rejectedAt,
    telemetryConsent: state.telemetryConsent,
  };
}

export function createComplianceService(deps: ComplianceServiceDeps): ComplianceService {
  // 安全缺省：快照未加载（或 store 不可用）时工作流视图一律拒绝、遥测一律按未征求处理
  let snapshot: GateSnapshot = { requiresConfirm: true, telemetryConsent: 'unasked' };

  async function loadState(): Promise<ConsentStateResult> {
    await deps.store.whenReady();
    const rows = await deps.store.getLatestConsents();
    const eulaRow: EulaConsentRow | null = rows.eula
      ? {
          action: rows.eula.action,
          eulaVersion: rows.eula.eulaVersion,
          telemetryConsent: rows.eula.telemetryConsent,
          createdAt: rows.eula.createdAt,
        }
      : null;
    const telemetryRow: EulaConsentRow | null = rows.telemetry
      ? {
          action: rows.telemetry.action,
          eulaVersion: rows.telemetry.eulaVersion,
          telemetryConsent: rows.telemetry.telemetryConsent,
          createdAt: rows.telemetry.createdAt,
        }
      : null;
    const state = resolveEulaGate({
      appEulaVersion: deps.eulaVersion,
      eulaRow,
      telemetryRow,
    });
    snapshot = { requiresConfirm: state.requiresConfirm, telemetryConsent: state.telemetryConsent };
    return toGateState(state);
  }

  const whenSnapshotLoaded: Promise<void> = deps.store
    .whenReady()
    .then(() => loadState())
    .then(() => undefined)
    .catch(() => {
      // store 不可用：保持安全缺省（锁 + unasked）；consent:state 调用方会拿到真实错误
    });

  async function putEula(action: 'accepted' | 'rejected', telemetryConsent?: boolean): Promise<ConsentStateResult> {
    await deps.store.whenReady();
    await deps.store.putConsent({
      subject: 'eula',
      action,
      eulaVersion: deps.eulaVersion,
      ...(action === 'accepted' ? { telemetryConsent } : {}),
      at: new Date().toISOString(),
    });
    deps.onLocalRecord?.({
      code: `EULA-${action.toUpperCase()}`,
      msg: action === 'accepted' ? 'EULA 已确认（留痕落 consents 表）' : 'EULA 被拒绝（留痕落 consents 表）',
      payload: { eulaVersion: deps.eulaVersion, telemetryConsent: action === 'accepted' ? telemetryConsent : undefined },
    });
    return loadState();
  }

  const guard: TelemetryGuard = createTelemetryGuard({
    getConsent: (): TelemetryConsent => (snapshot.telemetryConsent === 'granted' ? true : snapshot.telemetryConsent === 'denied' ? false : null),
    onLocalRecord: deps.onLocalRecord,
    // M0 不传 endpoint：不存在任何真实上报通道（M1 T-M1-07 接入时在装配处注入）
  });

  return {
    ipc: {
      state: loadState,
      acceptEula: (params) => putEula('accepted', params.telemetryConsent),
      rejectEula: () => putEula('rejected'),
      async setTelemetry(params) {
        await deps.store.whenReady();
        await deps.store.putConsent({
          subject: 'telemetry',
          action: params.enabled ? 'enabled' : 'disabled',
          telemetryConsent: params.enabled,
          at: new Date().toISOString(),
        });
        deps.onLocalRecord?.({
          code: 'TELEMETRY-CONSENT-CHANGED',
          msg: `遥测同意开关已${params.enabled ? '开启' : '关闭'}（FR-12.6；留痕落 consents 表）`,
          payload: { enabled: params.enabled },
        });
        return loadState();
      },
      isViewAllowed: (view) => !snapshot.requiresConfirm || !deps.lockedViews.includes(view),
    },
    telemetryConsent: () => (snapshot.telemetryConsent === 'granted' ? true : snapshot.telemetryConsent === 'denied' ? false : null),
    sendTelemetry: (event) => guard.sendTelemetry(event),
    whenSnapshotLoaded,
  };
}
