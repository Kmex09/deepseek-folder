/* =========================================================================
 * tests/desktop-server.js — 内嵌服务（desktop/server.js）接口测试
 * -------------------------------------------------------------------------
 * 用法：node tests/desktop-server.js
 * 不依赖 Electron：直接以 Node 启动服务，验证 /api/state 读写、静态托管、
 * 目录穿越防护、非法 JSON 拒绝、首次启动自动创建数据文件，
 * 以及访问控制（回环 Host / 同源 Origin / 会话令牌）。
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { createServer } = require('../desktop/server');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-desktop-data.json');
const TOKEN = 'test-token-0123456789abcdef';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.error('  ✘ FAIL: ' + msg); }
}

/**
 * 可靠的删除：某些环境（实测 Node 24 + DSH 沙箱）下 fs.rmSync 会**静默失效**
 * ——既不删除也不抛错，于是残留文件会让下一次测试读到旧数据。
 * 这里先试 rmSync，再用 unlink/rmdir 兜底，并返回是否真的删干净了。
 */
function removePath(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { /* 继续兜底 */ }
  if (fs.existsSync(target)) {
    try {
      const st = fs.lstatSync(target);
      if (st.isDirectory()) {
        fs.readdirSync(target).forEach((name) => removePath(path.join(target, name)));
        fs.rmdirSync(target);
      } else {
        fs.unlinkSync(target);
      }
    } catch (e) { /* ignore */ }
  }
  return !fs.existsSync(target);
}

async function main() {
  // 起始清理必须可靠：残留会导致“GET /api/state 返回空数据”等假失败
  assert(removePath(TMP), '测试开始前清理临时数据文件');

  // 超时保护：任何一步卡住都不会让测试永久挂起
  const guard = setTimeout(() => {
    console.error('\n测试超时（60s），强制退出');
    process.exit(1);
  }, 60000);
  guard.unref && guard.unref();

  const server = createServer({ rootDir: ROOT, dataFile: TMP, log: () => {}, token: TOKEN });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const auth = { 'X-DeepSeek-Folder-Token': TOKEN };

  console.log('\n—— 首次启动 ——');
  assert(fs.existsSync(TMP), '启动时自动创建数据文件');
  const initial = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert(Array.isArray(initial.folders) && initial.folders.length === 0, 'GET /api/state 返回空数据');

  console.log('\n—— 写入 / 读取 ——');
  const sample = {
    v: 1,
    savedAt: Date.now(),
    folders: [{ id: 'f1', name: '桌面版测试', parentId: null, createdAt: 1, pinned: false }],
    sessions: [{
      id: 's1', folderId: 'f1', title: '中文标题测试',
      url: 'https://chat.deepseek.com/a/chat/s/desk1',
      createdAt: 1, updatedAt: 1, lastOpenedAt: null, pinned: false
    }],
    recentClosed: [],
    settings: {}
  };
  const putRes = await fetch(base + '/api/state', {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
    body: JSON.stringify(sample)
  });
  assert(putRes.ok, 'PUT /api/state 返回 200');
  const back = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert(back.folders[0].name === '桌面版测试', '中文内容往返无乱码');
  assert(back.sessions[0].title === '中文标题测试', '会话数据写入成功');
  const onDisk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert(onDisk.folders.length === 1, '数据确实落到磁盘文件');

  console.log('\n—— 访问控制 ——');
  const noToken = await fetch(base + '/api/state');
  assert(noToken.status === 403, '无令牌 GET 被拒绝（' + noToken.status + '）');
  const badToken = await fetch(base + '/api/state', { headers: { 'X-DeepSeek-Folder-Token': 'wrong' } });
  assert(badToken.status === 403, '错误令牌被拒绝（' + badToken.status + '）');
  // 模拟恶意网页：简单请求（text/plain 不触发预检）+ 伪造 Origin
  const csrf = await fetch(base + '/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', 'Origin': 'https://evil.example', ...auth },
    body: JSON.stringify({ v: 1, folders: [], sessions: [], recentClosed: [], pwned: true })
  });
  assert(csrf.status === 403, '跨站 Origin 的 PUT 被拒绝（' + csrf.status + '）');
  assert(JSON.parse(fs.readFileSync(TMP, 'utf8')).folders.length === 1, '被拒绝的请求没有破坏数据文件');
  const crossRead = await fetch(base + '/api/state', {
    headers: { 'Origin': 'https://evil.example', ...auth }
  });
  assert(crossRead.status === 403, '跨站 Origin 的 GET 被拒绝（' + crossRead.status + '）');
  const preflight = await fetch(base + '/api/state', {
    method: 'OPTIONS',
    headers: { 'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'PUT' }
  });
  assert(preflight.status === 403 && preflight.headers.get('access-control-allow-origin') === null,
    '跨站预检不返回允许头（浏览器会拦下真实请求）');
  // Host 头无法用 fetch 伪造，这里直接用 http 模块发一个带假 Host 的请求
  const rebindStatus = await new Promise((resolve, reject) => {
    const req = require('http').request({
      host: '127.0.0.1', port, path: '/api/state', method: 'GET',
      headers: { Host: 'evil.example', 'X-DeepSeek-Folder-Token': TOKEN }
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert(rebindStatus === 403, '非回环 Host 被拒绝（DNS rebinding 防护，' + rebindStatus + '）');
  const page = await (await fetch(base + '/')).text();
  assert(page.includes(TOKEN), 'index.html 内联注入会话令牌');
  const diskText = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert(diskText.includes('__DEEPSEEK_FOLDER_TOKEN__') && !diskText.includes(TOKEN), '磁盘上的 index.html 不含真实令牌');

  console.log('\n—— 静态托管与防护 ——');
  const home = await fetch(base + '/');
  const html = await home.text();
  assert(home.ok && html.includes('DF'), 'GET / 返回 index.html');
  assert((home.headers.get('content-type') || '').includes('text/html'), '/ 以 text/html 返回（含 charset）');
  const css = await fetch(base + '/css/style.css');
  assert(css.ok && (css.headers.get('content-type') || '').includes('text/css'), 'CSS 以正确 MIME 返回');
  const traversal = await fetch(base + '/node_modules/electron/package.json');
  assert(traversal.status === 403 || traversal.status === 404, '禁止访问 node_modules（返回 ' + traversal.status + '）');
  const hidden = await fetch(base + '/.npm-cache/');
  assert(hidden.status === 403 || hidden.status === 404, '禁止访问隐藏目录（返回 ' + hidden.status + '）');
  const dataLeak = await fetch(base + '/tests/.tmp-desktop-data.json');
  assert(dataLeak.status === 403 || dataLeak.status === 404, '数据文件不经静态托管外泄（返回 ' + dataLeak.status + '）');

  console.log('\n—— 异常输入 ——');
  const bad = await fetch(base + '/api/state', {
    method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: '{ not json'
  });
  assert(bad.status === 500, '非法 JSON 被拒绝（500）');
  const afterBad = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert(afterBad.folders.length === 1, '非法写入未破坏原数据');

  // 收尾：先关掉所有连接再关服务，最后只设置退出码让事件循环自然退出
  // （在 Windows 上直接 process.exit 会与未断开的 keep-alive 连接竞争，触发 libuv 断言）
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((res) => server.close(res));
  assert(removePath(TMP), '测试结束后临时数据文件已清理');

  /* -----------------------------------------------------------------------
   * v0.5.0 项目改名（DSF → DeepSeek Folder）：旧数据文件自动迁移
   * --------------------------------------------------------------------- */
  console.log('\n—— 改名迁移：旧数据文件 dsf-data.json → 新文件 ——');
  const legacyDir = path.join(__dirname, '.tmp-legacy-migrate');
  removePath(legacyDir);
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyFile = path.join(legacyDir, 'dsf-data.json');
  const migratedFile = path.join(legacyDir, 'deepseek-folder-data.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    v: 1,
    savedAt: 123,
    folders: [{ id: 'lf1', name: '旧版文件夹', parentId: null, createdAt: 1, pinned: false }],
    sessions: [],
    recentClosed: [],
    settings: {}
  }), 'utf8');

  const server2 = createServer({ rootDir: ROOT, dataFile: migratedFile, log: () => {}, token: TOKEN });
  await new Promise((res, rej) => { server2.once('error', rej); server2.listen(0, '127.0.0.1', res); });
  const base2 = 'http://127.0.0.1:' + server2.address().port;

  assert(fs.existsSync(migratedFile), '启动时按新文件名创建/迁移数据文件');
  const migratedData = await (await fetch(base2 + '/api/state', { headers: auth })).json();
  assert(migratedData.folders.length === 1 && migratedData.folders[0].name === '旧版文件夹',
    '迁移后能从新文件读到旧数据（1 个文件夹）');
  assert(fs.existsSync(legacyFile), '旧数据文件保留未删除（可回退旧版本）');

  if (typeof server2.closeAllConnections === 'function') server2.closeAllConnections();
  await new Promise((res) => server2.close(res));
  assert(removePath(legacyDir), '测试结束后迁移测试目录已清理');

  console.log('\n========================================');
  console.log('结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('测试异常：', e);
  removePath(TMP);
  process.exitCode = 1;
});
