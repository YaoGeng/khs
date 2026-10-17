/**
 * 收藏/询盘执行服务（T-M2-04；selection DAG 后半——FR-6.3 勾选 → FR-6.4 收藏+询盘
 * （发送前确认弹窗红线）→ FR-6.5 素材留存 + 商品卡片入库）。
 *
 * 红线与边界：
 * - **对外写操作永远人工确认**（FR-6.4/FR-12.7，不受自动化档位影响）：每个候选的收藏与
 *   询盘发送各自经 confirm 闸——push `outreach:confirm` 到渲染层弹窗，用户决定
 *   （confirm/skip/cancel）后落审计事件 OUTREACH_CONFIRM（taskId/offerId/flow/决定/
 *   时间戳，02 §7.5 契约扩展卡语义）。本服务绝无自动确认路径（与 automationTier 无关）。
 * - 不可逆动作核对（S2 语义）：点击后探测成功态特征——命中 = done；未命中 =
 *   clicked-unverified（诚实记录，不判成功；真实成功态选择器待用户在场联调）。
 * - 串行单浏览器（ADR-6）：一次只跑一个批次；浏览器 detached 拒绝起跑（E-OUTREACH-BROWSER）。
 * - 会话窗位点为「合理编写」待联调：等待超时如实记 chat-window-missing，不臆造发送。
 * - 素材留存（FR-6.5）：图集 ≤N 张页内 fetch → userData/materials/<offerId>/，sha256
 *   落库；文案描述（商品详情模块文本）kind=desc 每商品单行。
 * - 商品卡片（§14.1 products）：勾选即入库（upsert，status 不覆盖）；询盘发出 → 对接中。
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '@xinglian/logger';
import { parsePriceRange, parseMonthlySales } from '@xinglian/agents';
import type { StoreClient, MaterialInput } from '../store';
import type { OutreachPort, OfferSession } from '../browser/outreach-port';
import type { PushChannel } from '../shared/channels';

/** 勾选集 kv 键（FR-6.3；task 维度） */
export const checkedKey = (taskId: string): string => `selection:checked:${taskId}`;

/** 询盘话术模板（FR-6.4 三要素：需求数量 + 一件代发询问 + 素材可用于社交平台发布确认） */
export function composeInquiryMessage(title: string, quantity: number): string {
  const short = title.replace(/\s+/g, ' ').trim().slice(0, 40);
  return (
    `您好，我们在做社交电商选品，看到贵司的「${short}」。想咨询：` +
    `① 计划采购数量 ${quantity} 件起，批发价是多少？` +
    `② 是否支持一件代发（我们下单后由您直接发给终端客户）？` +
    `③ 我们计划将商品图片素材用于社交平台内容发布推广，请确认素材是否可用于社交媒体推广？` +
    `期待您的回复，谢谢！`
  );
}

export type OutreachDecision = 'confirm' | 'skip' | 'cancel';

export type OutreachFlow = 'favorite' | 'followShop' | 'inquiry';

/** 单流程执行结果（诚实口径：uncertain 类不算成功也不算失败） */
export type FlowOutcome =
  | 'done'
  | 'clicked-unverified'
  | 'sent'
  | 'sent-unverified'
  | 'skipped'
  | 'button-missing'
  | 'entry-missing'
  | 'chat-window-missing';

export interface OfferOutcome {
  offerId: string;
  title: string;
  favorite: FlowOutcome | null;
  followShop: FlowOutcome | null;
  inquiry: FlowOutcome | null;
  /** 商品卡片入库（FR-6.5） */
  productSaved: boolean;
  materialsSaved: number;
  error?: string;
}

export interface OutreachRunOptions {
  favorite: boolean;
  followShop: boolean;
  inquiry: boolean;
  /** 询盘采购数量（话术模板；弹窗内可改） */
  quantity: number;
}

export interface OutreachRunSummary {
  runId: string;
  taskId: string;
  status: 'completed' | 'cancelled' | 'failed';
  offers: OfferOutcome[];
}

export interface OutreachStatusView {
  active: boolean;
  taskId: string | null;
  phase: string;
  offersDone: number;
  offersTotal: number;
  pendingConfirm: {
    confirmId: string;
    offerId: string;
    offerTitle: string;
    flow: OutreachFlow;
    description: string;
    message: string | null;
    quantity: number | null;
  } | null;
  lastSummary: OutreachRunSummary | null;
}

interface PendingConfirm {
  confirmId: string;
  taskId: string;
  offerId: string;
  offerTitle: string;
  flow: OutreachFlow;
  message: string | null;
  quantity: number | null;
  resolve: (decision: OutreachDecision, message: string | null) => void;
  deadline: number;
  /** 超时兜底句柄（decide 命中即清；超时 = cancel 收口 + 审计，红线动作永不自动决定） */
  timer?: ReturnType<typeof setTimeout>;
}

export interface OutreachServiceDeps {
  readonly store: Pick<
    StoreClient,
    | 'whenReady'
    | 'kvGet'
    | 'kvSet'
    | 'kvDel'
    | 'listSourcingCandidates'
    | 'getTask'
    | 'writeTaskEvent'
    | 'upsertProduct'
    | 'setProductStatus'
    | 'insertMaterials'
    | 'listProducts'
    | 'listMaterials'
  >;
  /** 打开商品页会话（组合根注入：真实 CDP 端口或 fixture 回放） */
  readonly port: () => Promise<OutreachPort>;
  /** 浏览器状态（'detached' 时拒绝起跑；fixture 模式组合根恒报 attached） */
  readonly browserState: () => Promise<string>;
  readonly logger: Logger;
  /** main→renderer 推送（outreach:confirm / outreach:progress） */
  readonly push: (channel: PushChannel, payload: unknown) => void;
  readonly notify?: (title: string, body: string) => void;
  readonly now?: () => number;
  /** 素材留存根目录（组合根 = <userData>/materials） */
  readonly materialsDir: string;
  /** 注入面（单测内存文件系统；缺省 node:fs/promises writeFile + mkdir） */
  readonly writeFile?: (path: string, data: Buffer) => Promise<void>;
  /** 注入面（desc 文案读盘；缺省 node:fs/promises readFile utf8） */
  readonly readFile?: (path: string) => Promise<string>;
  /** 用户确认等待上限（默认 10min；超时按 cancel 收口并审计，不自动决定红线动作） */
  readonly confirmTimeoutMs?: number;
  /** 每 offer 图集下载上限（默认 9） */
  readonly maxMaterialsPerOffer?: number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60_000;

export class OutreachService {
  private readonly deps: OutreachServiceDeps;
  private readonly now: () => number;
  private pending: PendingConfirm | null = null;
  private running = false;
  private lastSummary: OutreachRunSummary | null = null;
  private progress = { taskId: null as string | null, phase: 'idle', done: 0, total: 0 };

  constructor(deps: OutreachServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** FR-6.3 勾选面：task 维度 offerId 集（kv JSON 数组） */
  async setChecked(taskId: string, offerId: string, checked: boolean): Promise<string[]> {
    await this.deps.store.whenReady();
    const raw = await this.deps.store.kvGet(checkedKey(taskId));
    const parsed = safeStringArray(raw);
    const set = new Set<string>(parsed);
    if (checked) set.add(offerId);
    else set.delete(offerId);
    const ids = [...set];
    await this.deps.store.kvSet(checkedKey(taskId), JSON.stringify(ids));
    return ids;
  }

  async listChecked(taskId: string): Promise<string[]> {
    await this.deps.store.whenReady();
    const raw = await this.deps.store.kvGet(checkedKey(taskId));
    return safeStringArray(raw);
  }

  /** 商品卡片读面（FR-6.5 products:list；materials join：imagePaths 为 file:// URL、descText 读盘内容） */
  async listProductCards(filter: { taskId?: string; status?: string; limit?: number } = {}): Promise<
    Array<{
      productId: string;
      title: string;
      priceMin: number | null;
      priceMax: number | null;
      moq: number | null;
      sales: number | null;
      supplier: { name: string | null; address: string | null } | null;
      link: string;
      status: string;
      taskId: string;
      keyword: string | null;
      imagePaths: string[];
      descText: string | null;
      updatedAt: string;
    }>
  > {
    await this.deps.store.whenReady();
    const products = await this.deps.store.listProducts(filter);
    const readDesc = this.deps.readFile ?? defaultReadFile;
    return Promise.all(
      products.map(async (p) => {
        const mats = await this.deps.store.listMaterials(p.productId);
        const descPath = mats.find((m) => m.kind === 'desc')?.path ?? null;
        let descText: string | null = null;
        if (descPath) {
          try {
            descText = (await readDesc(descPath)).slice(0, 4000);
          } catch {
            descText = null;
          }
        }
        return {
          productId: p.productId,
          title: p.title,
          priceMin: p.priceMin,
          priceMax: p.priceMax,
          moq: p.moq,
          sales: p.sales,
          supplier: p.supplier,
          link: p.link,
          status: p.status,
          taskId: p.taskId,
          keyword: p.keyword,
          // 渲染层 file:// 页面可直接引用同源 file:// 图片（窗口经 loadFile 装载）
          imagePaths: mats
            .filter((m) => m.kind === 'image' && m.path !== null)
            .map((m) => pathToFileURL(m.path as string).href),
          descText,
          updatedAt: p.updatedAt,
        };
      }),
    );
  }

  /** 状态查询面（outreach:status；渲染层轮询/重载后对齐） */  status(): OutreachStatusView {
    return {
      active: this.running || this.pending !== null,
      taskId: this.progress.taskId,
      phase: this.pending !== null ? 'awaiting_confirm' : this.progress.phase,
      offersDone: this.progress.done,
      offersTotal: this.progress.total,
      pendingConfirm: this.pending
        ? {
            confirmId: this.pending.confirmId,
            offerId: this.pending.offerId,
            offerTitle: this.pending.offerTitle,
            flow: this.pending.flow,
            description:
              this.pending.flow === 'inquiry'
                ? '询盘发送前确认（FR-6.4 红线：对外发送永远人工确认，不受自动化档位影响）'
                : this.pending.flow === 'favorite'
                  ? '收藏前确认（对外写操作：点击收藏商品）'
                  : '关注店铺确认（对外写操作：点击关注供应商店铺）',
            message: this.pending.message,
            quantity: this.pending.quantity,
          }
        : null,
      lastSummary: this.lastSummary,
    };
  }

  /** 用户决定（outreach:decide）：仅活跃 confirmId 可决；落审计 OUTREACH_CONFIRM */
  async decide(confirmId: string, decision: OutreachDecision, message: string | null): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.confirmId !== confirmId) return false;
    this.pending = null;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const at = new Date().toISOString();
    await this.deps.store.writeTaskEvent({
      taskId: pending.taskId,
      type: 'OUTREACH_CONFIRM',
      fromState: null,
      toState: null,
      payload: {
        confirmId,
        offerId: pending.offerId,
        flow: pending.flow,
        decision,
        at,
        ...(decision === 'confirm' && pending.flow === 'inquiry' ? { message } : {}),
      },
    });
    pending.resolve(decision, decision === 'confirm' ? (message ?? pending.message) : pending.message);
    return true;
  }

  /**
   * 批量执行（outreach:start）：勾选集逐候选串行（ADR-6）——收藏/关注/询盘（各经
   * confirm 闸）→ 素材留存 → 商品卡片入库。任一 cancel 收口整批（已决 offers 保留）。
   */
  async startRun(taskId: string, options: OutreachRunOptions): Promise<OutreachRunSummary> {
    await this.deps.store.whenReady();
    if (this.running || this.pending) {
      throw new Error('E-OUTREACH-BUSY: 已有执行批次在进行（单浏览器串行，ADR-6）');
    }
    const state = await this.deps.browserState();
    if (state === 'detached') {
      throw new Error('E-OUTREACH-BROWSER-DETACHED: 受控浏览器未接管——先在浏览器面板接管 1688');
    }
    const checked = await this.listChecked(taskId);
    if (checked.length === 0) throw new Error('E-OUTREACH-EMPTY: 未勾选任何候选');
    const candidates = await this.deps.store.listSourcingCandidates({ taskId, limit: 50 });
    const byOffer = new Map(candidates.map((c) => [c.offerId, c]));
    const ordered = checked.filter((id) => byOffer.has(id));
    if (ordered.length === 0) throw new Error('E-OUTREACH-NO-CANDIDATE: 勾选 offer 无对应候选（任务候选已变更？）');

    this.running = true;
    this.progress = { taskId, phase: 'running', done: 0, total: ordered.length };
    const runId = randomUUID();
    const runOptions: OutreachRunOptions = { ...options, quantity: Math.max(1, Math.trunc(options.quantity) || 10) };
    await this.audit(taskId, 'OUTREACH_RUN_START', {
      runId, offers: ordered.length, favorite: runOptions.favorite, followShop: runOptions.followShop, inquiry: runOptions.inquiry,
    });
    this.deps.push('outreach:progress' as PushChannel, { taskId, phase: 'running', done: 0, total: ordered.length });

    const outcomes: OfferOutcome[] = [];
    let status: OutreachRunSummary['status'] = 'completed';
    const port = await this.deps.port();
    try {
      for (const offerId of ordered) {
        const row = byOffer.get(offerId)!;
        const outcome = await this.runOffer(port, taskId, runId, runOptions, offerId, row.title, row);
        outcomes.push(outcome);
        this.progress.done += 1;
        if (outcome.error?.startsWith('E-OUTREACH-CANCELLED')) {
          status = 'cancelled';
          break;
        }
      }
      await this.audit(taskId, 'OUTREACH_RUN_DONE', {
        runId,
        status,
        offers: outcomes.map((o) => ({ offerId: o.offerId, favorite: o.favorite, inquiry: o.inquiry, productSaved: o.productSaved })),
      });
    } catch (error) {
      status = 'failed';
      await this.audit(taskId, 'OUTREACH_RUN_DONE', { runId, status, error: String((error as Error).message).slice(0, 200) });
      throw error;
    } finally {
      this.running = false;
      this.progress.phase = 'idle';
    }
    const summary: OutreachRunSummary = { runId, taskId, status, offers: outcomes };
    this.lastSummary = summary;
    this.deps.push('outreach:progress' as PushChannel, { taskId, phase: status, done: outcomes.length, total: ordered.length });
    const sent = outcomes.filter((o) => o.inquiry === 'sent' || o.inquiry === 'sent-unverified').length;
    this.deps.notify?.(
      status === 'completed' ? '收藏/询盘批次完成' : '收藏/询盘批次已取消',
      status === 'completed'
        ? `候选 ${outcomes.length} 个：询盘发出 ${sent}，商品卡片入库 ${outcomes.filter((o) => o.productSaved).length}（详见选品页商品卡片）。`
        : `用户取消：已完成 ${outcomes.length}/${ordered.length}。`,
    );
    return summary;
  }

  /** 单 offer 全流程（收藏/关注/询盘/素材/商品卡片）；cancel 返回带 E-OUTREACH-CANCELLED 的 outcome */
  private async runOffer(
    port: OutreachPort,
    taskId: string,
    runId: string,
    options: OutreachRunOptions,
    offerId: string,
    candidateTitle: string,
    row: { sourceUrl: string | null; priceText: string | null; salesText: string | null; supplierName: string | null; supplierAddress: string | null; dimensions: unknown; keyword: string },
  ): Promise<OfferOutcome> {
    const offerUrl = row.sourceUrl ?? `https://detail.1688.com/offer/${offerId}.html`;
    const outcome: OfferOutcome = {
      offerId, title: candidateTitle, favorite: null, followShop: null, inquiry: null,
      productSaved: false, materialsSaved: 0,
    };
    this.deps.logger.networkMeta('outreach:offer-start', { taskId, runId, offerId });
    let session: OfferSession | null = null;
    try {
      session = await port.openOffer(offerUrl);
      await session.waitForFeature('[class*="module-od-title"] h1', 1);
      const blocked = await session.detectBlocked();
      if (blocked) {
        outcome.error = `blocked:${blocked}`;
        this.deps.logger.networkMeta('outreach:blocked', { offerId, feature: blocked });
        return outcome;
      }

      // 收藏（对外写操作：confirm 闸 → 点击 → 成功态核对）
      if (options.favorite) {
        outcome.favorite = await this.runFlow(session, taskId, offerId, candidateTitle, 'favorite', {
          entry: '[data-click="FAV"]',
          expect: ['[data-click="FAV"]'],
          success: '[class*="favor-done"]',
          doneWord: 'done',
          unverified: 'clicked-unverified',
          missing: 'button-missing',
          postClickWaitMs: 1200,
        });
      }

      // 关注店铺（FR-6.4「收藏店铺/商品」店铺面；同 confirm 闸）
      if (options.followShop) {
        outcome.followShop = await this.runFlow(session, taskId, offerId, candidateTitle, 'followShop', {
          entry: '[data-click="follow-shop"]',
          expect: ['[data-click="follow-shop"]'],
          success: '[class*="follow-done"]',
          doneWord: 'done',
          unverified: 'clicked-unverified',
          missing: 'button-missing',
          postClickWaitMs: 1200,
        });
      }

      // 询盘（FR-6.4 发送前确认弹窗 + 可编辑话术）
      if (options.inquiry) {
        outcome.inquiry = await this.runInquiry(session, taskId, offerId, candidateTitle, options.quantity);
      }

      // 素材留存 + 商品卡片入库（FR-6.5；写操作被 cancel 时不会到达这里）
      const saved = await this.saveProductAndMaterials(session, taskId, offerId, candidateTitle, row);
      outcome.productSaved = saved.productSaved;
      outcome.materialsSaved = saved.materialsSaved;
      if (outcome.inquiry === 'sent' || outcome.inquiry === 'sent-unverified') {
        await this.deps.store.setProductStatus(offerId, '对接中');
      }
      return outcome;
    } catch (error) {
      const message = String((error as Error).message);
      if (message.startsWith('E-OUTREACH-CANCELLED')) {
        outcome.error = message;
        return outcome;
      }
      outcome.error = message.slice(0, 160);
      this.deps.logger.systemError('outreach:offer-failed', { taskId, offerId, error: outcome.error });
      return outcome;
    } finally {
      await session?.close();
      this.deps.push('outreach:progress' as PushChannel, {
        taskId, phase: 'running', done: this.progress.done, total: this.progress.total, offerId,
      });
    }
  }

  /** 通用写流程：入口探测 → confirm 闸 → expect 核验 → 点击 → 成功态核对 */
  private async runFlow(
    session: OfferSession,
    taskId: string,
    offerId: string,
    offerTitle: string,
    flow: OutreachFlow,
    spec: { entry: string; expect: string[]; success: string; doneWord: FlowOutcome; unverified: FlowOutcome; missing: FlowOutcome; postClickWaitMs: number },
  ): Promise<FlowOutcome> {
    const counts = await session.checkFeatures([spec.entry]);
    if ((counts[spec.entry] ?? 0) < 1) {
      this.deps.logger.networkMeta('outreach:flow-missing', { offerId, flow, selector: spec.entry });
      return spec.missing;
    }
    const { decision } = await this.requestConfirm({ taskId, offerId, offerTitle, flow, message: null, quantity: null });
    if (decision === 'cancel') throw new Error('E-OUTREACH-CANCELLED: 用户取消批次');
    if (decision === 'skip') return 'skipped';
    const expect = await session.checkFeatures(spec.expect);
    for (const sel of spec.expect) {
      if ((expect[sel] ?? 0) < 1) {
        // confirm.expect 核验失败 = 平台界面不在场（改版/弹窗被拦）——不执行不可逆动作
        this.deps.logger.systemError('outreach:expect-miss', { offerId, flow, selector: sel });
        throw new Error(`E-OUTREACH-EXPECT-MISS: 确认后特征核验失败 ${flow}:${sel}`);
      }
    }
    await session.click(spec.entry);
    await new Promise((resolve) => setTimeout(resolve, spec.postClickWaitMs));
    const verify = await session.checkFeatures([spec.success]);
    const result = (verify[spec.success] ?? 0) >= 1 ? spec.doneWord : spec.unverified;
    this.deps.logger.networkMeta('outreach:flow-clicked', { offerId, flow, verified: result === 'done' });
    return result;
  }

  /** 询盘流程：入口 → 会话窗（待联调位点：超时诚实记 missing）→ confirm（可编辑话术）→ 键入 → 发送 */
  private async runInquiry(
    session: OfferSession,
    taskId: string,
    offerId: string,
    offerTitle: string,
    quantity: number,
  ): Promise<FlowOutcome> {
    const entryCounts = await session.checkFeatures(['[data-click="咨询客服"]']);
    if ((entryCounts['[data-click="咨询客服"]'] ?? 0) < 1) return 'entry-missing';
    await session.click('[data-click="咨询客服"]');
    const chatSelectors = ['[class*="chat-window"]', '[class*="chat-input"] textarea', '[class*="chat-send"]'];
    try {
      await session.waitForFeature('[class*="chat-window"]', 1, 8_000);
    } catch {
      // 会话窗位点待用户在场联调（真实点击客服后的窗口形态未取证）——如实记录，不臆造
      this.deps.logger.networkMeta('outreach:chat-window-missing', { offerId, note: '会话窗选择器待联调校准' });
      return 'chat-window-missing';
    }
    const counts = await session.checkFeatures(chatSelectors);
    if ((counts['[class*="chat-input"] textarea'] ?? 0) < 1 || (counts['[class*="chat-send"]'] ?? 0) < 1) {
      return 'chat-window-missing';
    }
    const message = composeInquiryMessage(offerTitle, quantity);
    const { decision, message: finalMessage } = await this.requestConfirm({
      taskId, offerId, offerTitle, flow: 'inquiry', message, quantity,
    });
    if (decision === 'cancel') throw new Error('E-OUTREACH-CANCELLED: 用户取消批次');
    if (decision === 'skip') return 'skipped';
    await session.type('[class*="chat-input"] textarea', finalMessage ?? message);
    await session.click('[class*="chat-send"]');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const verify = await session.checkFeatures(['[class*="msg-sent"]']);
    const result = (verify['[class*="msg-sent"]'] ?? 0) >= 1 ? 'sent' : 'sent-unverified';
    this.deps.logger.networkMeta('outreach:inquiry-sent', { offerId, verified: result === 'sent' });
    return result;
  }

  /**
   * confirm 闸：push 弹窗请求 + await 决定（返回决定 + 用户可编辑后的最终话术）。
   * 超时按 cancel 收口并审计 OUTREACH_CONFIRM_TIMEOUT——红线动作无自动确认路径。
   */
  private async requestConfirm(req: {
    taskId: string;
    offerId: string;
    offerTitle: string;
    flow: OutreachFlow;
    message: string | null;
    quantity: number | null;
  }): Promise<{ decision: OutreachDecision; message: string | null }> {
    const timeoutMs = this.deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const confirmId = randomUUID();
    return new Promise((resolve) => {
      const pending: PendingConfirm = {
        confirmId,
        taskId: req.taskId,
        offerId: req.offerId,
        offerTitle: req.offerTitle,
        flow: req.flow,
        message: req.message,
        quantity: req.quantity,
        deadline: this.now() + timeoutMs,
        resolve: (d, m) => resolve({ decision: d, message: m }),
      };
      pending.timer = setTimeout(() => {
        if (this.pending?.confirmId !== confirmId) return;
        this.pending = null;
        void this.deps.store
          .writeTaskEvent({
            taskId: req.taskId,
            type: 'OUTREACH_CONFIRM_TIMEOUT',
            fromState: null,
            toState: null,
            payload: { confirmId, offerId: req.offerId, flow: req.flow, timeoutMs, at: new Date().toISOString() },
          })
          .catch(() => {});
        this.deps.logger.systemError('outreach:confirm-timeout', { offerId: req.offerId, flow: req.flow });
        pending.resolve('cancel', req.message);
      }, timeoutMs);
      this.pending = pending;
      this.deps.push('outreach:confirm' as PushChannel, {
        confirmId,
        offerId: req.offerId,
        offerTitle: req.offerTitle,
        flow: req.flow,
        message: req.message,
        quantity: req.quantity,
        description: this.status().pendingConfirm?.description ?? '',
      });
      this.deps.notify?.(
        '收藏/询盘待确认',
        `候选「${req.offerTitle.slice(0, 24)}」的${req.flow === 'inquiry' ? '询盘发送' : '收藏操作'}等待你的确认。`,
      );
    });
  }

  /** 素材留存 + 商品卡片 upsert（FR-6.5；§14.1 products/materials） */
  private async saveProductAndMaterials(
    session: OfferSession,
    taskId: string,
    offerId: string,
    candidateTitle: string,
    row: { sourceUrl: string | null; priceText: string | null; salesText: string | null; supplierName: string | null; supplierAddress: string | null; dimensions: unknown; keyword: string },
  ): Promise<{ productSaved: boolean; materialsSaved: number }> {
    const detail = await session.extractDetail();
    const price = parsePriceRange(row.priceText ?? detail.priceText);
    const sales = parseMonthlySales(row.salesText ?? detail.salesText);
    const link = row.sourceUrl ?? `https://detail.1688.com/offer/${offerId}.html`;
    try {
      await this.deps.store.upsertProduct({
        productId: offerId,
        title: detail.title ?? candidateTitle,
        priceMin: price?.min ?? null,
        priceMax: price?.max ?? null,
        moq: null,
        sales,
        repurchase: null,
        supplier: {
          name: detail.supplierName ?? row.supplierName ?? null,
          address: row.supplierAddress ?? null,
        },
        scores: row.dimensions ?? null,
        link,
        taskId,
        keyword: row.keyword,
      });
    } catch (error) {
      this.deps.logger.systemError('outreach:product-upsert-failed', { offerId, error: String((error as Error).message).slice(0, 120) });
      return { productSaved: false, materialsSaved: 0 };
    }

    let materialsSaved = 0;
    const rows: MaterialInput[] = [];
    const maxImages = this.deps.maxMaterialsPerOffer ?? 9;
    const dir = join(this.deps.materialsDir, offerId);
    const extOf = (mime: string): string => (mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg');
    for (const [i, src] of detail.gallerySrcs.slice(0, maxImages).entries()) {
      const fetched = await session.fetchAsBase64(src);
      if (!fetched) continue;
      const fileName = `${i + 1}.${extOf(fetched.mime)}`;
      const filePath = join(dir, fileName);
      try {
        const buffer = Buffer.from(fetched.base64, 'base64');
        await (this.deps.writeFile ?? defaultWriteFile)(filePath, buffer);
        rows.push({ productId: offerId, kind: 'image', path: filePath, sourceUrl: src, hash: createHash('sha256').update(buffer).digest('hex') });
      } catch (error) {
        this.deps.logger.systemError('outreach:material-write-failed', { offerId, src: src.slice(0, 80), error: String((error as Error).message).slice(0, 80) });
      }
    }
    // desc 文本本体写盘后再入库（路径随行落库，发布链/卡片读面按 path 取；写盘失败则不入库不臆造）
    if (detail.descText) {
      const descPath = join(dir, 'desc.txt');
      try {
        await (this.deps.writeFile ?? defaultWriteFile)(descPath, Buffer.from(detail.descText, 'utf8'));
        rows.push({ productId: offerId, kind: 'desc', path: descPath, sourceUrl: null, hash: createHash('sha256').update(detail.descText, 'utf8').digest('hex') });
      } catch (error) {
        this.deps.logger.systemError('outreach:desc-write-failed', { offerId, error: String((error as Error).message).slice(0, 80) });
      }
    }
    if (rows.length > 0) {
      try {
        const result = await this.deps.store.insertMaterials(rows);
        materialsSaved = result.inserted;
      } catch (error) {
        this.deps.logger.systemError('outreach:materials-insert-failed', { offerId, error: String((error as Error).message).slice(0, 120) });
      }
    }
    this.deps.logger.networkMeta('outreach:offer-saved', { offerId, images: rows.filter((r) => r.kind === 'image').length, desc: detail.descText !== null });
    return { productSaved: true, materialsSaved };
  }

  private async audit(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.store.writeTaskEvent({ taskId, type, fromState: null, toState: null, payload });
  }
}

async function defaultWriteFile(path: string, data: Buffer): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

/** kv 勾选集解析（字符串形态 JSON 数组；损坏按空集处理，诚实不臆造） */
function safeStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}
