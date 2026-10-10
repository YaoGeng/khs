import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
