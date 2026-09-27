/* =========================================================================
 * desktop/server.js — DSF 内嵌本地服务（Node，零依赖）
 * -------------------------------------------------------------------------
 * 与 server.py 完全同接口：
 *   GET  /api/state  → 返回数据文件内容（不存在时返回 null）
 *   PUT  /api/state  → 校验 JSON 后原子写入数据文件
 *   其余路径          → 托管 DSF 页面静态文件（index.html / css / js）
 * 用途：
 *   1) Electron 主进程内嵌启动（随机端口，仅本机回环）；
 *   2) 也可以直接 `node desktop/server.js [端口]` 当纯 Node 版服务器用
 *      （等价于 python server.py，无需 Python）。
 *
 * 访问控制（v0.3.2 起）：
 *   数据接口是本机回环上的无鉴权写接口，若不设防，用户浏览任意网站时该网站
 *   都能直接 PUT 覆盖 dsf-data.json（简单请求不触发 CORS 预检，写入照样生效）。
 *   因此这里做两件事：
 *     1) 校验 Host 必须是回环地址（防 DNS rebinding）；
 *     2) 校验 Origin 必须同源 + 校验页面注入的会话 Token（防跨站请求伪造）。
 *   页面由本地服务自己托管，Token 直接内联进 HTML，正常使用完全无感。
 * ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_PATH = '/api/state';
const HTML_PATH = '/index.html';
const TOKEN_PLACEHOLDER = '__DSF_TOKEN__';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const ALLOWED_EXT = new Set(Object.keys(MIME));

/** 首次运行创建空数据文件，让“文件持久化已生效”一目了然 */
function ensureDataFile(dataFile) {
  if (fs.existsSync(dataFile)) return;
  const base = {
    v: 1,
    savedAt: Date.now(),
    folders: [],
    sessions: [],
    recentClosed: [],
    settings: { sidebarCollapsed: false, lastImportFolderId: '' }
  };
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tmp = dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(base, null, 2), 'utf8');
  fs.renameSync(tmp, dataFile);
}

function send(res, code, body, type, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const headers = {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  Object.assign(headers, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(buf);
}

/** 请求的 Host 是否为回环地址（未带端口的裸主机名也算） */
function hostAllowed(req) {
  const raw = String(req.headers.host || '');
  if (!raw) return true; // 无 Host（HTTP/1.0）不构成 rebinding 风险
  const host = raw.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 拒绝一个尚未读完请求体的请求。
 * 关键：先回完整的 403 响应，再 destroy()，让客户端拿到响应后重开连接。
 * 若只 res.end() 而不关闭，又没读完请求体，客户端会一直等“请求发完”，
 * 服务端也等不到 'end' —— 双方僵死（Node fetch/undici 上可复现）。
 */
function reject(req, res, body) {
  send(res, 403, body, null, { Connection: 'close' });
  res.once('finish', () => req.destroy());
  req.resume();
}

/**
 * 校验写请求来源。
 * 返回 { origin } —— origin 为请求的 Origin（无则 null，如桌面版同源 fetch 可能不带）；
 * 不合法时返回 { reject: 'forbidden cros-site request' }。
 * 注：Origin 必须优先于 Token 校验并立即回 4xx / 断连，避免“拒绝已到达的请求体”
 * 导致的 keep-alive 连接错位。
 */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return { origin: null };
  let host = '';
  try { host = new URL(origin).host; } catch (e) { return { reject: 'forbidden origin' }; }
  const rawHost = String(req.headers.host || '');
  if (!host || host.toLowerCase() !== rawHost.toLowerCase()) return { reject: 'forbidden origin' };
  return { origin };
}

/** 页面内联注入的 Token：必须在 Origin 允许的前提下才校验 */
function tokenAllowed(req, token) {
  return String(req.headers['x-dsf-token'] || '') === token;
}

/**
 * 创建服务实例（不自动 listen）。
 * @param {{rootDir:string, dataFile:string, token?:string, log?:Function,
 *          onSave?:Function, onFlush?:Function}} opts
 * @returns {import('http').Server}
 */
function createServer(opts) {
  const rootDir = path.resolve(opts.rootDir);
  const dataFile = path.resolve(opts.dataFile);
  const log = opts.log || (() => {});
  const onSave = opts.onSave || (() => {});
  const onFlush = opts.onFlush || (() => {});
  const token = opts.token || crypto.randomBytes(16).toString('hex');

  ensureDataFile(dataFile);

  function readState() {
    try {
      return fs.readFileSync(dataFile, 'utf8');
    } catch (e) {
      return 'null';
    }
  }

  function writeState(payload) {
    JSON.parse(payload); // 校验：非法 JSON 直接抛错
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    // 唯一临时名：并发写入时不会互相截断同一个 .tmp
    const tmp = dataFile + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, dataFile); // 原子替换
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_e) { /* ignore */ }
      throw e;
    }
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = HTML_PATH;

    const target = path.resolve(rootDir, '.' + rel);
    // 目录穿越与敏感目录防护
    if (!target.startsWith(rootDir + path.sep) && target !== rootDir) {
      return send(res, 403, '{"error":"forbidden"}');
    }
    // 数据文件本身不对外托管（同源页面本来就通过 /api/state 读写，无需直读）
    if (target === dataFile) return send(res, 403, '{"error":"forbidden"}');
    const relFromRoot = path.relative(rootDir, target);
    if (relFromRoot.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules')) {
      return send(res, 403, '{"error":"forbidden"}');
    }
    const ext = path.extname(target).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return send(res, 404, '{"error":"not found"}');
    }

    fs.readFile(target, (err, data) => {
      if (err) return send(res, 404, '{"error":"not found"}');
      let body = data;
      // index.html 内联注入本次会话的 Token（文件本身不含任何密钥）
      if (ext === '.html') {
        body = Buffer.from(data.toString('utf8').split(TOKEN_PLACEHOLDER).join(token), 'utf8');
      }
      send(res, 200, body, MIME[ext] || 'application/octet-stream');
    });
  }

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    // —— 防 DNS rebinding：Host 必须是回环地址 ——
    if (!hostAllowed(req)) return reject(req, res, '{"error":"forbidden host"}');

    // —— 预检请求：仅同源放行（浏览器跨站预检会因为无 CORS 头而失败）——
    if (req.method === 'OPTIONS') {
      const o = checkOrigin(req);
      if (o.reject) return reject(req, res, '{"error":"forbidden"}');
      return send(res, 204, '', null, {
        'Access-Control-Allow-Origin': req.headers.origin || 'null',
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-DSF-Token',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin'
      });
    }

    if (pathname === API_PATH) {
      // —— 数据接口访问控制：Origin 同源 + Token 匹配 ——
      const o = checkOrigin(req);
      if (o.reject) {
        log('[dsf] 已拒绝非同源数据接口请求（Origin: ' + req.headers.origin + '）');
        return reject(req, res, '{"error":"forbidden origin"}');
      }
      if (!tokenAllowed(req, token)) {
        log('[dsf] 已拒绝缺少有效令牌的数据接口请求（' + req.method + ' ' + pathname + '）');
        return reject(req, res, '{"error":"forbidden token"}');
      }
      const cors = o.origin ? { 'Access-Control-Allow-Origin': o.origin, Vary: 'Origin' } : null;

      if (req.method === 'GET') return send(res, 200, readState(), null, cors);
      if (req.method === 'PUT' || req.method === 'POST') {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (c) => {
          size += c.length;
          if (size > 20 * 1024 * 1024) { tooLarge = true; req.destroy(); return; } // 防异常大包
          chunks.push(c);
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            const payload = Buffer.concat(chunks).toString('utf8');
            writeState(payload);
            log('[dsf] 数据已保存 → ' + dataFile);
            onSave('save'); // 仅供调用方（桌面版自检）观察落盘事件
            send(res, 200, '{"ok":true}', null, cors);
          } catch (e) {
            log('[dsf] 保存失败：' + e.message);
            send(res, 500, JSON.stringify({ error: String(e.message || e) }), null, cors);
          }
        });
        return;
      }
      return send(res, 405, '{"error":"method not allowed"}', null, cors);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, '{"error":"method not allowed"}');
    }
    serveStatic(req, res, pathname);
  });

  server.dsfFlush = onFlush; // 供主进程在退出前主动落盘
  return server;
}

module.exports = { createServer, ensureDataFile, MIME, API_PATH, TOKEN_PLACEHOLDER };

/* ------------------------- 直接运行：纯 Node 服务器 ------------------------- */
if (require.main === module) {
  const rootDir = path.join(__dirname, '..');
  const dataFile = path.join(rootDir, 'dsf-data.json');
  const port = Number(process.argv[2] || process.env.DSF_PORT || 8000);

  const server = createServer({ rootDir, dataFile, log: (m) => console.log(m) });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/';
    console.log('');
    console.log('=====================================================');
    console.log('  DSF 服务器已启动（Node 版，无需 Python）');
    console.log('  打开：   ' + url);
    console.log('  数据文件： ' + dataFile);
    console.log('  关闭：   在此窗口按 Ctrl+C');
    console.log('=====================================================');
    console.log('');
    if (process.env.DSF_NO_BROWSER !== '1') {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
          : ['xdg-open', [url]];
      try { require('child_process').spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); }
      catch (e) { /* 打不开浏览器不影响使用 */ }
    }
  });
  server.on('error', (e) => {
    console.error('[dsf] 启动失败：' + e.message);
    process.exit(1);
  });
}
