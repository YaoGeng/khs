// Minimal sticky Electron app for S6 pipe test: hidden window, stays alive until killed.
'use strict';
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 200, height: 100, show: false });
  win.loadURL('about:blank');
  // keep running; parent kills the process tree after the test
});
