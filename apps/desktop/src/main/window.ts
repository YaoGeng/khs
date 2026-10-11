/**
 * 主窗口创建（02 §4.1 进程模型 + §11.2 客户端安全细节 + C-3 招三首屏骨架配合）。
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { webPreferencesBaseline } from './security';

export interface MainWindowDeps {
  /** did-finish-load 回调（main.ts 在此结算冷启动样本并触发延迟加载） */
  readonly onDidFinishLoad?: () => void;
}

export function createMainWindow(deps: MainWindowDeps = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '星链 · AI 选品营销工作台',
    backgroundColor: '#f5f6f8',
    // §11.2 安全基线：contextIsolation/sandbox/nodeIntegration 由 security.ts 纯函数给出（可快照单测）
    webPreferences: webPreferencesBaseline(path.join(__dirname, 'preload.js')),
  });

  // 首帧渲染完成（含静态骨架屏）后再显示，避免白屏闪烁（C-3 招三配套）
  win.once('ready-to-show', () => {
    win.show();
  });

  // 受控壳：禁 renderer 发起 window.open 逃逸（§11.2 进程隔离姿态）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.once('did-finish-load', () => {
    deps.onDidFinishLoad?.();
  });

  void win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}
