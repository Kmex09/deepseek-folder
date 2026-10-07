/* =========================================================================
 * desktop/quick-preload.js — 快速导入悬浮窗的 preload
 * -------------------------------------------------------------------------
 * 只暴露三个最小能力给悬浮窗页面，渲染进程依旧没有 Node 能力。
 * ========================================================================= */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dfQuick', {
  /** 把拖入的原始数据交给主进程（由主进程唤起主窗口并转交页面） */
  sendDrop: (payload) => ipcRenderer.send('deepseek-folder:quick-drop', payload),
  /** 关闭悬浮窗（同时关闭主界面里的开关） */
  close: () => ipcRenderer.send('deepseek-folder:quick-close'),
  /** 主动唤起主窗口 */
  restore: () => ipcRenderer.send('deepseek-folder:restore-main')
});
