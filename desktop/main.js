/* =========================================================================
 * desktop/main.js — DSF 桌面版主进程（Electron）
 * -------------------------------------------------------------------------
 * 设计要点：
 *   1) 页面代码零改动：主进程内嵌 desktop/server.js（与 server.py 同接口），
 *      窗口加载 http://127.0.0.1:<随机端口>/ —— 页面自动进入“数据文件”模式；
 *   2) 数据落在用户数据目录（Windows: %APPDATA%\DSF 会话夹\dsf-data.json），
 *      无需任何授权、无需手动保存、重启电脑也不会丢；
 *   3) DeepSeek 会话链接一律交给系统默认浏览器打开，不在应用内新开窗口；
 *   4) 单实例运行：重复启动会聚焦已有窗口；
 *   5) 退出前先让页面把最后一次改动落盘（DSF.flush），再真正关窗。
 *
 * 运行：npm start      （自检：npm run smoke，窗口隐藏并自动退出）
 * ========================================================================= */
'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const { createServer } = require('./server');

const ROOT_DIR = path.join(__dirname, '..');
const SMOKE = process.argv.includes('--smoke');
const SMOKE_WRITE = process.argv.includes('--smoke-write');
const SMOKE_EXPECT = process.argv.includes('--smoke-expect-persist');
const MARKER_FOLDER = '桌面自检文件夹';

// 允许 --user-data-dir=<路径> 指定数据目录（自检时用临时目录，避免污染真实数据）
const argUserData = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (argUserData) {
  try {
    app.setPath('userData', path.resolve(argUserData.slice('--user-data-dir='.length)));
  } catch (e) { /* ignore */ }
}

let win = null;
let server = null;
let appUrl = '';
let quitting = false;

/** 数据文件：始终放在系统“用户数据目录”，与安装位置无关 */
function dataFilePath() {
  return path.join(app.getPath('userData'), 'dsf-data.json');
}

/** 一次性完成的 Promise（用于等待“写盘/落盘”这类事件） */
function deferred() {
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/* --------------------------- 单实例 --------------------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(start).catch((err) => {
    console.error('[dsf] 启动失败：', err);
    app.exit(1);
  });
}

/* --------------------------- 启动流程 --------------------------- */
async function start() {
  const dataFile = dataFilePath();
  const dataSaved = deferred();
  const pageFlushed = deferred();

  server = createServer({
    rootDir: ROOT_DIR,
    dataFile,
    log: (msg) => console.log(msg),
    onSave: (label) => dataSaved.resolve(label),
    onFlush: () => pageFlushed.resolve(true)
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve); // 随机空闲端口，仅本机可访问
  });

  const port = server.address().port;
  appUrl = 'http://127.0.0.1:' + port + '/';
  console.log('[dsf] 数据文件：' + dataFile);
  console.log('[dsf] 本地服务：' + appUrl);

  // 下载（导出备份）：弹出“另存为”对话框，避免静默落到下载文件夹
  try {
    session.defaultSession.on('will-download', (event, item) => {
      item.setSaveDialogOptions({ title: '导出 DSF 备份', defaultPath: item.getFilename() });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  } catch (e) { /* 旧版本 Electron 上忽略 */ }

  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'DSF · DeepSeek 会话夹',
    icon: path.join(ROOT_DIR, 'assets', 'icon-256.png'), // 窗口 / 任务栏图标
    backgroundColor: '#f4f5f8',
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);

  // 外部链接（DeepSeek 会话卡片）交给系统浏览器，不在应用内开窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on('closed', () => { win = null; });

  // 退出前先把最后一次改动落盘（否则防抖等待中的改动会随进程一起消失）
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (SMOKE || SMOKE_WRITE || SMOKE_EXPECT) {
      try { win.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    win.webContents.executeJavaScript('window.DSF && window.DSF.flush && window.DSF.flush()')
      .catch(() => {})
      .then(() => pageFlushed.promise)
      .then(() => { try { win.destroy(); } catch (e) { /* ignore */ } })
      .catch(() => { try { win.destroy(); } catch (e) { /* ignore */ } });
  });

  // 无菜单栏时默认快捷键会失效，这里补上常用操作
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    if (key === 'f5' || (ctrl && key === 'r')) {
      event.preventDefault();
      win.reload();
    } else if (key === 'f12' || (ctrl && input.shift && key === 'i')) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    } else if (ctrl && key === 'w') {
      event.preventDefault();
      win.close();
    } else if (key === 'f11' || (ctrl && input.shift && key === 'f')) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  await win.loadURL(appUrl);

  if (SMOKE_WRITE) {
    // 写自检：在页面里真实创建一个文件夹（走 store → 内嵌服务 → 数据文件）
    const created = await win.webContents.executeJavaScript(
      "(() => { try { window.DSF.store.createFolder('" + MARKER_FOLDER + "');" +
      " return window.DSF.store.data.folders.some(f => f.name === '" + MARKER_FOLDER + "'); }" +
      " catch (e) { return false; } })()"
    ).catch(() => false);
    // 等真正的落盘事件，而不是猜一个延迟
    const saved = await Promise.race([
      dataSaved.promise,
      new Promise((r) => setTimeout(() => r(null), 8000))
    ]);
    const ok = created && saved === 'save';
    console.log(ok ? 'SMOKE WRITE OK' : 'SMOKE WRITE FAIL');
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
    return;
  }

  if (SMOKE_EXPECT) {
    // 重启自检：新进程重新读取数据文件，应能看到上次写入的文件夹
    const persisted = await win.webContents.executeJavaScript(
      "(async () => { try { const t = (document.querySelector('meta[name=\"dsf-token\"]') || {}).content || '';" +
      " const r = await fetch('api/state', { cache: 'no-store', headers: { 'X-DSF-Token': t } });" +
      " const j = await r.json(); return !!(r.ok && j && Array.isArray(j.folders) &&" +
      " j.folders.some(f => f.name === '" + MARKER_FOLDER + "')); } catch (e) { return false; } })()"
    ).catch(() => false);
    console.log(persisted ? 'SMOKE PERSIST OK' : 'SMOKE PERSIST FAIL');
    setTimeout(() => app.exit(persisted ? 0 : 1), 300);
    return;
  }

  if (SMOKE) {
    // 基础自检：页面能加载 + 数据接口可用（含首启动自动建数据文件、令牌注入）
    const ok = await win.webContents.executeJavaScript(
      "(async () => { try { const t = (document.querySelector('meta[name=\"dsf-token\"]') || {}).content || '';" +
      " const r = await fetch('api/state', { cache: 'no-store', headers: { 'X-DSF-Token': t } });" +
      " const j = await r.json(); return !!(r.ok && j && Array.isArray(j.folders)); }" +
      " catch (e) { return false; } })()"
    ).catch(() => false);
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
  }
}

/* --------------------------- 退出清理 --------------------------- */
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => {
  quitting = true;
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
    server = null;
  }
});
