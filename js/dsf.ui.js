/* =========================================================================
 * dsf.ui.js — DSF 渲染层
 * -------------------------------------------------------------------------
 * 职责：把数据（DSF.store）+ 视图状态（DSF.state）渲染为 DOM；
 *       提供通用弹窗 / 提示框 / 选择器 / Toast 组件；
 *       提供「导入会话」与「粘贴导入」对话框。
 * 事件绑定放在 dsf.app.js（本文件只输出 HTML 结构）。
 * ========================================================================= */
(function (global) {
  'use strict';

  var utils = global.DSF.utils;
  var store = global.DSF.store;

  var ESC = utils.escapeHtml;

  /* 侧边栏目录树折叠状态（仅本次会话内记忆） */
  var collapsedFolders = new Set();

  /** 展开某文件夹的整条祖先链（导航到它时调用），并收集路径供选择器用 */
  function expandPathTo(folderId) {
    var chain = store.folderChain(folderId);
    if (!chain) return;
    chain.forEach(function (f) { collapsedFolders.delete(f.id); });
  }

  /* ------------------------------ DOM 助手 ------------------------------ */

  function $(id) { return document.getElementById(id); }

  function icon(name, cls) {
    return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#' + name + '"/></svg>';
  }

  /* ---------------------------- 渲染调度 ---------------------------- */

  var scheduled = false;
  var scheduledId = null;

  function cancelScheduled() {
    if (!scheduled) return;
    scheduled = false;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduledId);
    else clearTimeout(scheduledId);
    scheduledId = null;
  }

  /**
   * 合并重绘：同一帧内的多次数据变更只重绘一次。
   * （批量导入 / 级联删除会连续触发多次 store 通知，逐次全量重绘是主要卡顿源）
   */
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    var run = function () { scheduled = false; scheduledId = null; render(); };
    if (typeof requestAnimationFrame === 'function') scheduledId = requestAnimationFrame(run);
    else scheduledId = setTimeout(run, 0);
  }

  /** 立即重绘（并丢弃已排队的合并重绘） */
  function renderNow() {
    cancelScheduled();
    render();
  }

  /* ------------------------------ Toast ------------------------------ */

  var TOAST_ICONS = { ok: 'i-spark', warn: 'i-info', err: 'i-x' };

  function toast(message, kind, ms) {
    var root = $('toastRoot');
    if (!root) return;
    kind = kind || 'ok';
    var div = document.createElement('div');
    div.className = 'toast ' + kind;
    div.innerHTML = icon(TOAST_ICONS[kind] || 'i-info') + '<span>' + ESC(message) + '</span>';
    root.appendChild(div);
    setTimeout(function () {
      div.classList.add('out');
      setTimeout(function () { div.remove(); }, 260);
    }, ms || 2800);
  }

  /* ------------------------------ 弹窗 ------------------------------ */

  var modalStack = [];
  var modalSeq = 0;

  function buildModal(opts) {
    // opts: { title, bodyHtml, footHtml }
    var titleId = 'modal-title-' + (++modalSeq);
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
        '<div class="modal-head"><h3 id="' + titleId + '">' + ESC(opts.title) + '</h3>' +
          '<button type="button" class="icon-btn js-modal-x" title="关闭" aria-label="关闭">' +
            icon('i-x') + '</button></div>' +
        '<div class="modal-body">' + (opts.bodyHtml || '') + '</div>' +
        (opts.footHtml ? '<div class="modal-foot">' + opts.footHtml + '</div>' : '') +
      '</div>';

    var closed = false;
    var prevFocus = document.activeElement;
    var close = function () {
      if (closed) return;
      closed = true;
      backdrop.remove();
      var i = modalStack.indexOf(close);
      if (i >= 0) modalStack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      // 焦点还给打开弹窗的元素（键盘用户不至于迷失）
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        try { prevFocus.focus(); } catch (e) { /* ignore */ }
      }
      if (opts.onCancel) { try { opts.onCancel(); } catch (e) { /* ignore */ } }
    };
    modalStack.push(close);

    var FOCUSABLE = 'a[href],button:not([disabled]),input:not([type=hidden]),textarea,select,' +
      '[tabindex]:not([tabindex="-1"])';

    function onKey(e) {
      // 只让最顶层弹窗响应 Escape，避免一次关掉多个叠加弹窗
      var top = modalStack.length && modalStack[modalStack.length - 1] === close;
      if (e.key === 'Escape' && top) {
        e.stopPropagation();
        close();
        return;
      }
      // 焦点陷阱：Tab 只在当前弹窗内循环，不跑到背后的主界面
      if (e.key !== 'Tab' || !top) return;
      var items = Array.prototype.filter.call(
        backdrop.querySelectorAll(FOCUSABLE),
        function (el) { return el.offsetParent !== null || el === document.activeElement; }
      );
      if (!items.length) return;
      var firstEl = items[0];
      var lastEl = items[items.length - 1];
      var active = document.activeElement;
      if (e.shiftKey && (active === firstEl || !backdrop.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !backdrop.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('.js-modal-x').addEventListener('click', close);

    $('modalRoot').appendChild(backdrop);

    if (opts.onMount) { try { opts.onMount(backdrop); } catch (e) { /* ignore */ } }

    // 聚焦第一个可输入控件（若 onMount 里又开了新弹窗，就别抢它的焦点）
    var first = backdrop.querySelector('input:not([type=hidden]),textarea,select');
    if (first) {
      setTimeout(function () {
        if (closed) return;
        if (modalStack[modalStack.length - 1] !== close) return;
        first.focus();
      }, 30);
    }

    return { close: close, el: backdrop };
  }

  /** 文本输入弹窗 → Promise<string|null> */
  function prompt(opts) {
    return new Promise(function (resolve) {
      var dlg = buildModal({
        title: opts.title,
        onCancel: function () { resolve(null); },
        bodyHtml:
          '<form class="js-form">' +
            (opts.label ? '<div class="form-row"><label>' + ESC(opts.label) + '</label></div>' : '') +
            '<div class="form-row">' +
              '<input class="input" name="value" type="text" autocomplete="off" ' +
                'placeholder="' + ESC(opts.placeholder || '') + '" ' +
                'value="' + ESC(opts.initial || '') + '" />' +
              (opts.hint ? '<div class="field-hint">' + ESC(opts.hint) + '</div>' : '') +
            '</div>' +
            '<div class="modal-foot" style="padding:6px 0 0">' +
              '<button type="button" class="btn subtle js-cancel">取消</button>' +
              '<button type="submit" class="btn primary">' + ESC(opts.submitText || '确定') + '</button>' +
            '</div>' +
          '</form>',
        onMount: function (el) {
          var input = el.querySelector('input[name=value]');
          input.select();
          el.querySelector('.js-form').addEventListener('submit', function (e) {
            e.preventDefault();
            var v = input.value.trim();
            if (!v && !opts.allowEmpty) return;
            resolve(v);
            dlg.close();
          });
          el.querySelector('.js-cancel').addEventListener('click', function () { dlg.close(); });
        }
      });
    });
  }

  /** 多行文本输入弹窗（粘贴导入用） → Promise<string|null> */
  function textDialog(opts) {
    return new Promise(function (resolve) {
      var dlg = buildModal({
        title: opts.title,
        onCancel: function () { resolve(null); },
        bodyHtml:
          '<form class="js-form">' +
            (opts.label ? '<div class="form-row"><label>' + ESC(opts.label) + '</label></div>' : '') +
            '<div class="form-row">' +
              '<textarea class="input" name="value" rows="7" spellcheck="false" ' +
                'placeholder="' + ESC(opts.placeholder || '') + '"></textarea>' +
            '</div>' +
            '<div class="modal-foot" style="padding:6px 0 0">' +
              '<button type="button" class="btn subtle js-cancel">取消</button>' +
              '<button type="submit" class="btn primary">' + ESC(opts.submitText || '确定') + '</button>' +
            '</div>' +
          '</form>',
        onMount: function (el) {
          var textarea = el.querySelector('textarea[name=value]');
          el.querySelector('.js-form').addEventListener('submit', function (e) {
            e.preventDefault();
            var v = textarea.value.trim();
            if (!v) return;
            resolve(v);
            dlg.close();
          });
          el.querySelector('.js-cancel').addEventListener('click', function () { dlg.close(); });
        }
      });
    });
  }

  /** 确认弹窗 → Promise<boolean>（message 一律转义：接口层面杜绝 HTML 注入） */
  function confirm(opts) {
    return new Promise(function (resolve) {
      var dlg = buildModal({
        title: opts.title || '确认操作',
        onCancel: function () { resolve(false); },
        bodyHtml: '<div class="field-hint" style="font-size:13px;margin-top:8px">' +
          ESC(opts.message || '') + '</div>',
        footHtml:
          '<button type="button" class="btn subtle js-cancel">取消</button>' +
          '<button type="button" class="btn ' + (opts.danger ? 'danger' : 'primary') + ' js-ok">' +
            ESC(opts.confirmText || '确定') + '</button>',
        onMount: function (el) {
          el.querySelector('.js-cancel').addEventListener('click', function () { dlg.close(); });
          el.querySelector('.js-ok').addEventListener('click', function () { resolve(true); dlg.close(); });
        }
      });
    });
  }

  /** 选择列表弹窗 → Promise<value|null> */
  function picker(opts) {
    // opts: { title, items: [{value,label,sub,badge,icon,disabled}] }
    return new Promise(function (resolve) {
      var rows = (opts.items || []).map(function (it) {
        return '<button type="button" class="picker-row' + (it.disabled ? ' disabled' : '') + '" ' +
          'data-value="' + ESC(it.value) + '"' + (it.disabled ? ' disabled' : '') + '>' +
          icon(it.icon || 'i-folder') +
          '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + ESC(it.label) +
            (it.sub ? ' <span style="color:var(--text-3);font-size:11px">' + ESC(it.sub) + '</span>' : '') +
          '</span>' +
          (it.badge != null ? '<span class="pr-badge">' + ESC(String(it.badge)) + '</span>' : '') +
        '</button>';
      }).join('');
      var dlg = buildModal({
        title: opts.title,
        onCancel: function () { resolve(null); },
        bodyHtml: '<div class="picker-list">' + (rows || '<div class="field-hint">暂无选项</div>') + '</div>',
        onMount: function (el) {
          el.querySelectorAll('.picker-row').forEach(function (row) {
            row.addEventListener('click', function () {
              if (row.disabled) return;
              resolve(row.getAttribute('data-value'));
              dlg.close();
            });
          });
        }
      });
    });
  }

  /* --------------------------- 导入相关对话框 --------------------------- */

  /**
   * 「导入会话」对话框：展示候选链接（可改名 / 去勾选）、选择目标文件夹。
   * candidates: [{url, title|null}]
   * resolve(null) 取消；resolve('ok') 已导入（内部调用 store.importItems）
   */
  function openImportDialog(candidates, defaultFolderId) {
    if (!candidates || !candidates.length) {
      toast('没有找到可导入的 DeepSeek 链接', 'warn');
      return Promise.resolve(null);
    }
    var data = store.data;
    var folders = data.folders;

    var folderOptions = folders.map(function (f) {
      var label = f.parentId ? store.folderPathLabel(f.id) : f.name;
      return '<option value="' + ESC(f.id) + '">' + ESC(label) + '（' + store.folderSessionCount(f.id) + '）</option>';
    }).join('');
    if (!folderOptions) folderOptions = '<option value="">（尚无文件夹，将自动创建「未分类」）</option>';

    var selFolder = defaultFolderId || data.settings.lastImportFolderId || (folders[0] ? folders[0].id : '');
    var defLabel = defaultFolderId ? '导入到当前文件夹' : '';

    var rows = candidates.map(function (c, i) {
      var dup = selFolder ? store.findDuplicate(selFolder, c.url) : null;
      return '<div class="import-row" data-idx="' + i + '">' +
        '<input type="checkbox" class="ir-check" ' + (dup ? '' : 'checked') + ' title="是否导入此行" />' +
        '<span class="ir-ic">' + icon('i-chat') + '</span>' +
        '<div class="ir-main">' +
          '<input class="input ir-title" value="' + ESC(c.title || store.DEFAULT_TITLE) + '" spellcheck="false" />' +
          '<div class="ir-url' + (dup ? ' dup' : '') + '" data-url="' + ESC(c.url) + '">' +
            ESC(utils.hostOf(c.url)) + (dup ? ' · 目标文件夹中已存在（默认不导入）' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var bodyHtml =
      '<div class="field-hint" style="margin:4px 0 0">共发现 ' + candidates.length +
        ' 个 DeepSeek 链接' + (defLabel ? '，' + ESC(defLabel) : '') + '，可修改名称或取消勾选：</div>' +
      '<div class="import-list">' + rows + '</div>' +
      '<div class="form-row" style="margin-top:12px">' +
        '<label for="imp-folder">保存到文件夹</label>' +
        '<div style="display:flex;gap:8px">' +
          '<select id="imp-folder" class="input" style="flex:1">' + folderOptions + '</select>' +
          '<button type="button" class="btn subtle js-imp-new" title="新建文件夹并保存到其中">' +
            icon('i-plus') + '新建</button>' +
        '</div>' +
      '</div>';

    return new Promise(function (resolve) {
      var dlg = buildModal({
        title: '导入会话',
        bodyHtml: bodyHtml,
        footHtml:
          '<button type="button" class="btn subtle js-cancel">取消</button>' +
          '<button type="button" class="btn primary js-ok">' + icon('i-upload') + '开始导入</button>',
        onMount: function (el) {
          var select = el.querySelector('#imp-folder');

          function refreshDups() {
            var fid = select.value;
            candidates.forEach(function (c, i) {
              var row = el.querySelector('.import-row[data-idx="' + i + '"]');
              if (!row) return;
              var check = row.querySelector('.ir-check');
              var urlEl = row.querySelector('.ir-url');
              var dup = fid ? store.findDuplicate(fid, c.url) : null;
              check.checked = !dup;
              urlEl.classList.toggle('dup', !!dup);
              urlEl.textContent = utils.hostOf(c.url) + (dup ? ' · 目标文件夹中已存在（默认不导入）' : '');
            });
          }
          select.addEventListener('change', refreshDups);

          el.querySelector('.js-imp-new').addEventListener('click', function () {
            prompt({ title: '新建文件夹', label: '文件夹名称', placeholder: '例如：学习 / 工作 / 灵感',
                     submitText: '创建' }).then(function (name) {
              if (!name) return;
              var folder = store.createFolder(name);
              select.insertAdjacentHTML('beforeend',
                '<option value="' + ESC(folder.id) + '">' + ESC(folder.name) + '（0）</option>');
              select.value = folder.id;
              refreshDups();
            });
          });

          el.querySelector('.js-cancel').addEventListener('click', function () { dlg.close(); resolve(null); });
          el.querySelector('.js-ok').addEventListener('click', function () {
            var folderId = select.value;
            var items = [];
            candidates.forEach(function (c, i) {
              var row = el.querySelector('.import-row[data-idx="' + i + '"]');
              if (!row) return;
              var check = row.querySelector('.ir-check');
              if (!check.checked) return;
              var titleInput = row.querySelector('.ir-title');
              items.push({ url: c.url, title: titleInput ? titleInput.value.trim() : c.title });
            });
            if (!items.length) { toast('请至少勾选一个会话', 'warn'); return; }
            var stat = store.importItems(items, folderId);
            dlg.close(); resolve(stat);
          });
        }
      });
    });
  }

  /** 把一段文本解析并打开导入对话框（粘贴场景） */
  function pasteAndImport(text, defaultFolderId) {
    var candidates = utils.buildCandidates({ plain: text || '' });
    if (!candidates.length) {
      toast('没有识别到 DeepSeek 链接', 'warn');
      return Promise.resolve(null);
    }
    return openImportDialog(candidates, defaultFolderId);
  }

  /* ------------------------------ 渲染：侧边栏 ------------------------------ */

  function folderItemRow(folder, opts) {
    // opts: {active, depth, hasChildren, collapsed}
    var count = store.subtreeSessionCount(folder.id); // 徽标 = 整棵子树会话数
    var depth = opts.depth || 0;
    var caret = '';
    if (opts.hasChildren) {
      caret = '<button type="button" class="icon-btn sm nav-caret' + (opts.collapsed ? '' : ' open') +
        '" data-action="toggle-folder" data-id="' + ESC(folder.id) + '" title="' +
        (opts.collapsed ? '展开' : '折叠') + '">' + icon('i-chevron', 'ic-sm') + '</button>';
    } else {
      caret = '<span class="nav-caret-empty"></span>';
    }
    return '<div class="sb-item' + (opts && opts.active ? ' active' : '') + '" ' +
      'data-id="' + ESC(folder.id) + '" data-type="folder" data-drop-folder="' + ESC(folder.id) + '" ' +
      'style="padding-left:' + (8 + depth * 15) + 'px">' +
      caret +
      '<span class="item-ic">' + icon('i-folder') + '</span>' +
      '<span class="item-body"><span class="item-title">' + ESC(folder.name) + '</span></span>' +
      '<span class="item-badge">' + count + '</span>' +
    '</div>';
  }

  /** 递归生成目录树 HTML（受折叠状态影响） */
  function renderFolderTree(folders, depth, activeId) {
    var html = '';
    folders.forEach(function (f) {
      var children = store.childrenOf(f.id);
      var hasChildren = children.length > 0;
      var collapsed = hasChildren && collapsedFolders.has(f.id);
      html += folderItemRow(f, {
        active: activeId === f.id,
        depth: depth,
        hasChildren: hasChildren,
        collapsed: collapsed
      });
      if (hasChildren && !collapsed) {
        html += renderFolderTree(children, depth + 1, activeId);
      }
    });
    return html;
  }

  function renderSidebar() {
    var data = store.data;

    // 文件夹导航（目录树：根目录 + 任意深度子文件夹）
    var nav = $('folderNav');
    if (!data.folders.length) {
      nav.innerHTML = '<div class="sb-empty-hint">还没有文件夹。<br/>点击上方「新建文件夹」创建，或直接把会话拖入导入区。</div>';
    } else {
      var state = global.DSF.state || {};
      var activeId = (state.mode === 'folder' && state.folderId) ? state.folderId : null;
      nav.innerHTML = renderFolderTree(store.childrenOf(null), 0, activeId);
    }

    // 常用固定：先固定文件夹、再固定会话
    var pinnedList = $('pinnedList');
    var pinnedFolders = data.folders.filter(function (f) { return f.pinned; });
    var pinnedSessions = data.sessions.filter(function (s) { return s.pinned; });
    var pinsHtml = '';
    pinnedFolders.forEach(function (f) {
      pinsHtml +=
        '<li class="sb-item" data-id="' + ESC(f.id) + '" data-type="folder">' +
          '<span class="item-ic" style="color:var(--gold)">' + icon('i-star-fill') + '</span>' +
          '<span class="item-body"><span class="item-title">' + ESC(f.name) + '</span></span>' +
          '<span class="item-actions">' +
            '<button class="icon-btn sm" data-action="unpin-folder" title="取消固定">' + icon('i-x', 'ic-sm') + '</button>' +
          '</span>' +
        '</li>';
    });
    pinnedSessions.forEach(function (s) {
      pinsHtml +=
        '<li class="sb-item" data-id="' + ESC(s.id) + '" data-type="session">' +
          '<span class="item-ic">' + icon('i-chat') + '</span>' +
          '<span class="item-body"><span class="item-title">' + ESC(s.title) + '</span>' +
          '<span class="item-sub">' + ESC(utils.hostOf(s.url)) + '</span></span>' +
          '<span class="item-actions">' +
            '<button class="icon-btn sm" data-action="unpin-session" title="取消固定">' + icon('i-x', 'ic-sm') + '</button>' +
          '</span>' +
        '</li>';
    });
    pinnedList.innerHTML = pinsHtml ||
      '<li class="sb-empty-hint">没有固定项。把常用文件夹 / 会话点亮 ☆ 后就会出现在这里。</li>';

    // 最近关闭
    var recentList = $('recentList');
    var recs = data.recentClosed;
    $('btnClearRecent').hidden = recs.length === 0;
    recentList.innerHTML = recs.map(function (r) {
      return '<li class="sb-item" data-id="' + ESC(r.id) + '" data-type="recent">' +
        '<span class="item-ic">' + icon('i-clock') + '</span>' +
        '<span class="item-body"><span class="item-title">' + ESC(r.title) + '</span>' +
        '<span class="item-sub">' + ESC(r.folderName || '已删除文件夹') + ' · ' + ESC(utils.timeAgo(r.closedAt)) + '</span></span>' +
        '<span class="item-actions">' +
          '<button class="icon-btn sm" data-action="restore" title="恢复到原文件夹">' + icon('i-restore', 'ic-sm') + '</button>' +
          '<button class="icon-btn sm danger-hover" data-action="discard" title="彻底删除">' + icon('i-trash', 'ic-sm') + '</button>' +
        '</span>' +
      '</li>';
    }).join('') || '<li class="sb-empty-hint">从文件夹中「关闭」的会话会自动归档到这里，可一键找回。</li>';

    // 统计
    var st = store.stats();
    $('statText').textContent = st.folders + ' 个文件夹 · ' + st.sessions + ' 个会话';

    // 存储状态提示
    var info = global.DSF.storageInfo || {};
    var mode = info.mode || (store.isMemoryOnly() ? 'session' : 'local');
    var storageTexts = {
      file: '自动保存到数据文件 dsf-data.json',
      local: '自动保存到浏览器本地存储',
      session: '仅本次会话有效（未持久化）'
    };
    var storageEl = $('storageText');
    storageEl.className = 'sb-storage ' + (mode === 'file' ? 'file' : (mode === 'session' ? 'session' : ''));
    storageEl.innerHTML = '<span class="dot"></span>' + ESC(storageTexts[mode] || storageTexts.local);
    $('memWarn').hidden = !store.isMemoryOnly() || mode === 'file';
  }

  /* ------------------------------ 渲染：顶栏 ------------------------------ */

  function crumbBtn(label, action, current, dataId) {
    return '<button type="button" class="crumb' + (current ? ' current' : '') + '"' +
      (action ? ' data-action="' + action + '"' : '') +
      (dataId ? ' data-id="' + dataId + '"' : '') + '>' +
      ESC(label) + '</button>';
  }

  function renderHeader() {
    var state = global.DSF.state || {};
    var crumbs, actionsHtml = '';

    if (state.searchText) {
      crumbs = crumbBtn('全部文件夹', 'go-root') +
        '<span class="sep">' + icon('i-chevron', 'ic-sm') + '</span>' +
        crumbBtn('搜索：“' + state.searchText + '”', null, true);
    } else if (state.mode === 'folder') {
      var folder = store.getFolder(state.folderId);
      var chain = folder ? (store.folderChain(folder.id) || []) : [];
      if (folder) {
        crumbs = crumbBtn('全部文件夹', 'go-root');
        chain.forEach(function (f, i) {
          crumbs += '<span class="sep">' + icon('i-chevron', 'ic-sm') + '</span>';
          crumbs += crumbBtn(f.name, 'open-folder', i === chain.length - 1, f.id);
        });

        var n = store.folderSessionCount(folder.id);
        var sub = store.childrenFolderCount(folder.id);
        var info = n + ' 个会话';
        if (sub) info += ' · ' + sub + ' 个子文件夹';
        var fid = ESC(folder.id);
        actionsHtml =
          '<span style="font-size:12px;color:var(--text-3);margin-right:2px">' + info + '</span>' +
          '<button class="btn subtle btn-label" data-action="new-subfolder" data-id="' + fid + '" title="在当前文件夹中创建子文件夹">' +
            icon('i-plus') + '子文件夹</button>' +
          '<button class="icon-btn' + (folder.pinned ? ' starred' : '') + '" data-action="star-folder" ' +
            'data-id="' + fid + '" ' +
            'title="' + (folder.pinned ? '取消固定' : '固定到侧边栏') + '">' +
            icon(folder.pinned ? 'i-star-fill' : 'i-star') + '</button>' +
          '<button class="icon-btn" data-action="edit-folder" data-id="' + fid + '" title="重命名文件夹">' +
            icon('i-edit') + '</button>' +
          '<button class="icon-btn" data-action="move-folder" data-id="' + fid + '" title="移动到其它文件夹 / 根目录">' +
            icon('i-move') + '</button>' +
          '<button class="icon-btn danger-hover" data-action="delete-folder" data-id="' + fid + '" ' +
            'title="删除整个文件夹树（会话进入最近关闭）">' + icon('i-trash') + '</button>';
      } else {
        crumbs = crumbBtn('全部文件夹', 'go-root') +
          '<span class="sep">' + icon('i-chevron', 'ic-sm') + '</span>' +
          crumbBtn('（文件夹已删除）', null, true);
      }
    } else {
      crumbs = crumbBtn('全部文件夹', null, true);
      actionsHtml =
        '<button class="btn subtle btn-label" data-action="new-folder">' + icon('i-plus') + '新建文件夹</button>';
    }

    $('crumbs').innerHTML = crumbs;
    $('viewActions').innerHTML = actionsHtml;
  }

  /* ------------------------------ 渲染：主内容 ------------------------------ */

  function sessionCardHtml(s, extra) {
    var host = utils.hostOf(s.url);
    var time = s.lastOpenedAt ? '上次打开 ' + utils.timeAgo(s.lastOpenedAt)
                              : '创建于 ' + utils.timeAgo(s.createdAt);
    return '<article class="session-card" draggable="true" data-id="' + ESC(s.id) + '" ' +
      'title="' + ESC(s.url) + '">' +
      '<div class="sc-top">' +
        '<span class="sc-avatar">' + icon('i-chat') + '</span>' +
        '<div class="sc-main">' +
          '<div class="sc-title">' + ESC(s.title) + '</div>' +
          '<div class="sc-host">' + ESC(host || s.url) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sc-foot">' +
        '<span class="sc-time">' + ESC(time) + '</span>' +
        '<span class="sc-actions">' +
          (extra && extra.showOpen ? '<button class="icon-btn sm" data-action="open-session" title="在新标签页打开" aria-label="在新标签页打开">' + icon('i-external', 'ic-sm') + '</button>' : '') +
          '<button class="icon-btn sm' + (s.pinned ? ' starred' : '') + '" data-action="star-session" title="' + (s.pinned ? '取消固定' : '固定到侧边栏') + '" aria-label="' + (s.pinned ? '取消固定' : '固定到侧边栏') + '">' +
            icon(s.pinned ? 'i-star-fill' : 'i-star', 'ic-sm') + '</button>' +
          '<button class="icon-btn sm" data-action="edit-session" title="重命名" aria-label="重命名会话">' + icon('i-edit', 'ic-sm') + '</button>' +
          '<button class="icon-btn sm" data-action="move-session" title="移动到其它文件夹" aria-label="移动到其它文件夹">' + icon('i-move', 'ic-sm') + '</button>' +
          '<button class="icon-btn sm danger-hover" data-action="remove-session" title="关闭（移入最近关闭）" aria-label="关闭（移入最近关闭）">' + icon('i-x', 'ic-sm') + '</button>' +
        '</span>' +
      '</div>' +
    '</article>';
  }

  function folderCardHtml(f) {
    var n = store.folderSessionCount(f.id);
    var subN = store.childrenFolderCount(f.id);
    var meta = n + ' 个会话';
    if (subN) meta += ' · ' + subN + ' 个子文件夹';
    return '<article class="folder-card" draggable="true" data-id="' + ESC(f.id) +
      '" data-drop-folder="' + ESC(f.id) + '" title="' + ESC(store.folderPathLabel(f.id)) + '">' +
      '<div class="fc-top">' +
        '<span class="fc-icon">' + icon('i-folder') + '</span>' +
        '<span class="fc-name" title="' + ESC(f.name) + '">' + ESC(f.name) + '</span>' +
      '</div>' +
      '<div class="fc-meta"><span>' + ESC(meta) + '</span><span>创建于 ' + ESC(utils.timeAgo(f.createdAt)) + '</span></div>' +
      '<div class="fc-actions">' +
        '<button class="icon-btn sm' + (f.pinned ? ' starred' : '') + '" data-action="star-folder" title="' + (f.pinned ? '取消固定' : '固定到侧边栏') + '" aria-label="' + (f.pinned ? '取消固定' : '固定到侧边栏') + '">' +
          icon(f.pinned ? 'i-star-fill' : 'i-star', 'ic-sm') + '</button>' +
        '<button class="icon-btn sm" data-action="edit-folder" title="重命名文件夹" aria-label="重命名文件夹">' + icon('i-edit', 'ic-sm') + '</button>' +
        '<button class="icon-btn sm" data-action="move-folder" title="移动到其它文件夹 / 根目录" aria-label="移动文件夹">' + icon('i-move', 'ic-sm') + '</button>' +
        '<button class="icon-btn sm danger-hover" data-action="delete-folder" title="删除整个文件夹树（会话进入最近关闭）" aria-label="删除文件夹">' + icon('i-trash', 'ic-sm') + '</button>' +
      '</div>' +
    '</article>';
  }

  function emptyState(iconName, title, descHtml, extraHtml) {
    return '<div class="empty-state">' +
      '<div class="es-ic">' + icon(iconName) + '</div>' +
      '<div class="es-title">' + ESC(title) + '</div>' +
      (descHtml ? '<div class="es-desc">' + descHtml + '</div>' : '') +
      (extraHtml || '') +
    '</div>';
  }

  function renderContent() {
    var state = global.DSF.state || {};
    var data = store.data;
    var content = $('content');

    // ---------- 搜索模式 ----------
    if (state.searchText) {
      var q = state.searchText.toLowerCase();
      var hits = store.search(q);
      if (!hits.folders.length && !hits.sessions.length) {
        content.innerHTML = emptyState('i-search', '没有找到匹配项',
          '没有标题或链接中包含「' + ESC(q) + '」的文件夹 / 会话。');
        return;
      }
      var html = '';
      if (hits.folders.length) {
        html += '<div class="section-label">文件夹（' + hits.folders.length + '）</div>' +
          '<div class="cards-grid">' + hits.folders.map(folderCardHtml).join('') + '</div>';
      }
      if (hits.sessions.length) {
        html += '<div class="section-label" style="margin-top:18px">会话（' + hits.sessions.length + '）</div>' +
          '<div class="cards-grid">' + hits.sessions.map(function (s) { return sessionCardHtml(s, { showOpen: true }); }).join('') + '</div>';
      }
      content.innerHTML = html;
      return;
    }

    // ---------- 文件夹视图（子文件夹 + 会话） ----------
    if (state.mode === 'folder') {
      var folder = store.getFolder(state.folderId);
      if (!folder) {
        content.innerHTML = emptyState('i-folder', '文件夹不存在',
          '它可能已被删除。<br/>其中保存的会话已自动进入侧边栏「最近关闭」，可随时找回。');
        return;
      }
      var childFolders = store.childrenOf(folder.id);
      var sessions = store.sessionsOf(folder.id); // 索引缓存，避免每次全表过滤
      var html = '';

      if (!childFolders.length && !sessions.length) {
        content.innerHTML = emptyState('i-folder', '「' + folder.name + '」还是空的',
          '文件夹支持无限层级嵌套，你可以在这里继续细分，也可以直接保存会话。',
          '<div class="es-steps">' +
            '1. 点击顶栏<b>「子文件夹」</b>创建子分类（例如：学习 › 数学 › 微积分）；<br/>' +
            '2. 在 DeepSeek 中打开会话，把<b>会话按钮 / 链接拖到上方导入区</b>；<br/>' +
            '3. 也可以把链接直接拖到本页面任意位置（自动保存到此文件夹）。' +
          '</div>');
        return;
      }

      if (childFolders.length) {
        html += '<div class="section-label">子文件夹（' + childFolders.length + '）</div>' +
          '<div class="cards-grid">' +
            '<button type="button" class="create-tile" data-action="new-subfolder" style="font-family:inherit">' +
              '<span class="ct-ic">' + icon('i-plus', 'ic-lg') + '</span>新建子文件夹' +
            '</button>' +
            childFolders.map(folderCardHtml).join('') +
          '</div>';
      }

      if (sessions.length) {
        html += '<div class="section-label" style="margin-top:20px">会话（' + sessions.length + '）</div>' +
          '<div class="cards-grid">' +
            sessions.map(function (s) { return sessionCardHtml(s, { showOpen: true }); }).join('') +
          '</div>';
      } else {
        html += '<div class="section-note" style="margin-top:16px">此文件夹还没有会话：' +
          '把 DeepSeek 会话按钮 / 链接拖入页面任意位置即可保存到「' + ESC(folder.name) + '」。</div>';
      }
      content.innerHTML = html;
      return;
    }

    // ---------- 根视图（根目录文件夹） ----------
    if (!data.folders.length) {
      content.innerHTML = emptyState('i-folder', '欢迎使用 DSF · DeepSeek 会话夹',
        '把散落在几十个会话里的知识，像文件一样整理起来。',
        '<div class="es-steps">' +
          '1. 点击<b>「新建文件夹」</b>创建分类，文件夹内还能继续创建<b>子文件夹</b>；<br/>' +
          '2. 在 DeepSeek 中打开目标会话，把<b>会话按钮拖到上方导入区</b>（或复制链接后「粘贴链接导入」）；<br/>' +
          '3. 点击会话卡片即可<b>直达原会话</b>；点亮 ☆ 固定常用、关闭即自动归档到「最近关闭」。' +
        '</div>');
      return;
    }

    var roots = store.childrenOf(null);
    var totalFolders = data.folders.length;
    content.innerHTML =
      '<div class="section-label">文件夹（' + roots.length + '）' +
        (totalFolders > roots.length
          ? '<span style="margin-left:8px;font-weight:400">共 ' + totalFolders + ' 个（含子文件夹）</span>' : '') +
      '</div>' +
      '<div class="cards-grid">' +
        '<button type="button" class="create-tile" data-action="new-folder" style="font-family:inherit">' +
          '<span class="ct-ic">' + icon('i-plus', 'ic-lg') + '</span>新建文件夹' +
        '</button>' +
        roots.map(folderCardHtml).join('') +
      '</div>';
  }

  /* ------------------------------ 总入口 ------------------------------ */

  /** 折叠 / 展开某目录树的子项；返回折叠后的状态（仅记忆本次会话） */
  function toggleFolderCollapse(id) {
    if (collapsedFolders.has(id)) { collapsedFolders.delete(id); return false; }
    collapsedFolders.add(id);
    return true;
  }

  function render() {
    renderSidebar();
    renderHeader();
    renderContent();
    // 顶栏切换按钮状态
    var appEl = $('app');
    var collapsed = store.data.settings.sidebarCollapsed;
    appEl.classList.toggle('sb-collapsed', collapsed);
    $('btnToggleSidebar').title = collapsed ? '展开侧边栏' : '收起侧边栏';
    // 搜索框清空按钮
    var state = global.DSF.state || {};
    $('btnClearSearch').hidden = !state.searchText;
    $('searchInput').value = state.searchText || '';
  }

  /* ------------------------------ 对外 API ------------------------------ */

  global.DSF = global.DSF || {};
  global.DSF.ui = {
    $: $,
    icon: icon,
    toast: toast,
    prompt: prompt,
    textDialog: textDialog,
    confirm: confirm,
    picker: picker,
    expandPathTo: expandPathTo,
    toggleFolderCollapse: toggleFolderCollapse,
    openImportDialog: openImportDialog,
    pasteAndImport: pasteAndImport,
    render: render,
    scheduleRender: scheduleRender,
    renderNow: renderNow,
    renderSidebar: renderSidebar,
    renderHeader: renderHeader,
    renderContent: renderContent,
    // 内部导出（测试/调试用）
    _templates: { sessionCardHtml: sessionCardHtml, folderCardHtml: folderCardHtml }
  };
})(window);
