/**
 * 裸 CDP-over-pipe 客户端（todo 10 = T-M0-08；S6 结论路线 A 自研形态，不引 playwright-core）。
 *
 * 协议配方来自 bench/s6-debug/a1-pipe-raw.mjs（S6 实测验证，Chrome 154/Edge 155/Electron 33 全过）：
 * - stdin 前的 fd3 写命令、fd4 读响应，JSON 以 `\0` 分帧；
 * - 请求 {id, method, params, sessionId?}；响应 {id, result|error}；事件无 id 带 method。
 *
 * 红线（FR-3.1/02 §5.2）：本客户端只用于受控浏览器的页面导航/目标枚举/事件监听，
 * 禁止实现任何读取 Cookie/Storage/凭据的方法调用路径。
 */

/** CDP JSON-RPC 消息（请求/响应/事件的并集瘦类型） */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

/** 编码一条 CDP 消息为 `\0` 分帧（fd3 写入用） */
export function encodeCdpFrame(message: CdpMessage): Buffer {
  return Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])]);
}

/** 增量解码 fd4 字节流 → 完整 JSON 帧（\0 分帧；畸形帧被跳过并计数，不中断流） */
export class CdpFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  malformedCount = 0;

  push(chunk: Buffer): CdpMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: CdpMessage[] = [];
    for (;;) {
      const zero = this.buffer.indexOf(0);
      if (zero < 0) break;
      const raw = this.buffer.subarray(0, zero).toString('utf8');
      this.buffer = this.buffer.subarray(zero + 1);
      if (raw.length === 0) continue;
      try {
        frames.push(JSON.parse(raw) as CdpMessage);
      } catch {
        this.malformedCount += 1;
      }
    }
    return frames;
  }
}

/** 传输抽象（pipe = child.stdio[3]/[4]；测试用假传输直测关联逻辑） */
export interface CdpTransport {
  write(frame: Buffer): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: (info: { code: number | null }) => void): void;
  onError(handler: (error: Error) => void): void;
  /** 关闭写侧（pipe 语义 = 停止发命令；读侧由子进程退出自然关闭） */
  end(): void;
}

export class CdpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpProtocolError';
  }
}

export interface CdpEventEnvelope {
  method: string;
  params: unknown;
  sessionId?: string;
}

export interface CdpConnectionOptions {
  requestTimeoutMs?: number;
}

interface PendingEntry {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/**
 * CDP 连接：请求-响应按 id 关联；事件经 onEvent 扇出。
 * onClose 供「浏览器进程死亡 → 会话丢失」联动使用（崩溃联动入口，FR-3.4/门禁②）。
 */
export class CdpConnection {
  private readonly pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private closedByUs = false;
  private readonly eventHandlers = new Set<(event: CdpEventEnvelope) => void>();
  private closeInfo: { code: number | null } | null = null;
  private readonly closeWaiters: Array<(info: { code: number | null }) => void> = [];

  readonly timeoutMs: number;

  constructor(private readonly transport: CdpTransport, options: CdpConnectionOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    const decoder = new CdpFrameDecoder();
    transport.onData((chunk) => {
      for (const message of decoder.push(chunk)) this.handleMessage(message);
    });
    transport.onClose((info) => {
      this.closeInfo = info;
      this.failAllPending(`CDP 管道已关闭（exit code=${info.code}）`);
      const waiters = this.closeWaiters.splice(0);
      for (const waiter of waiters) waiter(info);
      this.eventHandlers.clear();
    });
    transport.onError((error) => {
      this.failAllPending(`CDP 管道错误：${error.message}`);
    });
  }

  private handleMessage(message: CdpMessage): void {
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new CdpProtocolError(`CDP ${entry.method} 失败 (${message.error.code}): ${message.error.message}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      const event: CdpEventEnvelope = { method: message.method, params: message.params, sessionId: message.sessionId };
      for (const handler of this.eventHandlers) handler(event);
    }
  }

  private failAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CdpProtocolError(`${reason}（丢弃进行中的 ${entry.method}）`));
    }
    this.pending.clear();
  }

  /** 发送命令并等待响应（flat 协议：sessionId 由 Target.attachToTarget 返回后携带） */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closeInfo) {
      return Promise.reject(new CdpProtocolError(`CDP 连接已关闭，无法发送 ${method}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = encodeCdpFrame({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpProtocolError(`CDP ${method} 响应超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer, method });
      try {
        this.transport.write(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpProtocolError(`CDP ${method} 写入失败：${String((error as Error).message)}`));
      }
    });
  }

  onEvent(handler: (event: CdpEventEnvelope) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** 主动关闭（断开语义：停写 + 等 pipe 断；不杀进程——进程处置归 launcher/service） */
  close(): void {
    if (this.closedByUs) return;
    this.closedByUs = true;
    this.transport.end();
  }

  /** 等待浏览器进程退出（崩溃联动/优雅关闭用）：无超时——真实 close 事件是唯一决断点 */
  waitForClose(): Promise<{ code: number | null }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  get isClosed(): boolean {
    return this.closeInfo !== null;
  }
}
