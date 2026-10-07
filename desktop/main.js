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
 *   5) 退出前先让页面把最后一次改动落盘（DSF.flush），再真正关窗；
 *   6) 快速导入悬浮窗：开关开启后，主窗口不在前台（最小化/被浏览器挡住）时，
 *      屏幕角落保留一个“始终置顶”的迷你窗；把链接拖进去即自动唤起主窗口并导入。
 *
 * 运行：npm start      （自检：npm run smoke / npm run smoke:quick）
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, shell, session, ipcMain, screen } = require('electron');
const { createServer } = require('./server');

const ROOT_DIR = path.join(__dirname, '..');
const SMOKE = process.argv.includes('--smoke');
const SMOKE_WRITE = process.argv.includes('--smoke-write');
const SMOKE_EXPECT = process.argv.includes('--smoke-expect-persist');
const SMOKE_QUICK = process.argv.includes('--smoke-quick');
const MARKER_FOLDER = '桌面自检文件夹';

// 悬浮窗尺寸：保持“非常小”，只放一条拖放区
const QUICK_W = 168;
const QUICK_H = 66;
const QUICK_MARGIN = 24;

// 允许 --user-data-dir=<路径> 指定数据目录（自检时用临时目录，避免污染真实数据）
const argUserData = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (argUserData) {
  try {
    app.setPath('userData', path.resolve(argUserData.slice('--user-data-dir='.length)));
  } catch (e) { /* ignore */ }
}

let win = null;
let quickWin = null;
let server = null;
let appUrl = '';
let quitting = false;

/** 数据文件：始终放在系统“用户数据目录”，与安装位置无关 */
function dataFilePath() {
  return path.join(app.getPath('userData'), 'dsf-data.json');
}

/* ------------------- 桌面版设置（主进程持有，独立于业务数据） ------------------- */
// 悬浮窗开关与位置存在 desktop-settings.json：页面尚未加载时开关就已生效
const DEFAULT_SETTINGS = { quickWindow: false, quickPos: null };
let settings = Object.assign({}, DEFAULT_SETTINGS);

function settingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function loadSettings() {
  try {
    settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {});
  } catch (e) {
    settings = Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

/* ----------------------------- 快速导入悬浮窗 ----------------------------- */

function defaultQuickPos() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - QUICK_W - QUICK_MARGIN,
    y: area.y + area.height - QUICK_H - QUICK_MARGIN
  };
}

function createQuickWindow() {
  if (quickWin) return quickWin;
  const pos = settings.quickPos || defaultQuickPos();

  quickWin = new BrowserWindow({
    width: QUICK_W,
    height: QUICK_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'DSF 快速导入',
    icon: path.join(ROOT_DIR, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'quick-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  quickWin.setAlwaysOnTop(true, 'floating');
  quickWin.loadFile(path.join(__dirname, 'quick.html'));

  // 记录位置（并把窗口夹回可见工作区，避免拖到屏幕外找不到）
  quickWin.on('moved', () => {
    if (!quickWin) return;
    const b = quickWin.getBounds();
    const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - b.width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height);
    if (x !== b.x || y !== b.y) {
      quickWin.setBounds({ x, y, width: b.width, height: b.height });
    }
    settings.quickPos = { x, y };
    saveSettings();
  });

  quickWin.on('closed', () => { quickWin = null; });
  return quickWin;
}

/**
 * 悬浮窗可见性规则：
 *   开关开启 且 主窗口不在前台（最小化 / 被其它窗口挡住）→ 显示并置顶；
 *   主窗口一旦获得焦点 → 立即隐藏，避免遮挡应用本体。
 */
function updateQuickVisibility() {
  if (!settings.quickWindow) {
    if (quickWin && quickWin.isVisible()) quickWin.hide();
    return;
  }
  if (!win) return;

  const mainNotInFront = win.isMinimized() || !win.isVisible() || !win.isFocused();
  if (mainNotInFront) {
    const q = createQuickWindow();
    if (!q.isVisible()) q.showInactive(); // 不抢焦点，避免打断你在浏览器里的操作
    q.setAlwaysOnTop(true, 'floating');
  } else if (quickWin && quickWin.isVisible()) {
    quickWin.hide();
  }
}

/** 唤起主窗口（拖入链接后 / 点击悬浮窗时） */
function restoreMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  updateQuickVisibility();
}

/** 把内容安全地转交给页面（页面可能仍在加载） */
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(channel, payload));
  else wc.send(channel, payload);
}

/** 限制转发内容大小，避免异常大包 */
function sanitizeQuickPayload(payload) {
  const p = payload || {};
  const cut = (s, n) => String(s == null ? '' : s).slice(0, n);
  return {
    uriList: cut(p.uriList, 20000),
    plain: cut(p.plain, 200000),
    html: cut(p.html, 200000)
  };
}

/** 悬浮窗拖入 → 唤起主窗口 → 交给页面导入 */
function handleQuickDrop(payload) {
  const safe = sanitizeQuickPayload(payload);
  restoreMain();
  sendToRenderer('dsf:quick-import', safe);
  return safe;
}

function registerQuickIpc() {
  ipcMain.on('dsf:quick-get', (event) => { event.returnValue = !!settings.quickWindow; });

  ipcMain.on('dsf:quick-set', (_event, value) => {
    settings.quickWindow = !!value;
    saveSettings();
    updateQuickVisibility();
    if (win && !win.isDestroyed()) win.webContents.send('dsf:quick-changed', settings.quickWindow);
  });

  ipcMain.on('dsf:quick-close', () => {
    settings.quickWindow = false;
    saveSettings();
    updateQuickVisibility();
    if (win && !win.isDestroyed()) win.webContents.send('dsf:quick-changed', false);
  });

  ipcMain.on('dsf:restore-main', () => restoreMain());
  ipcMain.on('dsf:quick-drop', (_event, payload) => handleQuickDrop(payload));
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

  loadSettings();
  registerQuickIpc();

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
      preload: path.join(__dirname, 'preload.js'), // 暴露桌面版能力（悬浮窗开关等）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);

  // 主窗口的前台状态变化 → 同步悬浮窗显隐
  ['minimize', 'restore', 'focus', 'blur', 'show', 'hide'].forEach((evt) => {
    win.on(evt, () => updateQuickVisibility());
  });

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
    if (SMOKE || SMOKE_WRITE || SMOKE_EXPECT || SMOKE_QUICK) {
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

  if (SMOKE_QUICK) {
    // 悬浮窗自检：初始应为关闭 → 开启 → 最小化主窗后悬浮窗置顶可见
    // → 模拟拖入链接 → 主窗被唤起且页面收到数据 → 设置已落盘
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const checks = [];

    checks.push(['初始为关闭', settings.quickWindow === false]);
    checks.push(['主窗在前台时悬浮窗不应出现', !(quickWin && quickWin.isVisible())]);

    // 1) 开启开关（等价于页面里点击“悬浮窗”按钮）
    ipcMain.emit('dsf:quick-set', null, true);
    await wait(200);
    checks.push(['开关开启后写入设置', settings.quickWindow === true]);

    // 2) 最小化主窗口 → 悬浮窗应显示
    win.minimize();
    await wait(700);
    updateQuickVisibility();
    await wait(400);
    const visibleWhenMinimized = !!(quickWin && quickWin.isVisible());
    checks.push(['主窗最小化后悬浮窗置顶可见', visibleWhenMinimized]);

    // 悬浮窗页面本身要真的加载成功（含链接解析逻辑），否则等于一个空壳
    const quickPageOk = await (quickWin
      ? quickWin.webContents.executeJavaScript(
        "!!(window.DSF && window.DSF.utils && document.getElementById('drop'))"
      ).catch(() => false)
      : Promise.resolve(false));
    checks.push(['悬浮窗页面加载成功（含链接解析）', quickPageOk === true]);

    // 3) 模拟从悬浮窗拖入一个 DeepSeek 链接
    const payload = {
      uriList: '',
      plain: 'https://chat.deepseek.com/a/chat/s/quicksmoke',
      html: ''
    };
    handleQuickDrop(payload);
    await wait(700);

    const mainRestored = !win.isMinimized();
    checks.push(['拖入后自动唤起主窗口', mainRestored]);

    const received = await win.webContents.executeJavaScript(
      "!!(window.__dsfQuickImport && window.__dsfQuickImport.plain)"
    ).catch(() => false);
    checks.push(['页面收到悬浮窗数据', received === true]);

    const settingsOnDisk = (() => {
      try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).quickWindow === true; }
      catch (e) { return false; }
    })();
    checks.push(['开关状态已持久化', settingsOnDisk]);

    // 4) 关闭开关 → 悬浮窗应隐藏
    ipcMain.emit('dsf:quick-set', null, false);
    await wait(300);
    checks.push(['关闭开关后悬浮窗隐藏', !(quickWin && quickWin.isVisible())]);

    const failedItems = checks.filter((c) => !c[1]).map((c) => c[0]);
    checks.forEach((c) => console.log('  ' + (c[1] ? '✔' : '✘') + ' ' + c[0]));
    console.log(failedItems.length === 0 ? 'SMOKE QUICK OK' : 'SMOKE QUICK FAIL: ' + failedItems.join(' / '));
    setTimeout(() => app.exit(failedItems.length === 0 ? 0 : 1), 300);
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
  if (quickWin) {
    try { quickWin.destroy(); } catch (e) { /* ignore */ }
    quickWin = null;
  }
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
    server = null;
  }
});
