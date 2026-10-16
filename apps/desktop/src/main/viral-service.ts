/**
 * 爆款清单 v1（M2 产品卡②；docs/01 FR-4.7）。纯逻辑 electron-free 可单测。
 *
 * 设计口径（确定性优先，LLM 只做解读）：
 * - 热度分 = 主题内相对分：互动加权值（赞×1 + 藏×5 + 评×3——收藏视为最强购买意向信号）
 *   按主题内最高互动归一到 0-100，再乘发布时间衰减系数（≤7d 1.0 / ≤30d 0.9 / ≤90d 0.75 /
 *   更早 0.5 / 未知 0.75）。纯读时算术，重算幂等，不落中间态到任务检查点之外；
 * - 快照落 kv（viral:v1:<topicId>）：清单 + 审计字段（engagement/recencyFactor 可回放）；
 * - LLM 解读 = 单次 structured 调用逐条一句话（≤160 字）。出站仅 noteId/标题/互动计数，
 *   不含作者与正文（无去标识化面扩充）；半自动档由用户显式点击触发（省 BYOK），
 *   全自动档在 collect-viral 步骤后自动尝试一次（失败不阻断，清单本体已确定性产出）。
 */
import type { Logger } from '@xinglian/logger';
import type { StoreClient, NoteRowView } from '../store';
import type { TaskRunner } from '../tasks';
import type { CollectReportStepContext } from '../tasks/collect-service';
import { KV_AUTOMATION_TIER, parseAutomationTier } from './automation-tier';
import { resolveReportLlmConfig, type ReportLlmConfig, type ReportServiceDeps, type StructuredGateway } from './report-service';
import type {
  ViralGenerateRationaleResult,
  ViralItem,
  ViralListResult,
  ViralRefreshResult,
  ViralSnapshot,
} from '../shared/schemas';

/** 快照 TopN 缺省（清单长度；v1 固定口径，refresh 可调 1-50） */
export const VIRAL_TOP_N_DEFAULT = 10;

export const viralSnapshotKey = (topicId: string): string => `viral:v1:${topicId}`;

/* ------------------------------ 纯函数（导出供单测） ------------------------------ */

/** 互动加权值：赞×1 + 藏×5 + 评×3（收藏 = 购买意向最强信号） */
export function viralEngagement(note: Pick<NoteRowView, 'likes' | 'collects' | 'comments'>): number {
  return note.likes * 1 + note.collects * 5 + note.comments * 3;
}

/** 发布时间解析：ISO/Date.parse 优先；中文相对时间（「3 天前」等）相对 now 近似折算；不可解析 → null */
export function parsePublishedAt(text: string | null, now: Date = new Date()): Date | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) return new Date(direct);
  const relative = /^(\d+)\s*(秒|分钟|分|小时|时|天|日|周|星期|月|年)前$/.exec(trimmed);
  if (relative) {
    const n = Number(relative[1]);
    const unitMs: Record<string, number> = {
      秒: 1_000, 分钟: 60_000, 分: 60_000, 小时: 3_600_000, 时: 3_600_000,
      天: 86_400_000, 日: 86_400_000, 周: 604_800_000, 星期: 604_800_000,
      月: 2_592_000_000, 年: 31_536_000_000,
    };
    const ms = unitMs[relative[2]!];
    if (ms !== undefined) return new Date(now.getTime() - n * ms);
  }
  return null;
}

/** 发布时间衰减系数（相对 now；未知发布时间按中档 0.75 处理） */
export function viralRecencyFactor(publishedAt: string | null, now: Date): number {
  const at = parsePublishedAt(publishedAt, now);
  if (!at) return 0.75;
  const ageDays = (now.getTime() - at.getTime()) / 86_400_000;
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.9;
  if (ageDays <= 90) return 0.75;
  return 0.5;
}

/**
 * 确定性热度初筛：主题内相对分（最高互动归一 × 衰减系数），按分数降序、engagement 平手
 * 决胜，取 TopN。全零互动语料不产生高分假象（分数全 0，仍按 engagement 稳定排序）。
 */
export function computeViralItems(notes: readonly NoteRowView[], now: Date, topN: number): ViralItem[] {
  const scored = notes.map((note) => ({
    noteId: note.noteId,
    title: note.title,
    likes: note.likes,
    collects: note.collects,
    comments: note.comments,
    publishedAt: note.publishedAt,
    engagement: viralEngagement(note),
    recencyFactor: viralRecencyFactor(note.publishedAt, now),
    score: 0,
  }));
  const maxEngagement = scored.reduce((m, n) => Math.max(m, n.engagement), 0);
  for (const item of scored) {
    const normalized = maxEngagement > 0 ? item.engagement / maxEngagement : 0;
    item.score = Math.round(100 * normalized * item.recencyFactor);
  }
  scored.sort((a, b) => b.score - a.score || b.engagement - a.engagement || (a.noteId < b.noteId ? -1 : 1));
  return scored.slice(0, Math.max(1, topN)).map((item) => ({ ...item })) as ViralItem[];
}

function emptySnapshot(topicId: string, now: Date): ViralSnapshot {
  return { topicId, generatedAt: now.toISOString(), topN: VIRAL_TOP_N_DEFAULT, sampleSize: 0, items: [], rationale: null };
}

async function readSnapshot(store: Pick<StoreClient, 'kvGet'>, topicId: string): Promise<ViralSnapshot | null> {
  const raw = await store.kvGet(viralSnapshotKey(topicId));
  const text = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : null;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as ViralSnapshot;
    return parsed && Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ViralServiceDeps {
  readonly store: Pick<StoreClient, 'whenReady' | 'listNotes' | 'kvGet' | 'kvSet' | 'listTasks'>;
  readonly runner: Pick<TaskRunner, 'listTaskViews'>;
  readonly logger: Logger;
  /** LLM 解读面（缺省 = generateRationale 恒报未配置；确定性清单不受影响） */
  readonly readKeyEntry?: ReportServiceDeps['readKeyEntry'];
  readonly createGateway?: (config: ReportLlmConfig) => StructuredGateway;
  readonly now?: () => Date;
}

export interface ViralService {
  /** 读面：快照或空态（topicId 缺省 = 最近一次 collect 任务的主题） */
  listSnapshot(topicId?: string): Promise<ViralListResult>;
  /** 重算确定性清单（保留仍在榜笔记的既有解读） */
  refresh(topicId?: string, topN?: number): Promise<ViralRefreshResult>;
  /** collect 管道 collect-viral 步骤主体（确定性重算；全自动档附送一次 LLM 解读） */
  runCollectViralStep(ctx: CollectReportStepContext): Promise<Record<string, unknown>>;
  /** 单次 LLM 调用生成逐条解读（半自动档 = 用户显式点击触发） */
  generateRationale(topicId?: string): Promise<ViralGenerateRationaleResult>;
}

export function createViralService(deps: ViralServiceDeps): ViralService {
  const now = deps.now ?? (() => new Date());

  /** topicId 缺省解析：最近一次 collect 任务（createdAt 降序首个）的主题 */
  async function resolveTopicId(topicId?: string): Promise<string | null> {
    if (topicId) return topicId;
    const views = await deps.runner.listTaskViews();
    const latest = views
      .filter((t) => t.kind === 'collect')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!latest) return null;
    const payload = (latest.payload as { collect?: { topicId?: string } } | null)?.collect;
    return payload?.topicId ?? null;
  }

  async function computeSnapshot(topicId: string, topN: number): Promise<ViralSnapshot> {
    const notes = await deps.store.listNotes({ topicId, limit: 500 });
    const items = computeViralItems(notes, now(), topN);
    const previous = await readSnapshot(deps.store, topicId);
    // 仍在榜的笔记保留既有解读（重算不抹掉已付费的 LLM 产物）
    const rationale =
      previous?.rationale && items.some((i) => previous.rationale!.notes[i.noteId] !== undefined)
        ? { ...previous.rationale, notes: Object.fromEntries(items.map((i) => [i.noteId, previous.rationale!.notes[i.noteId]]).filter(([, v]) => v !== undefined)) }
        : null;
    return { topicId, generatedAt: now().toISOString(), topN, sampleSize: notes.length, items, rationale };
  }

  async function saveSnapshot(snapshot: ViralSnapshot): Promise<void> {
    await deps.store.kvSet(viralSnapshotKey(snapshot.topicId), JSON.stringify(snapshot));
  }

  async function requestRationale(snapshot: ViralSnapshot): Promise<ViralSnapshot> {
    if (snapshot.items.length === 0 || !deps.readKeyEntry || !deps.createGateway) return snapshot;
    const config = await resolveReportLlmConfig(deps.store, deps.readKeyEntry);
    if (!config) return snapshot;
    const targets = snapshot.items.filter((item) => (item.title ?? '').trim().length > 0);
    if (targets.length === 0) return snapshot;

    const gateway = deps.createGateway(config);
    const { value } = await gateway.structured({
      name: 'viral-rationale',
      system:
        '你是小红书选品助手。对下列高互动笔记逐条给出「为什么会爆」的一句话解读（≤80 字，' +
        '聚焦人群/场景/卖点/内容形态，不夸大、不编造数据）。只输出 JSON。',
      user: JSON.stringify({
        topicId: snapshot.topicId,
        notes: targets.map((t) => ({ noteId: t.noteId, title: t.title, likes: t.likes, collects: t.collects, comments: t.comments })),
      }),
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { noteId: { type: 'string' }, reason: { type: 'string' } },
              required: ['noteId', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      parse: (raw) => {
        const list = (raw as { items?: Array<{ noteId?: unknown; reason?: unknown }> }).items ?? [];
        const known = new Set(targets.map((t) => t.noteId));
        const notes: Record<string, string> = {};
        for (const entry of list) {
          if (typeof entry.noteId !== 'string' || !known.has(entry.noteId)) continue;
          if (typeof entry.reason !== 'string') continue;
          const reason = entry.reason.trim().slice(0, 160);
          if (reason.length > 0) notes[entry.noteId] = reason;
        }
        return { notes };
      },
      temperature: 0.2,
      maxTokens: 1024,
    });

    const previousNotes = snapshot.rationale?.notes ?? {};
    const mergedNotes = { ...previousNotes, ...value.notes };
    return {
      ...snapshot,
      rationale:
        Object.keys(mergedNotes).length > 0
          ? { notes: mergedNotes, generatedAt: now().toISOString(), model: config.model }
          : null,
    };
  }

  return {
    async listSnapshot(topicId) {
      await deps.store.whenReady();
      const resolved = await resolveTopicId(topicId);
      if (!resolved) return { snapshot: emptySnapshot('', now()) };
      const snapshot = (await readSnapshot(deps.store, resolved)) ?? emptySnapshot(resolved, now());
      return { snapshot };
    },

    async refresh(topicId, topN) {
      await deps.store.whenReady();
      const resolved = await resolveTopicId(topicId);
      if (!resolved) throw new Error('E-VIRAL-NO-TOPIC: 尚无采集任务，无法确定爆款清单主题');
      const snapshot = await computeSnapshot(resolved, topN ?? VIRAL_TOP_N_DEFAULT);
      await saveSnapshot(snapshot);
      deps.logger.automationStep('viral:refreshed', { topicId: resolved, items: snapshot.items.length, sampleSize: snapshot.sampleSize });
      return { snapshot };
    },

    async runCollectViralStep(ctx) {
      const { payload } = ctx;
      const snapshot = await computeSnapshot(payload.topicId, VIRAL_TOP_N_DEFAULT);
      await saveSnapshot(snapshot);
      ctx.logger.automationStep('collect:viral-list-refreshed', {
        taskId: ctx.taskId,
        topicId: payload.topicId,
        items: snapshot.items.length,
        sampleSize: snapshot.sampleSize,
      });
      // 全自动档附送一次 LLM 解读（失败不阻断——清单本体已确定性产出）
      const tier = parseAutomationTier(await deps.store.kvGet(KV_AUTOMATION_TIER));
      let rationaleGenerated = false;
      if (tier === 'auto') {
        try {
          const withRationale = await requestRationale(snapshot);
          if (withRationale.rationale) {
            await saveSnapshot(withRationale);
            rationaleGenerated = true;
            ctx.logger.automationStep('collect:viral-rationale-auto', {
              taskId: ctx.taskId,
              topicId: payload.topicId,
              notes: Object.keys(withRationale.rationale.notes).length,
              note: '全自动档自动解读（单次调用）',
            });
          }
        } catch (error) {
          ctx.logger.systemError('collect:viral-rationale-auto-failed', { taskId: ctx.taskId, err: String((error as Error).message).slice(0, 200) });
        }
      }
      return { topicId: payload.topicId, items: snapshot.items.length, sampleSize: snapshot.sampleSize, rationaleGenerated };
    },

    async generateRationale(topicId) {
      await deps.store.whenReady();
      if (!deps.readKeyEntry || !deps.createGateway) {
        throw new Error('E-VIRAL-LLM-NOT-CONFIGURED: LLM 解读链路未装配');
      }
      const resolved = await resolveTopicId(topicId);
      if (!resolved) throw new Error('E-VIRAL-NO-TOPIC: 尚无采集任务，无法确定爆款清单主题');
      let snapshot = (await readSnapshot(deps.store, resolved)) ?? emptySnapshot(resolved, now());
      if (snapshot.items.length === 0) {
        snapshot = (await this.refresh(resolved)).snapshot;
      }
      if (snapshot.items.length === 0) {
        return { snapshot, llmCall: false, reason: 'no-items（该主题暂无已采集笔记）' };
      }
      const config = await resolveReportLlmConfig(deps.store, deps.readKeyEntry);
      if (!config) {
        throw new Error('E-VIRAL-LLM-NOT-CONFIGURED: 未检测到可用的 LLM API Key——请在「设置 → LLM 服务商与 API Key」保存后重试');
      }
      const withRationale = await requestRationale(snapshot);
      await saveSnapshot(withRationale);
      const covered = Object.keys(withRationale.rationale?.notes ?? {}).length;
      deps.logger.userAction('viral:rationale-generated', { topicId: resolved, covered, model: config.model, note: '单次 LLM 调用（BYOK）' });
      return {
        snapshot: withRationale,
        llmCall: true,
        reason: covered > 0 ? null : 'llm-empty（模型未返回可用解读，清单不受影响）',
      };
    },
  };
}
