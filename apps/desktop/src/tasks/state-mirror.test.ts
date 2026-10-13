/**
 * M1 扩态五面镜像断言（m1-insight-plan todo 7 验收①；五面任一漏改即测试红）：
 * ① machine.ts 枚举/迁移表（含 queued/awaiting_user/yielded/paused）
 * ② runner.ts boot 恢复谓词（yielded/paused→suspended、awaiting_user 保留）
 * ③ store protocol TaskStatus 值域（TASK_STATUS_VALUES）
 * ④ worker task_events/updateTaskStatus 值域校验（真库直测）
 * ⑤ preload/render 面 shared/schemas TASK_STATUSES_SCHEMA
 */
import { describe, expect, it } from 'vitest';
import { BOOT_RECOVERABLE_STATES, resolveTransition, TASK_STATES } from './machine';
import { TASK_STATUS_VALUES } from '../store/protocol';
import { TASK_STATUSES_SCHEMA } from '../shared/schemas';
import { handleStoreRequest } from '../store/worker';
import { openAndMigrate } from '../store/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SqliteDatabase } from 'better-sqlite3';

const M1_STATES = ['queued', 'awaiting_user', 'yielded', 'paused'] as const;

describe('五面镜像（todo 7 扩态）', () => {
  it('面①↔③：machine.TASK_STATES === store.TASK_STATUS_VALUES', () => {
    expect([...TASK_STATES]).toEqual([...TASK_STATUS_VALUES]);
  });

  it('面①↔⑤：machine.TASK_STATES === shared/schemas.TASK_STATUSES_SCHEMA', () => {
    expect([...TASK_STATES]).toEqual([...TASK_STATUSES_SCHEMA]);
  });

  it('面①：M1 四态在枚举内且既有六态语义不变', () => {
    for (const state of M1_STATES) expect(TASK_STATES).toContain(state);
    expect(TASK_STATES.filter((s) => !(M1_STATES as readonly string[]).includes(s))).toEqual([
      'idle',
      'running',
      'suspended',
      'completed',
      'failed',
      'cancelled',
    ]);
    // queued/awaiting_user/yielded/paused 的关键迁移（详表见 runner.test.ts）
    expect(resolveTransition('idle', { type: 'TASK_ENQUEUE' }, { taskId: 't', kind: 'collect' })).toBe('queued');
    expect(resolveTransition('running', { type: 'TASK_YIELD', reason: 'r' }, { taskId: 't', kind: 'collect' })).toBe('yielded');
    expect(resolveTransition('running', { type: 'TASK_PAUSE', reason: 'r' }, { taskId: 't', kind: 'collect' })).toBe('paused');
    expect(resolveTransition('running', { type: 'TASK_AWAIT_USER', reason: 'r' }, { taskId: 't', kind: 'collect' })).toBe('awaiting_user');
    expect(resolveTransition('yielded', { type: 'TASK_RESUME' }, { taskId: 't', kind: 'collect' })).toBe('running');
    expect(resolveTransition('paused', { type: 'TASK_RESUME' }, { taskId: 't', kind: 'collect' })).toBe('running');
  });

  it('面②：boot 恢复谓词含 running/yielded/paused（awaiting_user 刻意不在降级集）', () => {
    expect([...BOOT_RECOVERABLE_STATES]).toEqual(['running', 'yielded', 'paused']);
    expect(BOOT_RECOVERABLE_STATES).not.toContain('awaiting_user');
  });

  it('面④：worker 拒绝非法 updateTaskStatus / task_events 状态值（E-STORE-BAD-REQUEST）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xinglian-mirror-'));
    try {
      const db: SqliteDatabase = openAndMigrate(path.join(dir, 'mirror.db')).db;
      try {
        handleStoreRequest(db, { id: 1, type: 'createTask', task: { id: 't1', kind: 'collect' } });
        expect(() =>
          handleStoreRequest(db, { id: 2, type: 'updateTaskStatus', update: { taskId: 't1', status: 'teleported' as never } }),
        ).toThrow(/E-STORE-BAD-REQUEST.*非法任务状态/);
        expect(() =>
          handleStoreRequest(db, {
            id: 3,
            type: 'writeTaskEvent',
            event: { taskId: 't1', type: 'TASK_YIELD', fromState: 'running', toState: 'yielded-but-wrong' },
          }),
        ).toThrow(/E-STORE-BAD-REQUEST.*toState/);
        // 合法新态照常写入
        const ok = handleStoreRequest(db, {
          id: 4,
          type: 'writeTaskEvent',
          event: { taskId: 't1', type: 'TASK_YIELD', fromState: 'running', toState: 'yielded' },
        });
        expect(ok.data).toEqual({ written: true });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
