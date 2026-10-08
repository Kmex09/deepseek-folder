/* =========================================================================
 * desktop/main.js — DeepSeek Folder 桌面版主进程（Electron）
 * -------------------------------------------------------------------------
 * 设计要点：
 *   1) 页面代码零改动：主进程内嵌 desktop/server.js（与 server.py 同接口），
 *      窗口加载 http://127.0.0.1:<随机端口>/ —— 页面自动进入“数据文件”模式；
 *   2) 数据落在用户数据目录（Windows: %APPDATA%\DeepSeek Folder\deepseek-folder-data.json），
 *      无需任何授权、无需手动保存、重启电脑也不会丢；
 *   3) DeepSeek 会话链接一律交给系统默认浏览器打开，不在应用内新开窗口；
 *   4) 单实例运行：重复启动会聚焦已有窗口；
 *   5) 退出前先让页面把最后一次改动落盘（DF.flush），再真正关窗；
 *   6) 快速导入悬浮窗：开关开启后，主窗口不在前台（最小化/被浏览器挡住）时，
 *      屏幕角落保留一个“始终置顶”的迷你窗；把链接拖进去即自动唤起主窗口并导入。
 *
 * 运行：npm start      （自检：npm run smoke / npm run smoke:quick）
 * ========================================================================= */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------- 启动日志（崩溃取证用） -------------------
 * GUI 版 exe 的 stdout 捕获不到，所以主进程自己把启动信息与异常写进
 *   %APPDATA%\DeepSeek Folder\startup.log
 * 路径不依赖 electron 的 app 对象，因此“Electron 没起来”这种情况也能记录。
 * ------------------------------------------------------------ */
const LOG_DIR = path.join(process.env.APPDATA || os.tmpdir(), 'DeepSeek Folder');
let LOG_FILE = path.join(LOG_DIR, 'startup.log');

function startupLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // 首次写入带 UTF-8 BOM：PowerShell 的 Get-Content 才能正确显示中文
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '\uFEFF', 'utf8');
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch (e) { /* 日志失败不影响启动 */ }
}

function fmtArg(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

(['log', 'error', 'warn']).forEach((level) => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    startupLog('[' + level + '] ' + args.map(fmtArg).join(' '));
    original(...args);
  };
});

process.on('uncaughtException', (err) => {
  startupLog('[uncaughtException] ' + ((err && err.stack) || err));
  try { console.error(err); } catch (e) { /* ignore */ }
  try { app.exit(1); } catch (e) { process.exit(1); }
});
process.on('unhandledRejection', (reason) => {
  startupLog('[unhandledRejection] ' + ((reason && reason.stack) || reason));
});

const { app, BrowserWindow, Menu, shell, session, ipcMain, screen } = require('electron');
const { createServer } = require('./server');

// 防御：若在设置了 ELECTRON_RUN_AS_NODE=1 的环境里启动（Electron 会退化成纯 Node），
// require('electron') 拿不到主进程 API —— 记录到日志并给出可操作的提示
if (!app || typeof app.requestSingleInstanceLock !== 'function') {
  startupLog('[fatal] 没有 Electron 主进程能力：ELECTRON_RUN_AS_NODE=' +
    String(process.env.ELECTRON_RUN_AS_NODE || '(未设置)'));
  console.error('[deepseek-folder] 没有 Electron 主进程能力：请用 `npm start` 启动。' +
    '若环境中设置了 ELECTRON_RUN_AS_NODE=1，请先清除它再运行。');
  process.exit(1);
}

const ROOT_DIR = path.join(__dirname, '..');
const SMOKE = process.argv.includes('--smoke');
const SMOKE_WRITE = process.argv.includes('--smoke-write');
const SMOKE_EXPECT = process.argv.includes('--smoke-expect-persist');
const SMOKE_QUICK = process.argv.includes('--smoke-quick');
const DIAGNOSE_QUICK = process.argv.includes('--diagnose-quick');
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
    LOG_FILE = path.join(app.getPath('userData'), 'startup.log'); // 自检日志也隔离
  } catch (e) { /* ignore */ }
}

startupLog('==== 启动 v' + require('../package.json').version + ' ====');
startupLog('argv: ' + process.argv.join(' '));
startupLog('exe: ' + process.execPath + ' | electron: ' + process.versions.electron +
  ' | ELECTRON_RUN_AS_NODE=' + String(process.env.ELECTRON_RUN_AS_NODE || '(unset)'));
startupLog('userData: ' + app.getPath('userData'));

let win = null;
let quickWin = null;
let quickLoadMode = ''; // 'http' | 'file(fallback)' | 'file(no-server)'
let server = null;
let appUrl = '';
let quitting = false;

/** 数据文件：始终放在系统“用户数据目录”，与安装位置无关 */
function dataFilePath() {
  return path.join(app.getPath('userData'), 'deepseek-folder-data.json');
}

/**
 * v0.5.0 项目改名（DSF 会话夹 → DeepSeek Folder）后 userData 目录也跟着改名，
 * 这里把旧目录里的数据文件与设置复制到新目录，避免老用户“数据消失”。
 * 只在目标不存在时复制；旧目录原样保留，回退旧版本仍可用。
 */
function migrateLegacyUserData(log) {
  const appData = app.getPath('appData');
  const newDir = app.getPath('userData');
  const legacyDirs = [path.join(appData, 'DSF 会话夹')];
  const pairs = [
    ['dsf-data.json', 'deepseek-folder-data.json'],
    ['desktop-settings.json', 'desktop-settings.json']
  ];

  legacyDirs.forEach((legacyDir) => {
    if (!fs.existsSync(legacyDir)) return;
    pairs.forEach(([from, to]) => {
      const src = path.join(legacyDir, from);
      const dest = path.join(newDir, to);
      if (!fs.existsSync(src) || fs.existsSync(dest)) return;
      try {
        fs.mkdirSync(newDir, { recursive: true });
        fs.copyFileSync(src, dest);
        log('[deepseek-folder] 已迁移旧版本数据：' + src + ' → ' + dest);
      } catch (e) {
        log('[deepseek-folder] 旧数据迁移失败：' + e.message);
      }
    });
  });
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
    title: 'DeepSeek Folder 快速导入',
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

  // 加载方式：优先走内嵌服务（对 .html 显式返回 text/html; charset=utf-8，
  // 不依赖 Chromium 对 file:// 的 MIME 推断）；失败再退回 loadFile。
  // 两条路都会记录实际使用的模式，便于 --diagnose-quick 排查。
  const quickFile = path.join(__dirname, 'quick.html');
  if (appUrl) {
    quickWin.loadURL(appUrl + 'desktop/quick.html').then(() => {
      quickLoadMode = 'http';
    }).catch((err) => {
      quickLoadMode = 'file(fallback)';
      console.log('[deepseek-folder] 悬浮窗改用 file:// 加载（内嵌服务加载失败：' +
        (err && err.message) + '）');
      if (quickWin) quickWin.loadFile(quickFile);
    });
  } else {
    quickLoadMode = 'file(no-server)';
    quickWin.loadFile(quickFile);
  }

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
  sendToRenderer('deepseek-folder:quick-import', safe);
  return safe;
}

function registerQuickIpc() {
  ipcMain.on('deepseek-folder:quick-get', (event) => { event.returnValue = !!settings.quickWindow; });

  ipcMain.on('deepseek-folder:quick-set', (_event, value) => {
    settings.quickWindow = !!value;
    saveSettings();
    updateQuickVisibility();
    if (win && !win.isDestroyed()) win.webContents.send('deepseek-folder:quick-changed', settings.quickWindow);
  });

  ipcMain.on('deepseek-folder:quick-close', () => {
    settings.quickWindow = false;
    saveSettings();
    updateQuickVisibility();
    if (win && !win.isDestroyed()) win.webContents.send('deepseek-folder:quick-changed', false);
  });

  ipcMain.on('deepseek-folder:restore-main', () => restoreMain());
  ipcMain.on('deepseek-folder:quick-drop', (_event, payload) => handleQuickDrop(payload));
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
    console.error('[deepseek-folder] 启动失败：', err);
    app.exit(1);
  });
}

/* --------------------------- 启动流程 --------------------------- */
async function start() {
  // 改名迁移必须在读取任何数据之前完成
  // （自检可用 DEEPSEEK_FOLDER_SKIP_MIGRATE=1 跳过，保证测试环境干净可控）
  if (process.env.DEEPSEEK_FOLDER_SKIP_MIGRATE !== '1') {
    migrateLegacyUserData((msg) => console.log(msg));
  }

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
  console.log('[deepseek-folder] 数据文件：' + dataFile);
  console.log('[deepseek-folder] 本地服务：' + appUrl);

  // 下载（导出备份）：弹出“另存为”对话框，避免静默落到下载文件夹
  try {
    session.defaultSession.on('will-download', (event, item) => {
      item.setSaveDialogOptions({ title: '导出 DeepSeek Folder 备份', defaultPath: item.getFilename() });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  } catch (e) { /* 旧版本 Electron 上忽略 */ }

  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'DeepSeek Folder · 会话夹',
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
    win.webContents.executeJavaScript('window.DF && window.DF.flush && window.DF.flush()')
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
      "(() => { try { window.DF.store.createFolder('" + MARKER_FOLDER + "');" +
      " return window.DF.store.data.folders.some(f => f.name === '" + MARKER_FOLDER + "'); }" +
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
      "(async () => { try { const t = (document.querySelector('meta[name=\"df-token\"]') || {}).content || '';" +
      " const r = await fetch('api/state', { cache: 'no-store', headers: { 'X-DeepSeek-Folder-Token': t } });" +
      " const j = await r.json(); return !!(r.ok && j && Array.isArray(j.folders) &&" +
      " j.folders.some(f => f.name === '" + MARKER_FOLDER + "')); } catch (e) { return false; } })()"
    ).catch(() => false);
    console.log(persisted ? 'SMOKE PERSIST OK' : 'SMOKE PERSIST FAIL');
    setTimeout(() => app.exit(persisted ? 0 : 1), 300);
    return;
  }

  if (DIAGNOSE_QUICK) {
    // 悬浮窗诊断：把窗口真实状态打印出来（用于排查“显示成 HTML 源码”这类问题）
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    settings.quickWindow = true;
    saveSettings();
    if (win.isMinimized()) win.restore();
    win.minimize();                       // 触发悬浮窗出现
    await wait(900);
    updateQuickVisibility();
    await wait(700);

    const info = await (quickWin
      ? quickWin.webContents.executeJavaScript(`(() => {
          const pill = document.getElementById('pill');
          const drop = document.getElementById('drop');
          return {
            contentType: document.contentType,
            url: location.href,
            title: document.title,
            bodyText: document.body ? document.body.innerText.slice(0, 120) : '(no body)',
            hasPill: !!pill,
            pillRadius: pill ? getComputedStyle(pill).borderRadius : '',
            pillBg: pill ? getComputedStyle(pill).backgroundColor : '',
            dropText: drop ? drop.innerText.trim() : '',
            headHtml: document.head ? document.head.innerHTML.slice(0, 100) : ''
          };
        })()`).catch((e) => ({ error: String(e && e.message) }))
      : { error: '悬浮窗未创建' });

    console.log('===== 悬浮窗诊断 =====');
    console.log('加载方式      :', quickLoadMode || '(未知)');
    console.log('窗口存在      :', !!quickWin, '| 可见:', !!(quickWin && quickWin.isVisible()));
    console.log('窗口尺寸/位置 :', quickWin ? JSON.stringify(quickWin.getBounds()) : '-');
    console.log('页面 contentType:', info.contentType);
    console.log('页面 URL      :', info.url);
    console.log('页面 title    :', info.title);
    console.log('pill 存在     :', info.hasPill, '| 圆角:', info.pillRadius, '| 背景:', info.pillBg);
    console.log('拖放区文字    :', JSON.stringify(info.dropText));
    console.log('正文前 120 字 :', JSON.stringify(info.bodyText));
    console.log('head 前 100 字:', JSON.stringify(info.headHtml));
    if (info.error) console.log('诊断异常      :', info.error);
    console.log('======================');
    settings.quickWindow = false;
    saveSettings();
    setTimeout(() => app.exit(0), 300);
    return;
  }

  if (SMOKE_QUICK) {
    // 悬浮窗自检：开关可读 → 前台时不显示 → 开启 → 最小化主窗后置顶可见
    // → 模拟拖入链接 → 主窗被唤起且页面收到数据 → 设置已落盘 → 关闭后隐藏
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const checks = [];

    // 初始状态可能是从旧版本迁移来的（真假都合法），这里只校验“可读 + 为布尔值”
    checks.push(['开关初始状态可读取', typeof settings.quickWindow === 'boolean']);
    checks.push(['主窗在前台时悬浮窗不应出现', !(quickWin && quickWin.isVisible())]);

    // 统一先置为关闭，保证后续步骤的起点确定
    ipcMain.emit('deepseek-folder:quick-set', null, false);
    await wait(150);
    checks.push(['关闭状态下设置正确落盘', settings.quickWindow === false]);

    // 1) 开启开关（等价于页面里点击“悬浮窗”按钮）
    ipcMain.emit('deepseek-folder:quick-set', null, true);
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
        "!!(window.DF && window.DF.utils && document.getElementById('drop'))"
      ).catch(() => false)
      : Promise.resolve(false));
    checks.push(['悬浮窗页面加载成功（含链接解析）', quickPageOk === true]);

    // 关键：必须是按 HTML 解析（contentType=text/html）。
    // 若被当成 text/plain，窗口里会把 HTML 源码当文字显示出来。
    const quickType = await (quickWin
      ? quickWin.webContents.executeJavaScript('document.contentType').catch(() => '')
      : Promise.resolve(''));
    checks.push(['悬浮窗以 text/html 解析（不是纯文本源码）', quickType === 'text/html']);

    // 进一步确认：CSS 生效（html 元素背景为透明，说明样式表已应用）
    const quickStyled = await (quickWin
      ? quickWin.webContents.executeJavaScript(
        "getComputedStyle(document.getElementById('pill')).borderRadius !== ''"
      ).catch(() => false)
      : Promise.resolve(false));
    checks.push(['悬浮窗样式已生效（圆角胶囊渲染正常）', quickStyled === true]);

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
      "!!(window.__dfQuickImport && window.__dfQuickImport.plain)"
    ).catch(() => false);
    checks.push(['页面收到悬浮窗数据', received === true]);

    const settingsOnDisk = (() => {
      try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).quickWindow === true; }
      catch (e) { return false; }
    })();
    checks.push(['开关状态已持久化', settingsOnDisk]);

    // 4) 关闭开关 → 悬浮窗应隐藏
    ipcMain.emit('deepseek-folder:quick-set', null, false);
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
      "(async () => { try { const t = (document.querySelector('meta[name=\"df-token\"]') || {}).content || '';" +
      " const r = await fetch('api/state', { cache: 'no-store', headers: { 'X-DeepSeek-Folder-Token': t } });" +
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
