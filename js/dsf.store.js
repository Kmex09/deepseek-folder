/* =========================================================================
 * dsf.store.js — DSF 数据存储层
 * -------------------------------------------------------------------------
 * 单一数据源 + localStorage 持久化 + 订阅通知。
 *
 * 数据结构（v1，自 v0.2.0 起支持任意深度子文件夹）：
 *   data.folders      : [{ id, name, parentId|null, createdAt, pinned }]
 *     —— parentId 为 null 表示根目录；子文件夹 parentId 指向父文件夹。
 *   data.sessions     : [{ id, folderId, title, url, createdAt, updatedAt,
 *                         lastOpenedAt, pinned }]
 *     —— 会话只直属其所在文件夹（不继承子文件夹会话）。
 *   data.recentClosed : [{ id, title, url, folderId, folderName, parentId,
 *                         closedAt }]
 *     —— 「关闭」(从文件夹移除) 的会话自动归档；parentId 用于恢复时定位。
 *   data.settings     : { sidebarCollapsed, lastImportFolderId }
 * 所有变更方法均会：修改内存 → 立即写 localStorage → 通知订阅者重绘。
 *
 * 性能约定（v0.3.2）：
 *   1) 查询走惰性索引缓存（indexCache）。任何数据变动都经 commit()/mutate()
 *      递增 dataRev 使缓存失效，因此缓存永不陈旧——不要绕过它们改 data。
 *   2) 批量操作（导入 / 删文件夹 / 恢复归档）用 mutate() 包住，整批只做一次
 *      落盘 + 一次通知，避免“每条都全量序列化一次 + 全量重绘一次”。
 * ========================================================================= */
(function (global) {
  'use strict';

  var utils = global.DSF.utils;
  var STORAGE_KEY = 'dsf.data.v1';
  var RECENT_CAP = 50;   // 「最近关闭」归档上限
  var DEFAULT_TITLE = '未命名会话';

  function emptyData() {
    return {
      v: 1,
      savedAt: null,   // 最近一次成功写入时间，用于本地/文件数据比较新旧
      folders: [],
      sessions: [],
      recentClosed: [],
      settings: { sidebarCollapsed: false, lastImportFolderId: '' }
    };
  }

  /** 结构修补：旧数据（平铺文件夹）也能读取并升级为树形结构 */
  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return emptyData();
    var d = emptyData();
    d.savedAt = raw.savedAt || null;
    d.folders = (Array.isArray(raw.folders) ? raw.folders : []).filter(function (f) {
      return f && f.id;
    }).map(function (f) {
      return {
        id: f.id,
        name: String(f.name == null ? '' : f.name),
        parentId: (typeof f.parentId === 'string' && f.parentId) ? f.parentId : null,
        createdAt: f.createdAt || Date.now(),
        pinned: !!f.pinned
      };
    });
    // 清理指向不存在父级的孤儿文件夹（视为根）
    var valid = {};
    d.folders.forEach(function (f) { valid[f.id] = true; });
    d.folders.forEach(function (f) {
      if (f.parentId && !valid[f.parentId]) f.parentId = null;
    });
    d.sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).filter(function (s) {
      return s && s.id;
    }).map(function (s) {
      return {
        id: s.id,
        folderId: s.folderId || null,
        title: String(s.title == null ? '' : s.title),
        url: String(s.url || ''),
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || s.createdAt || Date.now(),
        lastOpenedAt: s.lastOpenedAt || null,
        pinned: !!s.pinned
      };
    });
    d.recentClosed = (Array.isArray(raw.recentClosed) ? raw.recentClosed : []).filter(function (r) {
      return r && r.id;
    }).map(function (r) {
      return {
        id: r.id,
        title: String(r.title == null ? '' : r.title),
        url: String(r.url || ''),
        folderId: r.folderId || null,
        folderName: String(r.folderName || ''),
        parentId: (typeof r.parentId === 'string' && r.parentId) ? r.parentId : null,
        closedAt: r.closedAt || Date.now()
      };
    });
    d.settings = Object.assign({}, d.settings, raw.settings || {});
    return d;
  }

  function createStore() {
    var data = null;
    var listeners = [];
    var memoryOnly = false; // localStorage 不可用（隐私模式 / 沙箱）时的降级标志
    var dataRev = 0;        // 数据版本号：每次真实变动 +1，使索引缓存失效
    var batchDepth = 0;     // > 0 时处于批量操作中：挂起保存与通知

    /* ---------------------------- 索引缓存 ----------------------------
     * 侧边栏目录树每行都要「子树会话数」，若每次都重新过滤 sessions
     * （O(文件夹数 × 会话数)）规模一大就会卡住输入。这里一次性构建
     * 全部派生数据，随 dataRev 失效重建，单次渲染内多次查询共用一份。
     * ----------------------------------------------------------------- */
    var indexCache = { rev: -1 };
    var EMPTY = [];

    function buildIndex() {
      var folderById = new Map();
      var sessionById = new Map();
      var children = new Map();
      var directCount = new Map();
      var subtreeCount = new Map();
      var byFolder = new Map();
      var urlKeys = new Set();
      var folderSearch = [];
      var sessionSearch = [];
      var i, f, s, k, pid;

      for (i = 0; i < data.folders.length; i++) {
        f = data.folders[i];
        folderById.set(f.id, f);
        folderSearch.push(String(f.name || '').toLowerCase());
        pid = f.parentId || null;
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid).push(f);
      }

      var key = utils.urlKey;
      for (i = 0; i < data.sessions.length; i++) {
        s = data.sessions[i];
        sessionById.set(s.id, s);
        sessionSearch.push((String(s.title || '') + '\n' + String(s.url || '')).toLowerCase());
        k = s.folderId || null;
        directCount.set(k, (directCount.get(k) || 0) + 1);
        if (!byFolder.has(k)) byFolder.set(k, []);
        byFolder.get(k).push(s);
        urlKeys.add(key(s.url));
      }

      // 子树会话数：自底向上累加（含链路防御，避免异常数据成环时死循环）
      for (i = 0; i < data.sessions.length; i++) {
        s = data.sessions[i];
        k = s.folderId || null;
        var guard = 0;
        while (k && folderById.has(k) && guard++ < 1000) {
          subtreeCount.set(k, (subtreeCount.get(k) || 0) + 1);
          k = folderById.get(k).parentId || null;
        }
      }

      // 子树文件夹 id 集合
      var selfAndDesc = new Map();
      for (i = 0; i < data.folders.length; i++) {
        var id = data.folders[i].id;
        var acc = selfAndDesc.get(id);
        if (!acc) { acc = new Set(); selfAndDesc.set(id, acc); }
        acc.add(id);
        var cur = data.folders[i].parentId || null;
        var g2 = 0;
        while (cur && folderById.has(cur) && g2++ < 1000) {
          var up = selfAndDesc.get(cur);
          if (!up) { up = new Set(); selfAndDesc.set(cur, up); }
          up.add(id);
          cur = folderById.get(cur).parentId || null;
        }
      }

      indexCache = {
        rev: dataRev,
        folderById: folderById,
        sessionById: sessionById,
        children: children,
        directCount: directCount,
        subtreeCount: subtreeCount,
        byFolder: byFolder,
        urlKeys: urlKeys,
        selfAndDesc: selfAndDesc,
        // 搜索用的预小写文本（与 folders / sessions 同下标对应）
        folderSearch: folderSearch,
        sessionSearch: sessionSearch
      };
    }

    function idx() {
      if (indexCache.rev !== dataRev) buildIndex();
      return indexCache;
    }

    /**
     * 写入浏览器本地存储（每次真实保存都会盖上时间戳）。
     * 写失败时回滚时间戳并标记降级，避免与数据文件比较新旧时误判。
     */
    function safeSet() {
      if (memoryOnly) return;
      data.savedAt = Date.now();
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
      catch (e) {
        memoryOnly = true;
        data.savedAt = null;
        resetIndex();
      }
    }

    /** 数据已被外部直接改动（如内部按 id 匹配更新）：强制索引重建 */
    function resetIndex() { indexCache.rev = -1; dataRev++; }

    /* ------------------------------ 持久化 ------------------------------ */
    // 探测键与正式数据键分离：绝不在加载时写/删正式数据
    var PROBE_KEY = '__dsf_storage_probe__';

    function load() {
      if (!data) {
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY)); }
        catch (e) { raw = null; }
        data = migrate(raw);
        // 用独立的探测键校验 localStorage 是否真的可写
        // （部分隐私模式 / file:// 沙箱对任何写入都会抛 SecurityError / QuotaExceeded）
        try {
          localStorage.setItem(PROBE_KEY, '1');
          localStorage.removeItem(PROBE_KEY);
        } catch (e) {
          memoryOnly = true;
        }
      }
      return data;
    }

    /** 通知订阅者重绘（不落盘；用于外部数据接入后同步界面） */
    function notify() {
      listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 渲染错误不拖垮数据层 */ } });
    }

    function commit() {
      if (batchDepth > 0) return; // 批量操作中：只在最外层收尾一次
      dataRev++;
      safeSet();
      notify();
    }

    /**
     * 批量变更：整批只落盘一次、只通知一次。
     * 期间被调用的 createFolder / createSession 等不再是“一次操作一次写”，
     * 这正是导入 200 条链接不再卡顿的原因。
     */
    function mutate(fn) {
      batchDepth++;
      try {
        return fn();
      } finally {
        batchDepth--;
        if (batchDepth === 0) commit();
      }
    }

    /**
     * 采用一份外部数据（如随 server.py 保存的 dsf-data.json）作为当前状态。
     * 只更新内存并通知重绘，不主动回写。
     */
    function hydrateFrom(parsed) {
      data = migrate(parsed);
      resetIndex();
      notify();
      return data;
    }

    function subscribe(fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    /* ------------------------------ 查询工具 ------------------------------ */
    // 全部走索引（O(1) / O(子项数)），不再每次全表过滤

    function getFolder(id) {
      if (!id) return null;
      return idx().folderById.get(id) || null;
    }

    function getSession(id) {
      if (!id) return null;
      return idx().sessionById.get(id) || null;
    }

    function folderSessionCount(folderId) {
      return idx().directCount.get(folderId || null) || 0;
    }

    /** 某文件夹直属子文件夹列表（parentId 为 null / 缺失视为根目录） */
    function childrenOf(parentId) {
      return idx().children.get(parentId || null) || EMPTY;
    }

    function childrenFolderCount(folderId) { return childrenOf(folderId).length; }

    /** 以某文件夹为根的整个子树的文件夹 id 集合（含自身） */
    function subtreeFolderIds(rootId) {
      var set = idx().selfAndDesc.get(rootId);
      return set ? Array.from(set) : [rootId];
    }

    /** 某文件夹子树内的全部会话数（含所有后代文件夹中的会话） */
    function subtreeSessionCount(folderId) {
      return idx().subtreeCount.get(folderId) || 0;
    }

    /** 某文件夹直属会话列表（索引缓存中的数组，只读使用） */
    function sessionsOf(folderId) {
      return idx().byFolder.get(folderId || null) || EMPTY;
    }

    /**
     * 由下而上回溯 parentId，返回 [根..目标] 的祖先链；
     * 文件夹不存在或链路断裂返回 null（防环：最多回溯 100 层）。
     */
    function folderChain(id) {
      var chain = [];
      var cur = getFolder(id);
      if (!cur) return null;
      var seen = {};
      var guard = 0;
      while (cur && guard++ < 100) {
        if (seen[cur.id]) return null; // 环保护
        seen[cur.id] = true;
        chain.unshift(cur);
        cur = cur.parentId ? getFolder(cur.parentId) : null;
      }
      return chain;
    }

    /** 某文件夹的显示路径，如 「学习 / 物理」（无父级则为其自身名） */
    function folderPathLabel(id, sep) {
      var chain = folderChain(id);
      if (!chain || !chain.length) return '';
      return chain.map(function (f) { return f.name; }).join(sep || ' / ');
    }

    function stats() {
      return { folders: data.folders.length, sessions: data.sessions.length,
               recent: data.recentClosed.length };
    }

    /** 目标文件夹内是否已存在「同一条会话」（按 urlKey 归一化比较） */
    function duplicateIn(folderId, urlKey, extraKeys) {
      if (!urlKey) return false;
      if (idx().urlKeys.has(urlKey)) {
        var byFolder = idx().byFolder.get(folderId || null) || EMPTY;
        for (var i = 0; i < byFolder.length; i++) {
          if (utils.urlKey(byFolder[i].url) === urlKey) return true;
        }
      }
      return !!(extraKeys && extraKeys[urlKey]);
    }

    function findDuplicate(folderId, url) {
      var key = utils.urlKey(url);
      if (!key) return null;
      var byFolder = idx().byFolder.get(folderId || null) || EMPTY;
      for (var i = 0; i < byFolder.length; i++) {
        if (utils.urlKey(byFolder[i].url) === key) return byFolder[i];
      }
      return null;
    }

    /* --------------------------- 文件夹操作 --------------------------- */

    /** 新建文件夹；parentId 缺省 / 无效时建在根目录 */
    function createFolder(name, parentId) {
      return mutate(function () {
        if (parentId && !getFolder(parentId)) parentId = null;
        var folder = {
          id: utils.uid(),
          name: String(name || '').trim() || '新建文件夹',
          parentId: parentId || null,
          createdAt: Date.now(),
          pinned: false
        };
        data.folders.push(folder);
        return folder;
      });
    }

    function renameFolder(id, name) {
      return mutate(function () {
        var f = getFolder(id);
        if (!f) return null;
        name = String(name || '').trim();
        if (!name) return null;
        f.name = name;
        return f;
      });
    }

    function togglePinFolder(id) {
      return mutate(function () {
        var f = getFolder(id);
        if (!f) return null;
        f.pinned = !f.pinned;
        return f;
      });
    }

    /**
     * 移动文件夹到新父级（null = 根目录）。
     * 安全校验：目标必须存在；不能移动到自己 / 自己的后代之下（防环）。
     */
    function moveFolder(id, parentId) {
      return mutate(function () {
        var f = getFolder(id);
        if (!f) return null;
        parentId = parentId || null;
        if ((f.parentId || null) === parentId) return f;          // 原地，无需移动
        if (parentId) {
          if (!getFolder(parentId)) return null;                  // 目标不存在
          if (subtreeFolderIds(id).indexOf(parentId) >= 0) return null; // 会成环
        }
        f.parentId = parentId;
        return f;
      });
    }

    /**
     * 删除整个文件夹子树；子树内所有会话（含后代文件夹中的）自动进入
     * 「最近关闭」归档（可恢复），返回 { sessions, folders } 移动数量。
     */
    function deleteFolder(id) {
      return mutate(function () {
        var f = getFolder(id);
        if (!f) return null;
        var ids = subtreeFolderIds(id);
        var idSet = new Set(ids);
        var folderById = {};
        data.folders.forEach(function (x) { if (idSet.has(x.id)) folderById[x.id] = x; });

        var moved = data.sessions.filter(function (s) { return idSet.has(s.folderId); });
        data.sessions = data.sessions.filter(function (s) { return !idSet.has(s.folderId); });
        // archive() 用 unshift 归档，这里倒序写入以保持「最近关闭」的原始先后顺序
        for (var i = moved.length - 1; i >= 0; i--) {
          archive(moved[i], folderById[moved[i].folderId] || f);
        }
        data.folders = data.folders.filter(function (x) { return !idSet.has(x.id); });

        if (idSet.has(data.settings.lastImportFolderId)) data.settings.lastImportFolderId = '';
        return { sessions: moved.length, folders: ids.length - 1 };
      });
    }

    /* --------------------------- 会话操作 --------------------------- */

    function createSession(opts) {
      return mutate(function () {
        opts = opts || {};
        var now = Date.now();
        var session = {
          id: utils.uid(),
          folderId: opts.folderId || null,
          title: utils.clampTitle(opts.title) || DEFAULT_TITLE,
          url: opts.url || '',
          createdAt: now,
          updatedAt: now,
          lastOpenedAt: null,
          pinned: false
        };
        if (opts.open) session.lastOpenedAt = now;
        data.sessions.push(session);
        if (opts.folderId) data.settings.lastImportFolderId = opts.folderId;
        return session;
      });
    }

    function renameSession(id, title) {
      return mutate(function () {
        var s = getSession(id);
        if (!s) return null;
        title = String(title || '').trim();
        if (!title) return null;
        s.title = utils.clampTitle(title);
        s.updatedAt = Date.now();
        return s;
      });
    }

    function moveSession(id, folderId) {
      return mutate(function () {
        var s = getSession(id);
        if (!s) return null;
        s.folderId = folderId || null;
        s.updatedAt = Date.now();
        if (folderId) data.settings.lastImportFolderId = folderId;
        return s;
      });
    }

    function togglePinSession(id) {
      return mutate(function () {
        var s = getSession(id);
        if (!s) return null;
        s.pinned = !s.pinned;
        s.updatedAt = Date.now();
        return s;
      });
    }

    /** 记录一次「打开」：刷新 lastOpenedAt */
    function markOpened(id) {
      return mutate(function () {
        var s = getSession(id);
        if (!s) return null;
        s.lastOpenedAt = Date.now();
        return s;
      });
    }

    /** 打开链接并记录访问（渲染层调用） */
    function openSession(id) {
      var s = getSession(id);
      if (!s) return null;
      if (s.url) { try { window.open(s.url, '_blank', 'noopener'); } catch (e) { /* 弹窗被拦截不影响记录 */ } }
      return markOpened(id);
    }

    /**
     * 「关闭」会话：从所在文件夹移除，并自动存入侧边栏「最近关闭」。
     * 返回归档记录。
     */
    function removeSession(id) {
      return mutate(function () {
        var s = getSession(id);
        if (!s) return null;
        var folder = getFolder(s.folderId);
        data.sessions = data.sessions.filter(function (x) { return x.id !== id; });
        return archive(s, folder);
      });
    }

    /** 内部：把一条会话写入最近关闭归档（带源文件夹信息，便于恢复定位） */
    function archive(session, folder) {
      var rec = {
        id: utils.uid(),
        title: session.title || DEFAULT_TITLE,
        url: session.url || '',
        folderId: folder ? folder.id : null,
        folderName: folder ? folder.name : '',
        parentId: folder ? (folder.parentId || null) : null,
        closedAt: Date.now()
      };
      data.recentClosed.unshift(rec);
      if (data.recentClosed.length > RECENT_CAP) data.recentClosed.length = RECENT_CAP;
      return rec;
    }

    /**
     * 恢复「最近关闭」中的会话：
     * 若原文件夹仍存在则放回原文件夹；否则按快照重建同名文件夹
     * （原父级若还在则挂回原父级，否则放根目录），再放入会话。
     * 整个恢复过程只落盘一次（createFolder / createSession 自身不再各自提交）。
     */
    function restoreRecent(recId) {
      return mutate(function () {
        var idx0 = data.recentClosed.findIndex(function (r) { return r.id === recId; });
        if (idx0 < 0) return null;
        var rec = data.recentClosed[idx0];
        data.recentClosed.splice(idx0, 1);
        var folder = getFolder(rec.folderId);
        if (!folder) {
          var parentId = (rec.parentId && getFolder(rec.parentId)) ? rec.parentId : null;
          folder = createFolder(rec.folderName || '恢复的文件夹', parentId);
        }
        var session = createSession({
          folderId: folder.id, title: rec.title, url: rec.url
        });
        session.updatedAt = Date.now();
        return { session: session, folder: folder };
      });
    }

    /** 彻底删除某条最近关闭记录 */
    function discardRecent(recId) {
      return mutate(function () {
        data.recentClosed = data.recentClosed.filter(function (r) { return r.id !== recId; });
      });
    }

    function clearRecent() {
      return mutate(function () { data.recentClosed = []; });
    }

    /* --------------------------- 批量导入 --------------------------- */

    /**
     * 导入一批链接。返回统计信息。
     * items: [{url, title}]
     * 整批只落盘 / 只通知一次；重复判定按归一化 urlKey，能识别
     * 「同一会话的尾斜杠 / #锚点 / ?utm=1 变体」，且批次内自身也会去重。
     */
    function importItems(items, folderId) {
      return mutate(function () {
        var imported = 0, duplicates = 0, invalid = 0;
        var folder = getFolder(folderId);
        if (!folder) {
          // 无有效文件夹时自动创建「未分类」（根目录）
          folder = createFolder('未分类');
        }
        var key = utils.urlKey;
        var seenKeys = {};
        (items || []).forEach(function (it) {
          var norm = utils.normalizeUrl(it && it.url);
          if (!norm || !utils.isDeepseekUrl(norm)) { invalid++; return; }
          var k = key(norm);
          if (duplicateIn(folder.id, k, seenKeys)) { duplicates++; return; }
          seenKeys[k] = true;
          createSession({ folderId: folder.id, title: it.title, url: norm });
          imported++;
        });
        return { imported: imported, duplicates: duplicates, invalid: invalid, folder: folder };
      });
    }

    /* --------------------------- 搜索 --------------------------- */

    function search(query) {
      var q = String(query || '').trim().toLowerCase();
      if (!q) return { folders: [], sessions: [] };
      var ix = idx();
      var folders = [], sessions = [], i;
      for (i = 0; i < data.folders.length; i++) {
        if (ix.folderSearch[i].indexOf(q) >= 0) folders.push(data.folders[i]);
      }
      for (i = 0; i < data.sessions.length; i++) {
        if (ix.sessionSearch[i].indexOf(q) >= 0) sessions.push(data.sessions[i]);
      }
      return { folders: folders, sessions: sessions };
    }

    /* --------------------------- 设置 --------------------------- */

    function setSetting(key, value) {
      data.settings[key] = value;
      safeSet(); // 设置变更不触发全量重绘，仅静默保存（不改变索引相关数据）
    }

    /* --------------------------- 导出 / 导入备份 --------------------------- */

    function exportJson() {
      return JSON.stringify(data, null, 2);
    }

    /**
     * 生成用于写入数据文件的快照：盖上当前时间戳后序列化。
     * 与 localStorage 的写入互不影响（见 save()）。
     */
    function fileSnapshot() {
      data.savedAt = Date.now();
      return JSON.stringify(data);
    }

    /** 从用户选择的备份 JSON 恢复（整体替换）。 */
    function importJson(text) {
      var obj = null;
      try { obj = JSON.parse(text); } catch (e) { throw new Error('备份文件不是有效的 JSON'); }
      if (!obj || !Array.isArray(obj.folders) || !Array.isArray(obj.sessions)) {
        throw new Error('备份文件格式不正确');
      }
      return mutate(function () {
        data = migrate(obj);
        resetIndex();
        return stats();
      });
    }

    /* ------------------------------ 对外 API ------------------------------ */

    var store = {
      // 只读快照（每次读取前先确保已加载）
      get data() { return load(); },
      isMemoryOnly: function () { return memoryOnly; },
      /** 数据版本号：每次真实变动 +1（供索引/视图判断是否需要重算） */
      revision: function () { return dataRev; },
      STORAGE_KEY: STORAGE_KEY,
      DEFAULT_TITLE: DEFAULT_TITLE,

      subscribe: subscribe,
      hydrateFrom: hydrateFrom,
      fileSnapshot: fileSnapshot,
      getFolder: getFolder,
      getSession: getSession,
      folderSessionCount: folderSessionCount,
      sessionsOf: sessionsOf,
      childrenOf: childrenOf,
      childrenFolderCount: childrenFolderCount,
      subtreeSessionCount: subtreeSessionCount,
      subtreeFolderIds: subtreeFolderIds,
      folderChain: folderChain,
      folderPathLabel: folderPathLabel,
      stats: stats,
      findDuplicate: findDuplicate,

      createFolder: createFolder,
      renameFolder: renameFolder,
      togglePinFolder: togglePinFolder,
      moveFolder: moveFolder,
      deleteFolder: deleteFolder,

      createSession: createSession,
      renameSession: renameSession,
      moveSession: moveSession,
      togglePinSession: togglePinSession,
      markOpened: markOpened,
      openSession: openSession,
      removeSession: removeSession,
      restoreRecent: restoreRecent,
      discardRecent: discardRecent,
      clearRecent: clearRecent,

      importItems: importItems,
      search: search,
      setSetting: setSetting,
      exportJson: exportJson,
      importJson: importJson,

      // 批量变更（内部使用同一套 mutate；导出便于将来扩展批处理场景）
      batch: mutate
    };

    load(); // 首次加载
    return store;
  }

  global.DSF = global.DSF || {};
  global.DSF.store = createStore();
})(window);
