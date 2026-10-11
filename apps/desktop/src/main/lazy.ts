/**
 * C-3 招一：主进程延迟加载（03-PRD与架构对齐审查报告.md 第 230 行）。
 *
 * 规约：重模块（store / logger / browser-service / workflow-engine 等，02 §4.2 模块清单）
 * 一律不在模块顶层 import，统一由 bootstrapAfterWindowReady() 在窗口首帧
 * （did-finish-load）之后才动态加载/初始化，缩短 main 'ready' → 首帧的关键路径。
 *
 * M0 尚无真实重模块，heavy.ts 为占位注册点；本工厂把「推迟执行」语义固化下来，
 * M1+ 引入真实重模块时只需扩充 loadHeavyModules()。
 */
export interface HeavyModules {
  readonly name: string;
}

export interface DeferredBootstrap {
  /** 首帧之后调用一次；重复调用是 no-op */
  bootstrapAfterWindowReady: () => void;
  isBootstrapped: () => boolean;
}

export function createDeferredBootstrap(load: () => Promise<HeavyModules>): DeferredBootstrap {
  let done = false;
  return {
    bootstrapAfterWindowReady() {
      if (done) return;
      done = true;
      void load().catch((error: unknown) => {
        console.error('[shell] heavy bootstrap failed:', error);
      });
    },
    isBootstrapped: () => done,
  };
}
