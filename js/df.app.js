/* =========================================================================
 * df.app.js — DeepSeek Folder 主控层
 * -------------------------------------------------------------------------
 * 职责：视图状态路由、事件委托、拖拽导入（外部链接 / 内部移动）、
 *       搜索、粘贴导入、备份导出 / 导入。
 * 数据变更一律走 store（自动持久化 + 触发 ui.render 重绘）。
 * ========================================================================= */
(function (global) {
  'use strict';

  var utils = global.DF.utils;
  var store = global.DF.store;
  var ui = global.DF.ui;
  var $ = ui.$;

  var MIME_SESSION = 'application/x-deepseek-folder-session';
  var MIME_FOLDER = 'application/x-deepseek-folder';

  /* ------------------------------ 视图状态 ------------------------------ */
  // mode: 'root' | 'folder'；searchText 非空时进入搜索视图
  var state = { mode: 'root', folderId: null, searchText: '' };
  global.DF.state = state;

  function goRoot() {
    state.mode = 'root';
    state.folderId = null;
    state.searchText = '';
    ui.render();
  }

  function goFolder(id) {
    if (!store.getFolder(id)) { goRoot(); return; }
    state.mode = 'folder';
    state.folderId = id;
    state.searchText = '';
    ui.expandPathTo(id); // 在侧边栏目录树中展开整条祖先链
    ui.render();
  }

  /** 文件夹在其它文件夹下的显示路径（用于选择器消歧） */
  function parentPathLabel(folderId) {
    var f = store.getFolder(folderId);
    if (!f) return '';
    if (!f.parentId) return '根目录';
    return store.folderPathLabel(f.parentId);
  }

  /** 导入成功后的统一收尾：toast + 跳转到目标文件夹 */
  function afterImport(stat) {
    if (!stat) return;
    var parts = [];
    parts.push('已导入 ' + stat.imported + ' 个会话到「' + stat.folder.name + '」');
    if (stat.duplicates) parts.push(stat.duplicates + ' 个重复已跳过');
    if (stat.invalid) parts.push(stat.invalid + ' 个链接无效');
    ui.toast(parts.join('；'), 'ok', 3600);
    goFolder(stat.folder.id);
  }

  /** 当前上下文中的默认目标文件夹 id（'' 表示由对话框选择） */
  function defaultFolder() {
    if (state.mode === 'folder' && store.getFolder(state.folderId)) return state.folderId;
    var last = store.data.settings.lastImportFolderId;
    return store.getFolder(last) ? last : '';
  }

  /* ------------------------------ 会话动作 ------------------------------ */

  function openSession(id) {
    var s = store.getSession(id);
    if (!s) return;
    if (!s.url) { ui.toast('该会话没有可打开的链接', 'warn'); return; }
    store.openSession(id); // 内部 window.open + 记录访问时间
  }

  function removeSession(id) {
    var s = store.getSession(id);
    if (!s) return;
    var rec = store.removeSession(id);
    if (rec) ui.toast('已关闭，可在左侧「最近关闭」中一键找回', 'ok');
  }

  async function moveSessionPicker(id) {
    var s = store.getSession(id);
    if (!s) return;
    var data = store.data;
    var items = data.folders.map(function (f) {
      return {
        value: f.id, label: f.name, icon: 'i-folder',
        sub: parentPathLabel(f.id),
        badge: store.folderSessionCount(f.id),
        disabled: f.id === s.folderId
      };
    });
    var target = await ui.picker({ title: '移动「' + s.title + '」到…', items: items });
    if (!target || target === s.folderId) return;
    store.moveSession(id, target);
    ui.toast('已移动到「' + (store.getFolder(target) || {}).name + '」', 'ok');
  }

  /** 移动文件夹：目标 = 其它文件夹（value=id）或根目录（value=''） */
  async function moveFolderPicker(id) {
    var f = store.getFolder(id);
    if (!f) return;
    var forbidden = store.subtreeFolderIds(id); // 自身 + 全部后代，禁止移入
    var data = store.data;
    var items = [{
      value: '', label: '（根目录）', icon: 'i-folder',
      sub: '与其它根目录文件夹并列',
      disabled: !f.parentId
    }];
    data.folders.forEach(function (x) {
      var disabled = forbidden.indexOf(x.id) >= 0 || (f.parentId || null) === x.id;
      items.push({
        value: x.id, label: x.name, icon: 'i-folder',
        sub: disabled ? '不能移动到此位置' : (parentPathLabel(x.id) + ' › ' + x.name),
        badge: store.subtreeSessionCount(x.id),
        disabled: disabled
      });
    });
    var target = await ui.picker({ title: '把「' + f.name + '」移动到…', items: items });
    if (target === undefined || target === null) return;
    var res = store.moveFolder(id, target || null);
    if (!res) { ui.toast('无法移动到该位置', 'warn'); return; }
    var where = target ? (store.getFolder(target) || {}).name : '根目录';
    ui.toast('已移动「' + f.name + '」到「' + where + '」', 'ok');
    ui.expandPathTo(id);
  }

  /* ------------------------------ 通用动作表 ------------------------------ */
  // data-action → 处理函数；第二个参数为动作按钮所在卡片/行（data-id 与 data-type）

  var ACTIONS = {
    'go-root': function () { goRoot(); },

    'open-folder': function (holder) { if (holder && holder.id) goFolder(holder.id); },

    // 侧边栏目录树：展开 / 折叠
    'toggle-folder': function (holder) {
      if (!holder) return;
      ui.toggleFolderCollapse(holder.id);
      ui.renderSidebar();
    },

    'new-folder': async function () {
      var name = await ui.prompt({
        title: '新建文件夹', label: '文件夹名称',
        placeholder: '例如：学习 / 工作 / 灵感', submitText: '创建'
      });
      if (name == null) return;
      var folder = store.createFolder(name || '未命名文件夹');
      ui.toast('已创建「' + folder.name + '」', 'ok');
      goFolder(folder.id);
    },

    // 在当前文件夹中新建子文件夹（顶栏按钮 / 网格内新建卡片）
    'new-subfolder': async function (holder) {
      var parentId = state.folderId;
      if (holder && holder.id) parentId = holder.id;
      var parent = store.getFolder(parentId);
      if (!parent) return;
      var name = await ui.prompt({
        title: '新建子文件夹',
        label: '在「' + parent.name + '」中新建文件夹',
        placeholder: '例如：数学 / 文献 / 灵感', submitText: '创建'
      });
      if (name == null) return;
      var folder = store.createFolder(name || '未命名文件夹', parentId);
      ui.toast('已创建「' + folder.name + '」（' + parent.name + ' 内）', 'ok');
      goFolder(folder.id);
    },

    'edit-folder': async function (holder) {
      var folder = store.getFolder(holder && holder.id);
      if (!folder) return;
      var name = await ui.prompt({
        title: '重命名文件夹', initial: folder.name, submitText: '保存'
      });
      if (name == null) return;
      store.renameFolder(folder.id, name || '未命名文件夹');
    },

    'delete-folder': async function (holder) {
      var folder = store.getFolder(holder && holder.id);
      if (!folder) return;
      var n = store.subtreeSessionCount(folder.id);
      var sub = store.childrenFolderCount(folder.id);
      var sure = await ui.confirm({
        title: '删除文件夹「' + folder.name + '」？',
        message: n > 0 || sub > 0
          ? '将删除整个文件夹树（' + (sub ? sub + ' 个子文件夹' + (n ? '、' : '') : '') +
            (n ? n + ' 个会话' : '') + '）。会话不会被销毁，会自动进入侧边栏「最近关闭」，可随时恢复。'
          : '该文件夹为空，删除后不可恢复。',
        confirmText: '删除', danger: true
      });
      if (!sure) return;
      var res = store.deleteFolder(folder.id); // { sessions, folders }
      if (res.sessions || res.folders) {
        var parts = [];
        if (res.sessions) parts.push(res.sessions + ' 个会话');
        if (res.folders) parts.push(res.folders + ' 个子文件夹');
        ui.toast('已删除，「' + parts.join('、') + '」移入「最近关闭」', 'ok');
      } else {
        ui.toast('已删除文件夹', 'ok');
      }
      if (state.mode === 'folder' && state.folderId === folder.id) goRoot();
    },

    'star-folder': function (holder) {
      var folder = store.togglePinFolder(holder && holder.id);
      if (folder) ui.toast(folder.pinned ? '已固定「' + folder.name + '」到侧边栏' : '已取消固定', 'ok');
    },
    'unpin-folder': function (holder) { store.togglePinFolder(holder && holder.id); },

    'move-folder': function (holder) {
      if (holder && holder.id) moveFolderPicker(holder.id);
    },

    'open-session': function (holder) { openSession(holder.id); },
    'star-session': function (holder) {
      var s = store.togglePinSession(holder.id);
      if (s) ui.toast(s.pinned ? '已固定到侧边栏「常用固定」' : '已取消固定', 'ok');
    },
    'unpin-session': function (holder) { store.togglePinSession(holder.id); },

    'edit-session': async function (holder) {
      var s = store.getSession(holder.id);
      if (!s) return;
      var title = await ui.prompt({
        title: '重命名会话', initial: s.title, submitText: '保存'
      });
      if (title == null) return;
      store.renameSession(s.id, title);
    },

    'move-session': function (holder) { moveSessionPicker(holder.id); },

    'remove-session': function (holder) { removeSession(holder.id); },

    'restore': function (holder) {
      var res = store.restoreRecent(holder.id);
      if (!res) { ui.toast('该记录已不存在', 'warn'); return; }
      ui.toast('已恢复到「' + res.folder.name + '」', 'ok');
      goFolder(res.folder.id);
    },

    'discard': async function (holder) {
      var sure = await ui.confirm({
        title: '彻底删除该记录？',
        message: '将从「最近关闭」中永久移除，且不会保留原会话。',
        confirmText: '彻底删除', danger: true
      });
      if (sure) store.discardRecent(holder.id);
    }
  };

  /* ------------------------------ 事件委托 ------------------------------ */

  document.addEventListener('click', function (e) {
    // 1) 显式动作按钮
    var actEl = e.target.closest('[data-action]');
    if (actEl) {
      e.preventDefault();
      var action = actEl.getAttribute('data-action');
      var holder = actEl.closest('[data-id]');
      var fn = ACTIONS[action];
      if (fn) fn(holder ? { id: holder.getAttribute('data-id'), type: holder.getAttribute('data-type') } : null);
      return;
    }

    // 2) 会话卡片整体点击 → 打开
    var sessCard = e.target.closest('.session-card');
    if (sessCard) { openSession(sessCard.getAttribute('data-id')); return; }

    // 3) 文件夹卡片整体点击 → 进入文件夹
    var folderCard = e.target.closest('.folder-card');
    if (folderCard) { goFolder(folderCard.getAttribute('data-id')); return; }

    // 4) 侧边栏条目
    var navRow = e.target.closest('#folderNav .sb-item');
    if (navRow) { goFolder(navRow.getAttribute('data-id')); return; }
    var pinRow = e.target.closest('#pinnedList .sb-item');
    if (pinRow) {
      if (pinRow.getAttribute('data-type') === 'session') openSession(pinRow.getAttribute('data-id'));
      else goFolder(pinRow.getAttribute('data-id'));
      return;
    }
    var recentRow = e.target.closest('#recentList .sb-item');
    if (recentRow) {
      var res = store.restoreRecent(recentRow.getAttribute('data-id'));
      if (res) { ui.toast('已恢复到「' + res.folder.name + '」', 'ok'); goFolder(res.folder.id); }
      return;
    }
  });

  /* ------------------------------ 静态按钮 ------------------------------ */

  $('btnNewFolder').addEventListener('click', function () {
    ACTIONS['new-folder'](null);
  });

  $('btnToggleSidebar').addEventListener('click', function () {
    var collapsed = !store.data.settings.sidebarCollapsed;
    store.setSetting('sidebarCollapsed', collapsed);
    ui.render();
  });

  $('btnClearRecent').addEventListener('click', async function () {
    var sure = await ui.confirm({
      title: '清空「最近关闭」？', message: '其中的会话记录将被永久移除。',
      confirmText: '清空', danger: true
    });
    if (sure) { store.clearRecent(); ui.toast('已清空', 'ok'); }
  });

  $('btnClearSearch').addEventListener('click', function () {
    state.searchText = '';
    ui.render();
    $('searchInput').focus();
  });

  /* ------------------------------ 搜索 ------------------------------ */

  var searchInput = $('searchInput');
  searchInput.addEventListener('input', utils.debounce(function () {
    var v = searchInput.value.trim();
    state.searchText = v;
    ui.render();
  }, 140));
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { state.searchText = ''; searchInput.value = ''; ui.render(); }
  });

  /* ------------------------------ 粘贴导入 ------------------------------ */

  function openPasteDialog() {
    var folderHint = state.mode === 'folder' && store.getFolder(state.folderId)
      ? '（将导入到当前文件夹「' + store.getFolder(state.folderId).name + '」）' : '';
    ui.textDialog({
      title: '粘贴链接导入',
      label: '粘贴 DeepSeek 会话链接' + folderHint,
      placeholder: '例如：\nhttps://chat.deepseek.com/a/chat/s/xxxxxxxx\n\n支持一次粘贴多条链接，或复制网页中的整段文字（会自动识别其中链接）。',
      submitText: '解析并导入'
    }).then(function (text) {
      if (text == null) return;
      var candidates = utils.buildCandidates({ plain: text });
      if (!candidates.length) { ui.toast('没有识别到 DeepSeek 链接，请检查粘贴内容', 'warn'); return; }
      ui.openImportDialog(candidates, defaultFolder()).then(function (stat) { afterImport(stat); });
    });
  }

  var importZone = $('importZone');
  // 容器上一个委托监听即可：点按钮也会冒泡到这里（按钮是导入区的子元素）
  importZone.addEventListener('click', openPasteDialog);

  /* ------------------------------ 拖拽相关 ------------------------------ */

  function typesInclude(dt, type) {
    if (!dt || !dt.types) return false;
    if (typeof dt.types.contains === 'function') return dt.types.contains(type);
    return Array.prototype.indexOf.call(dt.types, type) >= 0;
  }

  function isInternalDrag(e) {
    return typesInclude(e.dataTransfer, MIME_SESSION) || typesInclude(e.dataTransfer, MIME_FOLDER);
  }

  function hasExternalData(e) {
    return e.dataTransfer && (
      typesInclude(e.dataTransfer, 'text/uri-list') ||
      typesInclude(e.dataTransfer, 'text/plain') ||
      typesInclude(e.dataTransfer, 'text/html') ||
      (e.dataTransfer.files && e.dataTransfer.files.length > 0)
    );
  }

  var highlightEl = null;
  function clearHighlight() {
    if (highlightEl) highlightEl.classList.remove('drop-target');
    highlightEl = null;
    document.querySelectorAll('.dragging').forEach(function (el) {
      el.classList.remove('dragging');
    });
  }

  /**
   * 找到拖拽落点。
   * 返回 { el, folderId }；folderId 为 '__import__' 时表示导入区，
   * 为具体 id 时表示某文件夹，null 表示无明确落点。
   */
  function findDropZone(e) {
    var tf = e.target.closest('[data-drop-folder]');
    if (tf) {
      return { el: tf, folderId: tf.getAttribute('data-drop-folder') };
    }
    if (importZone.contains(e.target)) {
      return { el: importZone, folderId: '__import__' };
    }
    return null;
  }

  // —— 内部拖拽：会话卡片 / 文件夹卡片 ——
  document.addEventListener('dragstart', function (e) {
    var mime = null, dragId = null, dragEl = null;
    var card = e.target.closest('.session-card');
    if (card) { mime = MIME_SESSION; dragId = card.getAttribute('data-id'); dragEl = card; }
    else {
      var fcard = e.target.closest('.folder-card');
      if (fcard) { mime = MIME_FOLDER; dragId = fcard.getAttribute('data-id'); dragEl = fcard; }
    }
    if (!mime || !dragId) return;
    try {
      e.dataTransfer.setData(mime, dragId);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* ignore */ }
    dragEl.classList.add('dragging');
  });

  // —— 拖拽经过：控制落点高亮，禁止浏览器默认（否则会导航/打开文件） ——
  document.addEventListener('dragover', function (e) {
    if (!e.dataTransfer) return;
    var relevant = isInternalDrag(e) || hasExternalData(e);
    if (!relevant) return;
    e.preventDefault();
    if (isInternalDrag(e)) e.dataTransfer.dropEffect = 'move';
    else e.dataTransfer.dropEffect = 'copy';

    var zone = findDropZone(e);
    if (!zone) return;
    // 内容区空白落在文件夹视图时视为该文件夹的落点
    if (zone.folderId === '__import__') {
      if (isInternalDrag(e)) return; // 内部移动不落到导入区
      if (highlightEl !== importZone) { clearHighlight(); importZone.classList.add('drop-target'); highlightEl = importZone; }
      return;
    }
    // 拖动源自身不参与高亮
    if (zone.el.classList.contains('dragging') || zone.el.classList.contains('session-card')) return;
    if (highlightEl !== zone.el) { clearHighlight(); zone.el.classList.add('drop-target'); highlightEl = zone.el; }
  });

  document.addEventListener('dragleave', function (e) {
    if (!e.relatedTarget && highlightEl) clearHighlight();
  });

  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer) return;
    var internal = isInternalDrag(e);
    var external = hasExternalData(e);
    if (!internal && !external) return;
    e.preventDefault();
    var zone = findDropZone(e);
    clearHighlight();

    // —— 内部移动：会话 / 文件夹 → 目标文件夹 ——
    if (internal) {
      var sessId = '', folderIdDrag = '';
      try {
        if (typesInclude(e.dataTransfer, MIME_FOLDER)) folderIdDrag = e.dataTransfer.getData(MIME_FOLDER);
        else sessId = e.dataTransfer.getData(MIME_SESSION);
      } catch (err) { /* ignore */ }
      var zoneFolder = zone ? zone.folderId : null;
      if (!zoneFolder || zoneFolder === '__import__') return;

      // 移动文件夹：禁止移入自身 / 自身后代（成环）
      if (folderIdDrag) {
        var fMove = store.getFolder(folderIdDrag);
        if (!fMove || zoneFolder === fMove.id) return;
        if (store.subtreeFolderIds(folderIdDrag).indexOf(zoneFolder) >= 0) {
          ui.toast('不能把文件夹移动到自己的子文件夹内', 'warn');
          return;
        }
        if ((fMove.parentId || null) === zoneFolder) return; // 已在该文件夹下
        var tgtF = store.getFolder(zoneFolder);
        if (!tgtF) return;
        store.moveFolder(folderIdDrag, zoneFolder);
        ui.toast('已移动「' + fMove.name + '」到「' + tgtF.name + '」', 'ok');
        return;
      }

      // 移动会话
      if (sessId) {
        var s = store.getSession(sessId);
        if (s && s.folderId !== zoneFolder) {
          store.moveSession(sessId, zoneFolder);
          ui.toast('已移动「' + s.title + '」到「' + (store.getFolder(zoneFolder) || {}).name + '」', 'ok');
        }
      }
      return;
    }

    // —— 外部拖入：DeepSeek 链接 / 文本 / 文件 ——
    var data = {
      uriList: safeGetData(e, 'text/uri-list'),
      plain: safeGetData(e, 'text/plain'),
      html: safeGetData(e, 'text/html'),
      files: Array.prototype.slice.call(e.dataTransfer.files || [])
    };

    var folderId = null;
    if (zone && zone.folderId !== '__import__') folderId = zone.folderId; // 明确落在某文件夹上
    // 内容区在文件夹视图（非搜索态）下也视为目标文件夹
    if (!folderId && state.mode === 'folder' && !state.searchText &&
        store.getFolder(state.folderId) && !zone) {
      folderId = state.folderId;
    }

    handleExternalDrop(data, folderId);
  });

  // 拖到页面其它空白处时阻止浏览器默认行为（打开链接 / 文件）
  ['dragover', 'drop'].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      if (e.dataTransfer && hasExternalData(e)) e.preventDefault();
    });
  });

  function safeGetData(e, type) {
    try { return e.dataTransfer.getData(type); } catch (err) { return ''; }
  }

  function readFilesAsText(files) {
    var reads = files.map(function (file) {
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { resolve(''); };
        reader.readAsText(file);
      });
    });
    return Promise.all(reads).then(function (parts) { return parts.join('\n'); });
  }

  async function handleExternalDrop(data, folderId) {
    var plain = data.plain || '';
    if (data.files && data.files.length) {
      try { plain += '\n' + (await readFilesAsText(data.files)); }
      catch (err) { /* ignore */ }
    }
    var candidates = utils.buildCandidates({ uriList: data.uriList, plain: plain, html: data.html });
    if (!candidates.length) {
      ui.toast('没有识别到 DeepSeek 会话链接', 'warn');
      return;
    }
    if (folderId && store.getFolder(folderId)) {
      var stat = store.importItems(candidates, folderId);
      afterImport(stat);
      return;
    }
    var stat2 = await ui.openImportDialog(candidates, defaultFolder());
    afterImport(stat2);
  }

  document.addEventListener('dragend', clearHighlight);

  /* ------------------------------ 备份导出 / 导入 ------------------------------ */

  function exportBackup() {
    var text = store.exportJson();
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    var fname = 'deepseek-folder-backup-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    ui.toast('已导出备份：' + fname, 'ok');
  }

  function importBackup() {
    ui.confirm({
      title: '导入备份文件？',
      message: '导入将覆盖当前全部数据（文件夹、会话、最近关闭）。建议先「导出备份」。',
      confirmText: '选择文件…'
    }).then(function (ok) {
      if (!ok) return;
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var stats = store.importJson(String(reader.result));
            ui.toast('恢复成功：' + stats.folders + ' 个文件夹 · ' + stats.sessions + ' 个会话', 'ok', 3600);
            goRoot();
          } catch (err) {
            ui.toast(err.message || '备份文件格式不正确', 'err', 3600);
          }
        };
        reader.onerror = function () { ui.toast('读取文件失败', 'err'); };
        reader.readAsText(file);
      });
      input.click();
    });
  }

  $('btnExportBackup').addEventListener('click', exportBackup);
  $('btnImportBackup').addEventListener('click', importBackup);

  /* ----------------- 数据文件自动保存（可选：server.py 后端） -----------------
   * 直接用浏览器打开 index.html（file://）：数据走浏览器本地存储；
   * 用 server.py / 启动脚本打开：额外自动把数据写入项目目录的 deepseek-folder-data.json，
   * 换浏览器、清缓存、换端口都不会丢数据（同一份数据文件即“本地记忆”）。
   * ---------------------------------------------------------------------- */

  // 存储模式：file=数据文件 / local=浏览器本地 / session=仅本次会话
  var storageInfo = { mode: store.isMemoryOnly() ? 'session' : 'local' };
  global.DF.storageInfo = storageInfo;

  var STATE_URL = 'api/state';
  var fileMode = false;    // 是否已连接上数据文件后端
  var remoteWarned = false;
  var booted = false;      // 启动同步是否已结束（结束前不往后端写，避免盖错数据）
  var bootTimer = null;

  function isHttpOrigin() {
    try { return /^https?:$/.test(location.protocol); } catch (e) { return false; }
  }

  /** 数据接口会话令牌（由本地服务注入；file:// 直开时为占位符，等同无令牌） */
  function pageToken() {
    var meta = document.querySelector('meta[name="df-token"]');
    var v = meta ? (meta.getAttribute('content') || '') : '';
    return (v && v.indexOf('__DEEPSEEK_FOLDER_TOKEN__') < 0) ? v : '';
  }
  var TOKEN = pageToken();

  function stateHeaders(extra) {
    var h = { 'Content-Type': 'application/json' };
    if (TOKEN) h['X-DeepSeek-Folder-Token'] = TOKEN;
    if (extra) Object.assign(h, extra);
    return h;
  }

  function markBooted() {
    booted = true;
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  }

  /** 文件写入失败：停止尝试、切换存储标识并提示（只提示一次） */
  function remoteWriteFailed() {
    if (remoteWarned) return;
    remoteWarned = true;
    fileMode = false;
    storageInfo.mode = store.isMemoryOnly() ? 'session' : 'local';
    ui.render();
    ui.toast('数据文件写入失败（服务器窗口是否已关闭？）。已改用浏览器本地存储。', 'warn', 6000);
  }

  /** 把当前快照写入 deepseek-folder-data.json（失败时降级为浏览器存储并提示） */
  function pushToFile() {
    if (!fileMode) return;
    var body = store.fileSnapshot();
    try {
      fetch(STATE_URL, {
        method: 'PUT',
        headers: stateHeaders(),
        body: body,
        keepalive: true
      }).then(function (r) {
        if (!r || !r.ok) remoteWriteFailed();
      }).catch(remoteWriteFailed);
    } catch (e) {
      remoteWriteFailed();
    }
  }

  // 连续改动合并成一次写入（store 层已把批量操作合并为一次 commit）
  var pushSoon = utils.debounce(pushToFile, 600);

  /** 立即落盘：取消防抖等待，把最后一次改动同步发出（关窗 / 页面隐藏前调用） */
  function flushToFile() {
    if (pushSoon.cancel) pushSoon.cancel();
    if (!booted) return; // 启动同步还没结束：此时写入会与“取最新”判断打架
    pushToFile();
  }
  // 桌面版主进程退出前会调用它，避免“最后一次改动还在防抖等待中就退出”导致丢数据
  global.DF.flush = flushToFile;

  /** file:// 直开模式的醒目引导条（可关闭，仅本次会话） */
  function showFileModeBanner() {
    var banner = document.getElementById('modeBanner');
    if (!banner) return;
    banner.hidden = false;
    var closeBtn = banner.querySelector('.js-hide');
    if (closeBtn) closeBtn.addEventListener('click', function () { banner.hidden = true; });
  }

  /**
   * 启动时探测数据文件并决定以哪份为准：
   * 哪边更新（savedAt 更大）用哪边；本地为空则直接采用文件数据。
   * 同步结束前（booted=false）不往后端写，避免启动竞态把旧数据盖回去。
   */
  async function bootstrapFileMode() {
    if (!isHttpOrigin()) { markBooted(); return; } // file:// 直接打开：无后端可连
    var res = null;
    try {
      res = await fetch(STATE_URL, { cache: 'no-store', headers: stateHeaders() });
    } catch (e) { markBooted(); return; }
    if (!res || !res.ok) { markBooted(); return; } // 静态服务器没有 /api/state
    try {
      var text = await res.text();
      var remote = (text && text.trim() && text.trim() !== 'null') ? JSON.parse(text) : null;
      if (!remote || typeof remote !== 'object' || !Array.isArray(remote.folders)) { markBooted(); return; }

      fileMode = true;
      storageInfo.mode = 'file';

      var local = store.data;
      var localEmpty = !local.folders.length && !local.sessions.length && !local.recentClosed.length;
      var localAt = local.savedAt || 0;
      var remoteAt = remote.savedAt || 0;
      if (localEmpty || remoteAt > localAt) {
        store.hydrateFrom(remote);
        if (!localEmpty && remoteAt > localAt) {
          ui.toast('已从 deepseek-folder-data.json 恢复上次保存的数据', 'ok', 3600);
        }
      } else if (localAt > remoteAt) {
        pushToFile(); // 本地更新 → 覆盖回数据文件
      }
      ui.render();
    } catch (e) { /* ignore */ }
    markBooted(); // 同步完成（成功或失败）后，后续改动才允许回写数据文件
  }

  /* ------------- 桌面版集成：快速导入悬浮窗（浏览器里自动跳过） -------------
   * 桌面版由 preload 暴露 window.dfDesktop；网页版没有该对象，
   * 因此下面整段逻辑在浏览器中直接返回，页面行为完全不变。
   * ---------------------------------------------------------------------- */

  function initDesktopIntegration() {
    var desk = global.dfDesktop;
    if (!desk || !desk.quickWindow) return;

    var btn = $('btnQuickWindow');
    var label = $('quickWindowLabel');

    function syncBtn(on) {
      if (!btn) return;
      btn.classList.toggle('on', !!on);
      btn.title = on
        ? '快速导入悬浮窗：已开启。主窗口不在前台时，屏幕角落会出现小窗，可直接把链接拖进去。'
        : '快速导入悬浮窗：已关闭。开启后即使主窗口最小化或被浏览器挡住，也能把链接拖进小窗导入。';
      if (label) label.textContent = on ? '悬浮窗 开' : '悬浮窗';
    }

    syncBtn(desk.quickWindow.isEnabled());
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', function () {
        var next = !desk.quickWindow.isEnabled();
        desk.quickWindow.setEnabled(next);
        syncBtn(next);
        ui.toast(next
          ? '已开启快速导入悬浮窗：主窗口不在前台时，把链接拖到屏幕角落的小窗即可导入'
          : '已关闭快速导入悬浮窗', next ? 'ok' : 'info', 4200);
      });
    }

    // 悬浮窗自带的 ✕ 关闭时，同步主界面按钮状态
    desk.quickWindow.onChange(function (on) { syncBtn(on); });

    // 悬浮窗拖入内容 → 主进程唤起主窗口 → 这里完成导入
    desk.onQuickImport(function (payload) {
      window.__dfQuickImport = payload; // 便于自检 / 调试
      var count = 0;
      try { count = utils.buildCandidates(payload || {}).length; } catch (e) { count = 0; }
      if (!count) { ui.toast('悬浮窗收到的内容里没有识别到 DeepSeek 链接', 'warn'); return; }
      var target = (state.mode === 'folder' && !state.searchText && store.getFolder(state.folderId))
        ? state.folderId : null;
      ui.toast('已从悬浮窗收到 ' + count + ' 个链接，正在导入…', 'ok', 2600);
      handleExternalDrop({
        uriList: payload.uriList,
        plain: payload.plain,
        html: payload.html,
        files: []
      }, target);
    });
  }

  /* ------------------------------ 启动 ------------------------------ */

  store.subscribe(ui.scheduleRender);
  store.subscribe(function () { if (booted) pushSoon(); });

  goRoot();
  initDesktopIntegration();
  bootstrapFileMode();
  // 兜底：后端无响应时也不要永久卡住回写
  bootTimer = setTimeout(markBooted, 6000);

  // file:// 直接打开：显示引导条（此模式持久化依赖浏览器，重启有丢失风险）
  if (!isHttpOrigin()) showFileModeBanner();

  // v0.5.0 改名：从旧版本（DSF）浏览器存储迁移过来的数据，明确告知用户
  if (store.wasMigrated && store.wasMigrated()) {
    ui.toast('已从旧版本 DSF 迁移本地数据到 DeepSeek Folder（旧数据仍保留）', 'ok', 4600);
  }

  // 延迟确认：若浏览器拒绝存储且未连上数据文件后端，给出明显提示
  setTimeout(function () {
    if (store.isMemoryOnly() && !fileMode) {
      ui.toast('当前环境不允许本地存储且未连接数据文件：内容仅本次会话有效。' +
        '请用 start-deepseek-folder.cmd（server.py）打开以自动保存到 deepseek-folder-data.json。', 'warn', 9000);
    }
  }, 900);

  // 关闭 / 刷新页面前把最后一次改动落盘到数据文件（桌面版另由主进程调用 DF.flush）
  window.addEventListener('pagehide', flushToFile);
  window.addEventListener('beforeunload', flushToFile);
})(window);
