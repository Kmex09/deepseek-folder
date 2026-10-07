/* =========================================================================
 * desktop/preload.js — 主窗口 preload（桌面版增强能力）
 * -------------------------------------------------------------------------
 * 网页版没有 window.dfDesktop，因此页面里所有桌面专属 UI 都由
 * 特性检测决定是否启用 —— 同一份页面代码在浏览器里跑不受影响。
 * ========================================================================= */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 启动时同步读取一次开关状态（主进程本地读取，开销可忽略）
let quickEnabled = false;
try { quickEnabled = !!ipcRenderer.sendSync('deepseek-folder:quick-get'); } catch (e) { quickEnabled = false; }

contextBridge.exposeInMainWorld('dfDesktop', {
  isDesktop: true,
  electron: process.versions.electron,

  /** 快速导入悬浮窗开关 */
  quickWindow: {
    isEnabled: () => quickEnabled,
    setEnabled: (value) => {
      quickEnabled = !!value;
      ipcRenderer.send('deepseek-folder:quick-set', !!value);
    },
    /** 开关被其它入口（如悬浮窗自身的 ✕）改变时同步 UI */
    onChange: (cb) => {
      ipcRenderer.on('deepseek-folder:quick-changed', (_event, value) => {
        quickEnabled = !!value;
        try { cb(!!value); } catch (e) { /* ignore */ }
      });
    }
  },

  /** 悬浮窗收到拖入内容后，主进程会把数据转发到这里 */
  onQuickImport: (cb) => {
    ipcRenderer.on('deepseek-folder:quick-import', (_event, payload) => {
      try { cb(payload || {}); } catch (e) { /* ignore */ }
    });
  }
});
