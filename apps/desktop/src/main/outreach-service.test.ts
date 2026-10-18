/**
 * 收藏/询盘执行服务单测（T-M2-04）：fixture 端口 + 内存 store/fs 的全状态面——
 *   ① FR-6.3 勾选集 kv 往返；
 *   ② FR-6.4 红线：每候选 confirm 闸（confirm/skip/cancel 三路 + 超时 cancel + 审计），
 *      无自动确认路径；cancel 收口整批；
 *   ③ S2 语义：成功态命中=done、未命中=clicked-unverified（诚实不臆造）；
 *   ④ 会话窗待联调位点超时 = chat-window-missing（不臆造发送）；
 *   ⑤ FR-6.5：商品卡片 upsert + 素材写盘落库 + 询盘发出→对接中；
 *   ⑥ 话术模板 FR-6.4 三要素（需求数量/一件代发/素材授权）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@xinglian/logger';
import { OutreachService, composeInquiryMessage, type OutreachRunSummary } from './outreach-service';
import { createFixtureOutreachPort, type FixtureOutreachOptions } from '../browser/outreach-port';
import type { PushChannel } from '../shared/channels';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'xinglian-outreach-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noopLogger: Logger = {
  systemError: () => {},
  userAction: () => {},
  networkMeta: () => {},
  automationStep: () => {},
} as unknown as Logger;

interface TaskRow {
  id: string;
  status: string;
}

/** 内存 store（只实现 OutreachService 依赖面；事件/商品/素材落内存数组供断言） */
function memoryStore(options: { candidates: Array<Record<string, unknown>> } = { candidates: [] }) {
  const kv = new Map<string, string>();
  const events: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
  const products = new Map<string, Record<string, unknown>>();
  const productStatus = new Map<string, string>();
  const materials: Array<Record<string, unknown>> = [];
  const store = {
    whenReady: async () => {},
    kvGet: async (key: string) => kv.get(key) ?? null,
    kvSet: async (key: string, value: string) => {
      kv.set(key, value);
      return { set: true };
    },
    kvDel: async (key: string) => {
      kv.delete(key);
      return { deleted: true };
    },
    listSourcingCandidates: async () => options.candidates,
    getTask: async (taskId: string) => ({ id: taskId, status: 'completed' }) as unknown as TaskRow,
    writeTaskEvent: async (event: { taskId: string; type: string; payload: Record<string, unknown> }) => {
      events.push(event);
      return { written: true, id: events.length };
    },
    upsertProduct: async (product: Record<string, unknown>) => {
      products.set(product.productId as string, product);
      return { productId: product.productId as string };
    },
    setProductStatus: async (productId: string, status: string) => {
      productStatus.set(productId, status);
      return { productId, status };
    },
    insertMaterials: async (rows: Array<Record<string, unknown>>) => {
      // image 去重 + desc 替换的 worker 语义在 worker 单测覆盖；这里直记
      for (const row of rows) materials.push(row);
      return { inserted: rows.length };
    },
    listProducts: async () => [...products.values()],
    listMaterials: async () => materials,
  };
  return { store, kv, events, products, productStatus, materials };
}

interface HarnessOptions {
  candidates?: Array<Record<string, unknown>>;
  fixture?: FixtureOutreachOptions;
  files?: Map<string, string>;
  confirmTimeoutMs?: number;
}

function harness(options: HarnessOptions = {}) {
  const mem = memoryStore({ candidates: options.candidates ?? defaultCandidates() });
  const files = options.files ?? new Map<string, string>();
  const pushes: Array<{ channel: PushChannel; payload: unknown }> = [];
  const service = new OutreachService({
    store: mem.store as never,
    port: () => Promise.resolve(createFixtureOutreachPort(options.fixture)),
    browserState: () => Promise.resolve('attached'),
    logger: noopLogger,
    push: (channel, payload) => {
      pushes.push({ channel, payload });
    },
    materialsDir: path.join(dir, 'materials'),
    writeFile: async (p, data) => {
      files.set(p, data.toString('utf8'));
    },
    readFile: async (p) => files.get(p) ?? '',
    confirmTimeoutMs: options.confirmTimeoutMs,
    offerGapMs: 0,
    delay: async () => {},
  });
  return { service, mem, files, pushes };
}

function defaultCandidates(): Array<Record<string, unknown>> {
  return [
    {
      taskId: 'task-1',
      offerId: '880000000001',
      title: '冰丝防晒帽女夏季UPF50+渔夫帽大头围',
      priceText: '¥3.5',
      salesText: '3.4万+件',
      supplierName: '台州市椒江顺新鞋帽厂',
      supplierAddress: '浙江 台州',
      sourceUrl: 'https://detail.1688.com/offer/880000000001.html',
      dimensions: [{ name: 'relevance', title: '关键词相关性', score: 100, weight: 0.3, reason: '标题完整含词' }],
      keyword: '防晒帽',
    },
    {
      taskId: 'task-1',
      offerId: '880000000002',
      title: '防晒帽男透气薄款空顶帽户外遮阳',
      priceText: '¥2.8',
      salesText: '1.0万+件',
      supplierName: '义乌市沐原服装有限公司',
      supplierAddress: null,
      sourceUrl: 'https://detail.1688.com/offer/880000000002.html',
      dimensions: [{ name: 'relevance', title: '关键词相关性', score: 88, weight: 0.3, reason: 'bigram 覆盖' }],
      keyword: '防晒帽',
    },
  ];
}

/** push(outreach:confirm) → decide 自动应答器（按 flow 预设决定） */
function autoDecide(service: OutreachService, decide: (flow: string, confirmId: string) => 'confirm' | 'skip' | 'cancel' | Promise<'confirm' | 'skip' | 'cancel'>, edits?: Map<string, string>): () => void {
  const handler = (payload: unknown): void => {
    const req = payload as { confirmId: string; flow: string; offerId: string };
    void (async () => {
      const decision = await decide(req.flow, req.confirmId);
      await service.decide(req.confirmId, decision, decision === 'confirm' ? (edits?.get(req.offerId) ?? null) : null);
    })();
  };
  const original = (service as unknown as { deps: { push: (channel: PushChannel, payload: unknown) => void } }).deps;
  const wrapped = original.push;
  // 包装：确认推送触发自动应答（progress 原样放行）
  (service as unknown as { deps: { push: (channel: PushChannel, payload: unknown) => void } }).deps.push = (channel, payload) => {
    wrapped(channel, payload);
    if (channel === 'outreach:confirm') handler(payload);
  };
  return () => {
    (service as unknown as { deps: { push: (channel: PushChannel, payload: unknown) => void } }).deps.push = wrapped;
  };
}

describe('T-M2-04 勾选面（FR-6.3）', () => {
  it('setChecked/listChecked 往返：加勾/取消/去重', async () => {
    const { service } = harness();
    const after1 = await service.setChecked('task-1', '880000000001', true);
    expect(after1).toEqual(['880000000001']);
    await service.setChecked('task-1', '880000000002', true);
    await service.setChecked('task-1', '880000000002', true);
    const all = await service.listChecked('task-1');
    expect(all.sort()).toEqual(['880000000001', '880000000002']);
    await service.setChecked('task-1', '880000000001', false);
    expect(await service.listChecked('task-1')).toEqual(['880000000002']);
    expect(await service.listChecked('task-2')).toEqual([]);
  });
});

describe('T-M2-04 批量执行（FR-6.4 confirm 红线 + FR-6.5 入库）', () => {
  it('全确认 happy path：收藏 done + 询盘 sent + 商品卡片 + 素材落库 + 状态对接中 + 审计链', async () => {
    const { service, mem, files, pushes } = harness();
    await service.setChecked('task-1', '880000000001', true);
    const restore = autoDecide(service, () => 'confirm', new Map([['880000000001', '编辑后话术：请报价']]));

    const summary: OutreachRunSummary = await service.startRun('task-1', {
      favorite: true, followShop: false, inquiry: true, quantity: 25,
    });
    restore();

    expect(summary.status).toBe('completed');
    const offer = summary.offers[0];
    expect(offer?.favorite).toBe('done');
    expect(offer?.inquiry).toBe('sent');
    expect(offer?.productSaved).toBe(true);
    expect(offer?.materialsSaved).toBeGreaterThan(0);

    // 商品卡片（FR-6.5）：价格/销量解析入库 + 询盘发出 → 对接中
    const card = await service.listProductCards({ taskId: 'task-1' });
    expect(card).toHaveLength(1);
    expect(card[0]?.productId).toBe('880000000001');
    expect(card[0]?.priceMin).toBe(3.5);
    expect(card[0]?.sales).toBe(34_000);
    expect(mem.productStatus.get('880000000001')).toBe('对接中');
    // desc.txt 写盘 + 读面回读（FR-6.5 文案描述留存）
    expect(files.get(path.join(dir, 'materials', '880000000001', 'desc.txt'))).toContain('fixture 商品详情');
    expect(card[0]?.descText).toContain('fixture 商品详情');

    // 红线审计：每次人工确认一条 OUTREACH_CONFIRM（taskId/offerId/flow/决定）
    const confirms = mem.events.filter((e) => e.type === 'OUTREACH_CONFIRM');
    expect(confirms.map((e) => e.payload.flow).sort()).toEqual(['favorite', 'inquiry']);
    expect(confirms.every((e) => e.payload.offerId === '880000000001' && e.payload.decision === 'confirm')).toBe(true);
    expect(mem.events.some((e) => e.type === 'OUTREACH_RUN_START')).toBe(true);
    expect(mem.events.some((e) => e.type === 'OUTREACH_RUN_DONE')).toBe(true);

    // 确认推送 + 进度推送都发过
    expect(pushes.some((p) => p.channel === 'outreach:confirm')).toBe(true);
    expect(pushes.some((p) => p.channel === 'outreach:progress')).toBe(true);
  });

  it('确认弹窗携带预填话术（FR-6.4 三要素）且用户可编辑后发送', async () => {
    const { service } = harness();
    await service.setChecked('task-1', '880000000001', true);
    let pushedMessage: string | null = null;
    const restore = autoDecide(service, () => 'confirm', new Map([['880000000001', '自定义话术']])); 
    // 捕获确认推送的 message（预填话术）
    const origPush = (service as unknown as { deps: { push: (c: PushChannel, p: unknown) => void } }).deps.push;
    (service as unknown as { deps: { push: (c: PushChannel, p: unknown) => void } }).deps.push = (c, p) => {
      if (c === 'outreach:confirm') pushedMessage = (p as { message: string | null }).message;
      origPush(c, p);
    };

    await service.startRun('task-1', { favorite: false, followShop: false, inquiry: true, quantity: 12 });

    expect(pushedMessage).toContain('12 件');
    expect(pushedMessage).toContain('一件代发');
    expect(pushedMessage).toContain('社交');
    restore();
  });

  it('skip：跳过收藏与询盘（审计 skip）但商品卡片仍入库、状态保持候选', async () => {
    const { service, mem } = harness();
    await service.setChecked('task-1', '880000000001', true);
    const restore = autoDecide(service, () => 'skip');

    const summary = await service.startRun('task-1', { favorite: true, followShop: false, inquiry: true, quantity: 10 });
    restore();

    expect(summary.offers[0]?.favorite).toBe('skipped');
    expect(summary.offers[0]?.inquiry).toBe('skipped');
    expect(summary.offers[0]?.productSaved).toBe(true);
    expect(mem.productStatus.size).toBe(0);
    const confirms = mem.events.filter((e) => e.type === 'OUTREACH_CONFIRM');
    expect(confirms.every((e) => e.payload.decision === 'skip')).toBe(true);
  });

  it('cancel：首个确认即取消整批，后续候选不执行（审计 cancel）', async () => {
    const { service, mem } = harness();
    await service.setChecked('task-1', '880000000001', true);
    await service.setChecked('task-1', '880000000002', true);
    const restore = autoDecide(service, () => 'cancel');

    const summary = await service.startRun('task-1', { favorite: true, followShop: false, inquiry: false, quantity: 10 });
    restore();

    expect(summary.status).toBe('cancelled');
    expect(summary.offers).toHaveLength(1);
    expect(mem.products.size).toBe(0);
    expect(mem.events.filter((e) => e.type === 'OUTREACH_CONFIRM')[0]?.payload.decision).toBe('cancel');
  });

  it('确认超时：按 cancel 收口并审计 OUTREACH_CONFIRM_TIMEOUT（红线动作无自动确认）', async () => {
    const { service, mem } = harness({ confirmTimeoutMs: 30 });
    await service.setChecked('task-1', '880000000001', true);
    // 不自动应答：等超时
    const summary = await service.startRun('task-1', { favorite: true, followShop: false, inquiry: false, quantity: 10 });
    expect(summary.status).toBe('cancelled');
    expect(mem.events.some((e) => e.type === 'OUTREACH_CONFIRM_TIMEOUT')).toBe(true);
  }, 10_000);

  it('风控信号中止整批：risk-blocked 候选即停 + OUTREACH_RISK_ABORT 审计 + 后续候选不执行', async () => {
    const { service, mem } = harness({ fixture: { features: { '[class*="module-od-title"] h1': -1 } } });
    // 仅第二个候选命中风控特征（覆盖默认特征集，首候选仍正常）——用 features 合并语义不可行，
    // fixture 的 features 是整表覆盖，故用单候选批 + 第二轮语义验证中止逻辑即已覆盖循环 break。
    await service.setChecked('task-1', '880000000001', true);
    await service.setChecked('task-1', '880000000002', true);
    const restore = autoDecide(service, () => 'confirm');
    // fixture features 为整表：-1 使两个候选都在详情等待期命中风控 → 首个即中止
    const summary = await service.startRun('task-1', { favorite: false, followShop: false, inquiry: false, quantity: 10 });
    restore();
    expect(summary.status).toBe('cancelled');
    expect(summary.offers).toHaveLength(1);
    expect(summary.offers[0]?.error).toMatch(/^risk-blocked:/);
    expect(summary.offers[0]?.productSaved).toBe(false);
    expect(mem.events.some((e) => e.type === 'OUTREACH_RISK_ABORT')).toBe(true);
    expect(mem.products.size).toBe(0);
  });

  it('会话窗待联调位点超时 → chat-window-missing（诚实不臆造发送）', async () => {
    const { service } = harness({ fixture: { chatWindowMissing: true } });
    await service.setChecked('task-1', '880000000001', true);
    const restore = autoDecide(service, () => 'confirm');

    const summary = await service.startRun('task-1', { favorite: false, followShop: false, inquiry: true, quantity: 10 });
    restore();

    expect(summary.offers[0]?.inquiry).toBe('chat-window-missing');
    expect(summary.offers[0]?.productSaved).toBe(true);
  });

  it('浏览器未接管拒绝起跑；无勾选拒绝；并发批次拒绝（ADR-6）', async () => {
    const mem = memoryStore({ candidates: defaultCandidates() });
    const service = new OutreachService({
      store: mem.store as never,
      port: () => Promise.resolve(createFixtureOutreachPort()),
      browserState: () => Promise.resolve('detached'),
      logger: noopLogger,
      push: () => {},
      materialsDir: path.join(dir, 'materials'),
    });
    await expect(service.startRun('task-1', { favorite: true, followShop: false, inquiry: true, quantity: 10 }))
      .rejects.toThrow('E-OUTREACH-BROWSER-DETACHED');

    const { service: s2 } = harness();
    await expect(s2.startRun('task-1', { favorite: true, followShop: false, inquiry: true, quantity: 10 }))
      .rejects.toThrow('E-OUTREACH-EMPTY');

    const { service: s3 } = harness();
    await s3.setChecked('task-1', '880000000001', true);
    // 长跑批次（不自动应答 confirm → 挂在确认闸）期间再次 start → BUSY
    const bg = s3.startRun('task-1', { favorite: true, followShop: false, inquiry: false, quantity: 10 }).catch(() => 'cancelled');
    await new Promise((r) => setTimeout(r, 30));
    await expect(s3.startRun('task-1', { favorite: true, followShop: false, inquiry: false, quantity: 10 }))
      .rejects.toThrow('E-OUTREACH-BUSY');
    // 收口：取消挂起确认
    const status = s3.status();
    if (status.pendingConfirm) await s3.decide(status.pendingConfirm.confirmId, 'cancel', null);
    await bg;
  });
});

describe('T-M2-04 话术模板（FR-6.4 三要素）', () => {
  it('composeInquiryMessage：需求数量 + 一件代发询问 + 素材授权确认，标题截断 40 字', () => {
    const msg = composeInquiryMessage('冰丝防晒帽女夏季UPF50+渔夫帽大头围遮阳帽大帽檐空顶帽透气批发', 30);
    expect(msg).toContain('30 件');
    expect(msg).toContain('一件代发');
    expect(msg).toContain('社交平台');
    expect(msg).toContain('素材');
    const short = composeInquiryMessage('短标题', 5);
    expect(short).toContain('「短标题」');
  });
});
