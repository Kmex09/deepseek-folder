/* =========================================================================
 * tests/smoke.js — 无浏览器冒烟测试
 * -------------------------------------------------------------------------
 * 用法：node tests/smoke.js
 * 用最小化的 window / localStorage 桩加载 df.utils.js 与 df.store.js，
 * 对核心数据流与链接解析做断言（不依赖真实 DOM）。
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------- 浏览器环境桩 ---------- */
const mem = {};
let writeCount = 0;      // 记录 localStorage 真实写入次数（验证批量提交）
const fakeLocalStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { writeCount++; mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};

// 足够解析 <a href> 的最小 DOMParser 桩（覆盖 utils 的 HTML 锚点路径）
class FakeDOMParser {
  parseFromString(html) {
    const anchors = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      const label = m[2].replace(/<[^>]+>/g, '');
      anchors.push({
        getAttribute: (n) => (n === 'href' ? href : null),
        textContent: label
      });
    }
    return { querySelectorAll: () => anchors, querySelector: () => null };
  }
}

const windowObj = { open: () => null }; // openSession 会调用 window.open
const sandbox = {
  window: windowObj,
  document: { createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }) },
  localStorage: fakeLocalStorage,
  URL,
  URLSearchParams,
  crypto,
  DOMParser: FakeDOMParser,
  console
};
vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

load('js/df.utils.js');
load('js/df.store.js');

const DF = sandbox.window.DF;
const utils = DF.utils;
const store = DF.store;

/* ---------- 简单断言工具 ---------- */
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.error('  ✘ FAIL: ' + msg); }
}
function section(name) { console.log('\n—— ' + name + ' ——'); }

/* ---------- utils：链接解析 ---------- */
section('utils.extractDeepseekUrls');
const text =
  '今天聊了 https://chat.deepseek.com/a/chat/s/aaaa1111 和 https://chat.deepseek.com/a/chat/s/bbbb2222。' +
  '末尾带标点:https://chat.deepseek.com/a/chat/s/cccc3333)。' +
  '非DeepSeek链接 https://example.com/x?a=1 不应出现。';
const urls = utils.extractDeepseekUrls(text);
assert(urls.length === 3, '识别出 3 个 DeepSeek 链接（实际 ' + urls.length + '）');
assert(urls.includes('https://chat.deepseek.com/a/chat/s/cccc3333'), '去除末尾全角标点');
assert(!urls.some((u) => u.includes('example.com')), '忽略非 DeepSeek 域名');

section('utils.isDeepseekUrl');
assert(utils.isDeepseekUrl('https://chat.deepseek.com/a/chat/s/123'), 'chat.deepseek.com 合法');
assert(utils.isDeepseekUrl('https://deepseek.com/'), 'deepseek.com 合法');
assert(utils.isDeepseekUrl('https://share.deepseek.com/x'), '子域名合法');
assert(!utils.isDeepseekUrl('https://deepseek.com.evil.io/'), '伪造域名拒绝');
assert(!utils.isDeepseekUrl('https://www.baidu.com/'), '普通域名拒绝');

section('utils.buildCandidates');
const cands = utils.buildCandidates({
  uriList: 'https://chat.deepseek.com/a/chat/s/uuuu0000\n',
  html: '<a href="https://chat.deepseek.com/a/chat/s/vvvv1111">相对论入门</a>',
  plain: '拖来的文本 https://chat.deepseek.com/a/chat/s/wwww2222'
});
assert(cands.length === 3, '从三种数据源合并出 3 个候选（实际 ' + cands.length + '）');
assert(cands.some((c) => c.url.includes('vvvv1111') && c.title === '相对论入门'), 'HTML 锚文本作为标题');

/* ---------- store：文件夹与会话 CRUD ---------- */
section('store 初始状态');
assert(store.stats().folders === 0 && store.stats().sessions === 0, '空数据初始化');

section('文件夹操作');
const f1 = store.createFolder('学习');
const f2 = store.createFolder('工作');
assert(store.stats().folders === 2, '创建 2 个文件夹');
assert(store.renameFolder(f1.id, '学习笔记').name === '学习笔记', '重命名文件夹');
store.togglePinFolder(f1.id);
assert(store.getFolder(f1.id).pinned === true, '固定文件夹');
assert(store.folderSessionCount(f1.id) === 0, '文件夹会话计数为 0');

section('导入');
let stat = store.importItems(
  [{ url: 'https://chat.deepseek.com/a/chat/s/s1', title: '牛顿力学' },
   { url: 'https://chat.deepseek.com/a/chat/s/s2', title: '量子力学' }],
  f1.id);
assert(stat.imported === 2 && stat.folder.name === '学习笔记', '批量导入 2 条');
assert(store.folderSessionCount(f1.id) === 2, '会话计数更新');

stat = store.importItems([{ url: 'https://chat.deepseek.com/a/chat/s/s1' }], f1.id);
assert(stat.duplicates === 1, '同文件夹重复链接被跳过');
stat = store.importItems([{ url: 'https://www.baidu.com/' }], f1.id);
assert(stat.invalid === 1, '非 DeepSeek 链接视为无效');
assert(store.stats().sessions === 2, '会话总数仍为 2');

section('搜索');
let hit = store.search('量子');
assert(hit.sessions.length === 1 && hit.sessions[0].title === '量子力学', '按标题命中搜索');
hit = store.search('不存在的内容xyz');
assert(hit.sessions.length === 0 && hit.folders.length === 0, '无匹配返回空');

section('固定 / 打开 / 关闭（归档到最近关闭）');
const s1 = store.getSession(store.data.sessions[0].id);
store.togglePinSession(s1.id);
assert(store.getSession(s1.id).pinned === true, '固定会话');
store.openSession(s1.id); // 桩环境 window.open 不存在 → 直接调用会抛错？
assert(store.getSession(s1.id).lastOpenedAt > 0, '记录打开时间');

let rec = store.removeSession(s1.id);
assert(rec && store.stats().recent === 1, '关闭会话 → 进入最近关闭');
assert(store.stats().sessions === 1, '会话从文件夹移除');

section('最近关闭恢复');
let res = store.restoreRecent(rec.id);
assert(res && store.stats().recent === 0, '恢复后最近关闭清空');
assert(res.session.folderId === f1.id, '恢复到原文件夹');
assert(store.stats().sessions === 2, '会话数恢复为 2');

section('删除文件夹（会话自动归档）');
const s2 = store.data.sessions.find((x) => x.folderId === f2.id);
if (!s2) { store.moveSession(store.data.sessions[0].id, f2.id); }
const delRes = store.deleteFolder(f2.id);
assert(delRes && delRes.sessions >= 1, '删除含 ' + delRes.sessions + ' 个会话的文件夹');
assert(store.getFolder(f2.id) === null, '文件夹已删除');
assert(store.stats().recent >= 1, '其中会话进入最近关闭');

section('序列化持久化');
const json1 = store.exportJson();
assert(typeof json1 === 'string' && JSON.parse(json1).folders.length === 1, '导出 JSON 正常');
const backup = JSON.stringify(JSON.parse(json1));
load('js/df.store.js'); // 重新加载（同沙箱覆盖 store 实例，验证从 localStorage 恢复）
const store2 = sandbox.window.DF.store;
assert(store2.stats().folders === 1, '重载后从 localStorage 恢复 1 个文件夹');
store2.importJson(backup);
assert(store2.stats().folders === 1 && store2.stats().sessions === 1, '导入备份 JSON 覆盖成功');
assert(store2.stats().recent === 1, '最近关闭随备份恢复');

/* =========================================================================
 * 以下为 v0.2.0 子文件夹（嵌套层级）测试，使用 reload 后的实例 store2
 * ========================================================================= */

section('子文件夹：创建与树查询');
const rootA = store2.createFolder('学习');
const subB = store2.createFolder('数学', rootA.id);
const subC = store2.createFolder('微积分', subB.id);
assert(store2.getFolder(subB.id).parentId === rootA.id, '子文件夹 parentId 指向父级');
assert(store2.getFolder(rootA.id).parentId === null, '根目录 parentId 为 null');
assert(store2.childrenOf(rootA.id).length === 1 && store2.childrenOf(rootA.id)[0].name === '数学', 'childrenOf 返回直属子级');
assert(store2.childrenOf(null).some((f) => f.id === rootA.id), '根目录只含根级文件夹');
assert(store2.folderChain(subC.id).map((f) => f.name).join(' / ') === '学习 / 数学 / 微积分', 'folderChain 祖先链正确');
assert(store2.folderPathLabel(subC.id) === '学习 / 数学 / 微积分', 'folderPathLabel 显示完整路径');
assert(store2.subtreeFolderIds(rootA.id).length === 3, 'subtreeFolderIds 含全部后代');

section('子文件夹：子树统计');
store2.createSession({ folderId: subC.id, title: '导数', url: 'https://chat.deepseek.com/a/chat/s/n1' });
assert(store2.subtreeSessionCount(rootA.id) === 1, '子树会话统计包含后代文件夹中的会话');
store2.createSession({ folderId: rootA.id, title: '学习总览', url: 'https://chat.deepseek.com/a/chat/s/n2' });
assert(store2.subtreeSessionCount(rootA.id) === 2, '含直属会话后为 2');
assert(store2.folderSessionCount(rootA.id) === 1, 'folderSessionCount 只统计直属会话');

section('子文件夹：移动与防环');
assert(store2.moveFolder(rootA.id, subC.id) === null, '不能把父级移入自己后代（防环）');
assert(store2.moveFolder(subB.id, subB.id) === null, '不能移入自身');
assert(store2.moveFolder(subB.id, rootA.id) !== null, '移动到当前父级为无操作（合法）');
assert(store2.moveFolder(subC.id, null) !== null && store2.getFolder(subC.id).parentId === null, '移动到根目录成功');
assert(store2.childrenOf(subB.id).length === 0, '移出后父级不再包含它');
store2.moveFolder(subC.id, subB.id);
assert(store2.getFolder(subC.id).parentId === subB.id, '移回子级成功');

section('子文件夹：删除整棵子树并归档');
const tmp = store2.createFolder('临时项目');
const tmpC = store2.createFolder('子目录', tmp.id);
store2.createSession({ folderId: tmpC.id, title: '子目录会话', url: 'https://chat.deepseek.com/a/chat/s/n3' });
const delNested = store2.deleteFolder(tmp.id);
assert(delNested.folders === 1 && delNested.sessions === 1, '级联删除：1 个子文件夹 + 1 个会话');
assert(store2.getFolder(tmp.id) === null && store2.getFolder(tmpC.id) === null, '整棵子树被移除');
const recDel = store2.data.recentClosed.find((r) => r.folderName === '子目录');
assert(!!recDel && recDel.parentId === tmp.id, '归档记录了原父级 parentId');
const rr = store2.restoreRecent(recDel.id);
assert(rr.folder.name === '子目录' && rr.folder.parentId === null, '父级已删除时恢复到根目录并重建文件夹');
assert(store2.getSession(rr.session.id).folderId === rr.folder.id, '会话恢复到重建的文件夹');

section('子文件夹：整体移动后层级保持');
const mv = store2.moveFolder(rootA.id, rr.folder.id);
assert(mv && mv.parentId === rr.folder.id, '整棵子树（含后代）移动到新位置');
assert(store2.getFolder(subB.id).parentId === rootA.id && store2.getFolder(subC.id).parentId === subB.id, '后代层级保持不变');
assert(store2.subtreeSessionCount(rr.folder.id) === 3, '移动后子树会话统计正确（2 直属链 + 1）');

section('持久化元数据与外部数据接入（v0.2.1）');
const savedBefore = store2.data.savedAt || 0;
store2.createFolder('时间戳验证');
assert(store2.data.savedAt > 0 && store2.data.savedAt >= savedBefore, '每次 commit 保存都盖上 savedAt 时间戳');
const remoteObj = JSON.parse(store2.exportJson());
remoteObj.savedAt = Date.now() + 1e9; // 模拟更新的数据文件
const folderCountBefore = store2.stats().folders;
store2.hydrateFrom(remoteObj);
assert(store2.stats().folders === folderCountBefore, 'hydrateFrom 采纳外部数据并通知（数据未被丢弃）');
assert(store2.data.savedAt >= remoteObj.savedAt, 'hydrateFrom 后保留外部时间戳');
const snap = store2.fileSnapshot();
assert(typeof snap === 'string' && JSON.parse(snap).savedAt > 0, 'fileSnapshot 返回含时间戳的快照');

/* =========================================================================
 * v0.3.2：索引缓存、批量提交、URL 归一化去重
 * ========================================================================= */

section('urlKey：同一条会话的等价写法（v0.3.2）');
const k1 = utils.urlKey('https://chat.deepseek.com/a/chat/s/abc');
assert(k1 === utils.urlKey('https://chat.deepseek.com/a/chat/s/abc/'), '尾斜杠不产生新会话');
assert(k1 === utils.urlKey('https://chat.deepseek.com/a/chat/s/abc#anchor'), '#锚点不产生新会话');
assert(k1 === utils.urlKey('https://chat.deepseek.com/a/chat/s/abc?'), '空查询串不产生新会话');
assert(utils.urlKey('https://chat.deepseek.com/a/chat/s/a?b=1&a=2') ===
  utils.urlKey('https://chat.deepseek.com/a/chat/s/a?a=2&b=1'), '查询参数顺序无关');
assert(k1 !== utils.urlKey('https://chat.deepseek.com/a/chat/s/abc?utm=1'),
  '非空查询串仍视为不同地址（避免误合并不同会话）');
assert(utils.urlKey('https://chat.deepseek.com/a/chat/s/abc') !==
  utils.urlKey('https://chat.deepseek.com/a/chat/s/abd'), '不同会话 id 仍视为不同');

section('导入去重按归一化比较（v0.3.2）');
const dupFolder = store2.createFolder('去重验证');
let dupStat = store2.importItems([{ url: 'https://chat.deepseek.com/a/chat/s/dd1' }], dupFolder.id);
assert(dupStat.imported === 1, '首次导入 1 条');
dupStat = store2.importItems([
  { url: 'https://chat.deepseek.com/a/chat/s/dd1/' },
  { url: 'https://chat.deepseek.com/a/chat/s/dd1#x' }
], dupFolder.id);
assert(dupStat.imported === 0 && dupStat.duplicates === 2, '尾斜杠 / #锚点变体被判为重复');
assert(store2.folderSessionCount(dupFolder.id) === 1, '文件夹内仍只有 1 条会话');
dupStat = store2.importItems([
  { url: 'https://chat.deepseek.com/a/chat/s/e1' },
  { url: 'https://chat.deepseek.com/a/chat/s/e1' }
], dupFolder.id);
assert(dupStat.imported === 1 && dupStat.duplicates === 1, '同一批次内的重复也会被拦住');

section('批量提交：一次操作只落盘一次（v0.3.2）');
const batchFolder = store2.createFolder('批量写入验证');
const before = writeCount;
const bigItems = [];
for (let i = 0; i < 50; i++) bigItems.push({ url: 'https://chat.deepseek.com/a/chat/s/bulk' + i });
const bulkStat = store2.importItems(bigItems, batchFolder.id);
const usedWrites = writeCount - before;
assert(bulkStat.imported === 50, '导入 50 条成功');
assert(usedWrites === 1, '导入 50 条只写 1 次 localStorage（实际 ' + usedWrites + '）');
const beforeRestore = writeCount;
const recBulk = store2.removeSession(store2.sessionsOf(batchFolder.id)[0].id);
store2.restoreRecent(recBulk.id);
assert(writeCount - beforeRestore <= 3, '关闭 + 恢复各只提交一次（实际 ' + (writeCount - beforeRestore) + ' 次）');

section('索引缓存与全表扫描结果一致（v0.3.2）');
const chainRoot = store2.createFolder('索引根');
const chainSub = store2.createFolder('索引子', chainRoot.id);
const chainLeaf = store2.createFolder('索引叶', chainSub.id);
store2.createSession({ folderId: chainLeaf.id, title: '叶会话', url: 'https://chat.deepseek.com/a/chat/s/leaf1' });
store2.createSession({ folderId: chainRoot.id, title: '根会话', url: 'https://chat.deepseek.com/a/chat/s/root1' });
assert(store2.subtreeSessionCount(chainRoot.id) === 2, '子树会话数含所有后代（2）');
assert(store2.subtreeSessionCount(chainSub.id) === 1, '中间层子树会话数为 1');
assert(store2.folderSessionCount(chainRoot.id) === 1, '直属会话数仍为 1');
assert(store2.subtreeFolderIds(chainRoot.id).length === 3, '子树文件夹集合含自身与全部后代');
assert(store2.childrenOf(chainSub.id).length === 1 && store2.childrenOf(chainSub.id)[0].id === chainLeaf.id,
  'childrenOf 返回正确子级');
// 与「朴素实现」交叉验证：索引缓存与全表扫描必须永远一致
function naiveSubtreeSessions(rootId) {
  const ids = [];
  const walk = (id) => { ids.push(id); store2.childrenOf(id).forEach((c) => walk(c.id)); };
  walk(rootId);
  return store2.data.sessions.filter((s) => ids.includes(s.folderId)).length;
}
let consistent = true;
for (const f of store2.data.folders) {
  if (store2.subtreeSessionCount(f.id) !== naiveSubtreeSessions(f.id)) consistent = false;
}
assert(consistent, '全部文件夹的子树计数与朴素实现逐一对齐');
const revBefore = store2.revision();
store2.renameFolder(chainLeaf.id, '改名后的叶');
assert(store2.revision() > revBefore, '数据变动后 revision 递增（缓存失效依据）');
assert(store2.childrenOf(chainSub.id)[0].name === '改名后的叶', '改名后索引缓存已重建（不是陈旧值）');
const moved = store2.moveFolder(chainLeaf.id, chainRoot.id);
assert(moved && store2.subtreeSessionCount(chainRoot.id) === 2 && store2.subtreeSessionCount(chainSub.id) === 0,
  '移动后子树计数随索引更新');

section('归档顺序与折叠无关的会话列表（v0.3.2）');
const orderFolder = store2.createFolder('归档顺序');
const orderUrls = ['o1', 'o2', 'o3'].map((x) => 'https://chat.deepseek.com/a/chat/s/' + x);
store2.importItems(orderUrls.map((u, i) => ({ url: u, title: '顺序' + i })), orderFolder.id);
store2.deleteFolder(orderFolder.id);
const archived = store2.data.recentClosed.slice(0, 3).map((r) => r.title);
assert(archived.join(',') === '顺序0,顺序1,顺序2',
  '级联删除后归档顺序与原顺序一致（实际 ' + archived.join(',') + '）');

/* =========================================================================
 * v0.5.0 项目改名（DSF → DeepSeek Folder）：旧存储键自动迁移
 * ========================================================================= */

section('改名迁移：只有旧键时自动迁移');
delete mem['deepseek-folder.data.v1'];
delete mem['dsf.data.v1'];
mem['dsf.data.v1'] = JSON.stringify({
  v: 1,
  savedAt: Date.now() - 1000,
  folders: [{ id: 'legacy-f1', name: '旧版文件夹', parentId: null, createdAt: 1, pinned: false }],
  sessions: [{
    id: 'legacy-s1', folderId: 'legacy-f1', title: '旧版会话',
    url: 'https://chat.deepseek.com/a/chat/s/legacy1',
    createdAt: 1, updatedAt: 1, lastOpenedAt: null, pinned: false
  }],
  recentClosed: [],
  settings: {}
});
load('js/df.store.js'); // 重新加载 → 新实例应从旧键读取
const store3 = sandbox.window.DF.store;
assert(store3.stats().folders === 1 && store3.stats().sessions === 1,
  '旧键数据被完整读取（1 文件夹 / 1 会话）');
assert(store3.wasMigrated() === true, 'store.wasMigrated() 报告已迁移');
assert(!!mem['deepseek-folder.data.v1'], '迁移后写入了新键 deepseek-folder.data.v1');
const migratedBack = JSON.parse(mem['deepseek-folder.data.v1']);
assert(migratedBack.folders[0].name === '旧版文件夹' && migratedBack.sessions[0].title === '旧版会话',
  '新键内容与旧数据一致');
assert(!!mem['dsf.data.v1'], '旧键保留未删除（可回退旧版本）');

section('改名迁移：新键存在时优先且不误报');
mem['deepseek-folder.data.v1'] = JSON.stringify({
  v: 1, savedAt: Date.now(),
  folders: [{ id: 'new-f1', name: '新版文件夹', parentId: null, createdAt: 1, pinned: false }],
  sessions: [], recentClosed: [], settings: {}
});
load('js/df.store.js');
const store4 = sandbox.window.DF.store;
assert(store4.stats().folders === 1 && store4.data.folders[0].name === '新版文件夹',
  '新键存在时直接使用新键（不被旧键覆盖）');
assert(store4.wasMigrated() === false, '未发生迁移时不误报迁移');

console.log('\n========================================');
console.log('结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
