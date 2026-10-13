/**
 * CDP 管道编解码与请求-响应关联单测（todo 10 = T-M0-08）。
 * 协议：`\0` 分帧 JSON（bench/s6-debug/a1-pipe-raw.mjs 验证过的线上行为）。
 */
import { describe, expect, it } from 'vitest';
import { CdpConnection, CdpFrameDecoder, CdpProtocolError, encodeCdpFrame, type CdpTransport } from './cdp';
import { EventEmitter } from 'node:events';
function framesToBuffer(...messages: object[]): Buffer {
  return Buffer.concat(messages.map((m) => encodeCdpFrame(m)));
}

describe('encodeCdpFrame / CdpFrameDecoder（帧编解码）', () => {
  it('编码 = JSON + \\0 结尾', () => {
    const buf = encodeCdpFrame({ id: 1, method: 'Browser.getVersion', params: {} });
    expect(buf[buf.length - 1]).toBe(0);
    expect(JSON.parse(buf.subarray(0, -1).toString('utf8'))).toEqual({ id: 1, method: 'Browser.getVersion', params: {} });
  });

  it('增量解码：跨 chunk 分帧、多帧同 chunk、空帧跳过', () => {
    const decoder = new CdpFrameDecoder();
    const a = framesToBuffer({ id: 1 });
    const b = framesToBuffer({ id: 2 }, { id: 3 });
    expect(decoder.push(b)).toEqual([{ id: 2 }, { id: 3 }]); // 多帧同 chunk 一次吐出
    expect(decoder.push(a.subarray(0, 4))).toEqual([]); // 半帧：无完整帧输出
    expect(decoder.push(a.subarray(4))).toEqual([{ id: 1 }]); // 补齐后输出
    expect(decoder.push(Buffer.from([0, 0]))).toEqual([]); // 空帧跳过
    expect(decoder.malformedCount).toBe(0);
  });

  it('畸形 JSON 帧被跳过并计数，不中断流', () => {
    const decoder = new CdpFrameDecoder();
    const garbage = Buffer.concat([Buffer.from('not-json'), Buffer.from([0]), encodeCdpFrame({ id: 9 })]);
    expect(decoder.push(garbage)).toEqual([{ id: 9 }]);
    expect(decoder.malformedCount).toBe(1);
  });
});

/** 可手动推送数据/触发关闭的假传输 */
class FakeTransport extends EventEmitter {
  written: Buffer[] = [];
  ended = false;

  write(frame: Buffer): void {
    this.written.push(frame);
  }
  onData(handler: (chunk: Buffer) => void): void {
    this.on('data', handler);
  }
  onClose(handler: (info: { code: number | null }) => void): void {
    this.on('close', handler);
  }
  onError(handler: (error: Error) => void): void {
    this.on('error', handler);
  }
  end(): void {
    this.ended = true;
  }
  emitData(chunk: Buffer): void {
    this.emit('data', chunk);
  }
  emitClose(code: number | null): void {
    this.emit('close', { code });
  }
}

describe('CdpConnection（请求-响应关联 + 事件扇出）', () => {
  it('send 按 id 关联响应；携带 sessionId（flat 协议）', async () => {
    const transport = new FakeTransport();
    const connection = new CdpConnection(transport);
    const pending = connection.send<{ product: string }>('Browser.getVersion');
    const pending2 = connection.send<{ targetId: string }>('Target.attachToTarget', { targetId: 't1', flatten: true }, 'sess-1');

    const sent = transport.written.map((b) => JSON.parse(b.subarray(0, -1).toString('utf8')));
    expect(sent[0]).toMatchObject({ id: 1, method: 'Browser.getVersion' });
    expect(sent[1]).toMatchObject({ id: 2, method: 'Target.attachToTarget', sessionId: 'sess-1' });

    transport.emitData(encodeCdpFrame({ id: 2, result: { sessionId: 'sess-1', targetId: 't1' } }));
    transport.emitData(encodeCdpFrame({ id: 1, result: { product: 'Chrome/154' } }));
    await expect(pending).resolves.toEqual({ product: 'Chrome/154' });
    await expect(pending2).resolves.toEqual({ sessionId: 'sess-1', targetId: 't1' });
  });

  it('CDP error 响应 → CdpProtocolError（含 method 上下文）', async () => {
    const transport = new FakeTransport();
    const connection = new CdpConnection(transport);
    const pending = connection.send('Page.navigate', { url: 'about:blank' }, 's');
    transport.emitData(encodeCdpFrame({ id: 1, error: { code: -32601, message: 'not found' } }));
    await expect(pending).rejects.toThrow(CdpProtocolError);
    await expect(pending).rejects.toThrow(/Page.navigate/);
  });

  it('响应超时被拒绝，且不影响后续请求', async () => {
    const transport = new FakeTransport();
    const connection = new CdpConnection(transport, { requestTimeoutMs: 30 });
    await expect(connection.send('Slow.method')).rejects.toThrow(/超时/);
    const ok = connection.send('Fast.method');
    transport.emitData(encodeCdpFrame({ id: 2, result: {} }));
    await expect(ok).resolves.toEqual({});
  });

  it('事件扇出：无 id 消息走 onEvent；close 后 pending 全拒', async () => {
    const transport = new FakeTransport();
    const connection = new CdpConnection(transport);
    const events: string[] = [];
    connection.onEvent((event) => events.push(`${event.method}@${event.sessionId ?? ''}`));
    const never = connection.send('Target.getTargets');
    transport.emitData(encodeCdpFrame({ method: 'Target.targetCreated', params: {}, sessionId: 's9' }));
    expect(events).toEqual(['Target.targetCreated@s9']);
    transport.emitClose(1);
    await expect(never).rejects.toThrow(/管道已关闭/);
    expect(connection.isClosed).toBe(true);
    await expect(connection.send('After.close')).rejects.toThrow(/已关闭/);
  });

  it('waitForClose：close 后以 exit code 决断', async () => {
    const transport = new FakeTransport();
    const connection = new CdpConnection(transport);
    let code: number | null = 999;
    connection.waitForClose().then((info) => (code = info.code));
    transport.emitClose(null);
    await new Promise((r) => setTimeout(r, 5));
    expect(code).toBeNull();
  });

  it('close：end 停写（进程处置归 launcher/service 层）', () => {
    const transport = new FakeTransport();
    const connection = new CdpConnection(transport);
    connection.close();
    expect(transport.ended).toBe(true);
  });

  it('pipe 真实流形状：stdio 五元组下 Transport 接口与 Node 流对齐（冒烟）', async () => {
    // 用内存双工模拟 fd3/fd4，验证 onData → 解码 → resolve 全链（不经真实 Chrome）
    const { PassThrough } = await import('node:stream');
    const fd3 = new PassThrough();
    const fd4 = new PassThrough();
    const transport: CdpTransport = {
      write: (frame) => fd3.write(frame),
      onData: (handler) => fd4.on('data', (c: Buffer) => handler(c)),
      onClose: (handler) => fd4.on('end', () => handler({ code: null })),
      onError: (handler) => fd4.on('error', handler),
      end: () => fd3.end(),
    };
    const connection = new CdpConnection(transport);
    const pending = connection.send('Browser.getVersion');
    fd4.write(encodeCdpFrame({ id: 1, result: { product: 'Chrome/154.0' } }));
    await expect(pending).resolves.toEqual({ product: 'Chrome/154.0' });
  });
});
