/**
 * 自动化档位（M2 产品卡③；docs/01 FR-12.7）。纯逻辑 electron-free 可单测。
 *
 * 档位语义（两值）：
 * - semi（默认）：关键词闸门等人工确认点保持用户手动点击（01:46 半自动化基线）；
 * - auto：报告⑦章关键词闸门自动确认并推进 selection 占位任务（审计事件 gate:auto-confirmed）。
 *
 * 合规红线（档位边界）：收藏/询盘等对外发送前的人工确认永远保留，不受档位影响；
 * llm_key_config 闸门（要求用户本人配置 Key）永不自动确认。
 */
import type { Logger } from '@xinglian/logger';
import type { StoreClient } from '../store';
import type { AutomationTierId } from '../shared/channels';
import type { AutomationGetTierResult, AutomationSetTierResult } from '../shared/schemas';

/** kv 键（kv_config 单表；与 selection:weights 同分段风格） */
export const KV_AUTOMATION_TIER = 'automation:tier';

export const DEFAULT_AUTOMATION_TIER: AutomationTierId = 'semi';

/** kv 原始值解析（缺失/损坏一律回落 semi——损坏不阻断工作流，只记日志由调用方负责） */
export function parseAutomationTier(raw: string | Buffer | null): AutomationTierId {
  const text = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : '';
  return text === 'auto' ? 'auto' : 'semi';
}

export interface AutomationTierService {
  getTier(): Promise<AutomationGetTierResult>;
  setTier(tier: AutomationTierId): Promise<AutomationSetTierResult>;
}

export interface AutomationTierDeps {
  readonly store: Pick<StoreClient, 'whenReady' | 'kvGet' | 'kvSet'>;
  readonly logger: Pick<Logger, 'userAction'>;
}

export function createAutomationTierService(deps: AutomationTierDeps): AutomationTierService {
  return {
    async getTier() {
      await deps.store.whenReady();
      return { tier: parseAutomationTier(await deps.store.kvGet(KV_AUTOMATION_TIER)) };
    },
    async setTier(tier) {
      await deps.store.whenReady();
      await deps.store.kvSet(KV_AUTOMATION_TIER, tier);
      deps.logger.userAction('automation:tier-set', {
        tier,
        note: tier === 'auto' ? '全自动档：关键词闸门将自动确认（收藏/询盘发送前人工确认保留）' : '半自动档：闸门恢复人工确认',
      });
      return { tier };
    },
  };
}
