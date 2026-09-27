/* =========================================================================
 * dsf.utils.js — DSF (DeepSeek Session Folder) 工具层
 * -------------------------------------------------------------------------
 * 提供通用小工具与「DeepSeek 会话链接」解析能力。
 * 纯浏览器环境、无第三方依赖，兼容 file:// 直接打开。
 * ========================================================================= */
(function (global) {
  'use strict';

  var utils = {};

  /* ------------------------------ 基础工具 ------------------------------ */

  /** 生成唯一 id（优先 crypto.randomUUID，失败时降级） */
  utils.uid = function () {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  /** HTML 转义（用于插入模板字符串前防止注入） */
  utils.escapeHtml = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /** 简单防抖 */
  utils.debounce = function (fn, wait) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  };

  /** 相对时间（中文） */
  utils.timeAgo = function (ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 86400e3 * 7) return Math.floor(diff / 86400e3) + ' 天前';
    var d = new Date(ts);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  };

  /** 绝对时间 yyyy-MM-dd HH:mm */
  utils.formatDate = function (ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  /** 截断标题（总长度不超过 max，含省略号） */
  utils.clampTitle = function (s, max) {
    s = String(s == null ? '' : s).trim();
    max = max || 60;
    if (max < 2) max = 2;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  /**
   * 生成「同一会话」的去重键。
   * 同一条 DeepSeek 会话可能以多种等价写法被粘贴/拖入：
   *   .../a/chat/s/abc · .../a/chat/s/abc/ · .../a/chat/s/abc#frag?utm=1
   * 这里忽略协议大小写、末尾斜杠、fragment 与 query 顺序，得到稳定比较键。
   * 用于 findDuplicate / 导入去重（只影响“是否视为重复”，不改变保存的原始 URL）。
   */
  utils.urlKey = function (url) {
    if (!url) return '';
    try {
      var u = new URL(String(url).trim());
      var path = u.pathname.replace(/\/+$/, '');
      var params = [];
      u.searchParams.forEach(function (v, k) { params.push(k + '=' + v); });
      params.sort();
      var query = params.length ? '?' + params.join('&') : '';
      return (u.protocol.toLowerCase() + '//' + u.hostname.toLowerCase() +
        (u.port ? ':' + u.port : '') + path + query).toLowerCase();
    } catch (e) {
      return String(url).trim().toLowerCase();
    }
  };

  /** 提取 URL 的 hostname（去掉 www.） */
  utils.hostOf = function (url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  };

  /* ---------------------- DeepSeek 链接识别与解析 ----------------------- */

  /** 是否为 DeepSeek 相关域名的链接 */
  utils.isDeepseekUrl = function (url) {
    if (!url) return false;
    try {
      var h = new URL(url).hostname.toLowerCase();
      return h === 'deepseek.com' || h === 'chat.deepseek.com' || h.endsWith('.deepseek.com');
    } catch (e) { return false; }
  };

  /**
   * 归一化 URL：截取合法 ASCII 前缀、去首尾空白与多余的尾部标点、校验协议。
   * 返回可用的完整 URL 字符串；非法返回 null。
   */
  utils.normalizeUrl = function (raw) {
    if (!raw) return null;
    var u = String(raw).trim();
    // 只保留 URL 合法 ASCII 字符前缀（防止正则把相邻中文文本吞进来）
    var clip = u.match(/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
    if (clip) u = clip[0];
    // 去掉 URL 末尾常见的粘连符号（中英文标点、括号等）
    u = u.replace(/[),.;:!?，。；：、）》"'`]+$/g, '');
    if (!/^https?:\/\//i.test(u)) return null;
    try {
      var url = new URL(u);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.href;
    } catch (e) { return null; }
  };

  /**
   * 从一段文本（纯文本 / uri-list / HTML 源码等）中提取全部 DeepSeek 链接。
   * 自动去重，返回归一化后的 URL 数组。
   * 字符类显式排除中文（含全角标点），避免相邻中文被吞入 URL 而漏掉后续链接。
   */
  utils.extractDeepseekUrls = function (text) {
    if (!text) return [];
    var out = [];
    var seen = {};
    var re = /https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var norm = utils.normalizeUrl(m[0]);
      if (norm && utils.isDeepseekUrl(norm) && !seen[norm]) {
        seen[norm] = true;
        out.push(norm);
      }
    }
    return out;
  };

  /** 解析拖拽携带的 text/html，提取 <a href> 中指向 DeepSeek 的链接与锚文本 */
  utils.extractAnchors = function (html) {
    if (!html || !html.trim()) return [];
    var out = [];
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('a[href]').forEach(function (a) {
        var href = utils.normalizeUrl(a.getAttribute('href'));
        var text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (href && utils.isDeepseekUrl(href)) out.push({ href: href, text: text });
      });
    } catch (e) { /* ignore */ }
    return out;
  };

  /** 从拖拽 HTML 中尝试推断一个可读的会话标题（找不到则返回 null） */
  utils.guessTitleFromHtml = function (html) {
    if (!html) return null;
    var anchors = utils.extractAnchors(html);
    var STOP = new Set(['deepseek', '在浏览器中打开', 'open', 'deepseek 网页版', 'chat.deepseek.com']);
    for (var i = 0; i < anchors.length; i++) {
      var t = anchors[i].text;
      if (t && t.length >= 2 && t.length <= 200 && !STOP.has(t.toLowerCase())) return t;
    }
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var titleEl = doc.querySelector('title, meta[property="og:title"], meta[name="twitter:title"]');
      var cand = titleEl ? (titleEl.getAttribute('content') || titleEl.textContent || '') : '';
      cand = cand.trim();
      if (cand && cand.length >= 2 && cand.length <= 200) return cand;
    } catch (e) { /* ignore */ }
    return null;
  };

  /** 把 uri-list / text / html 等多种数据混合解析为「导入候选」数组 */
  utils.buildCandidates = function (data) {
    var candidates = [];
    var seen = {};
    function push(url, title) {
      if (!url || seen[url]) return;
      seen[url] = true;
      candidates.push({ url: url, title: title || null });
    }
    // 1) uri-list：一行为一个 URL
    var uris = data.uriList || '';
    uris.split(/\r?\n/).forEach(function (line) {
      var norm = utils.normalizeUrl(line.trim());
      if (norm && utils.isDeepseekUrl(norm)) push(norm, null);
    });
    // 2) html 中的 <a>（可携带更有意义的锚文本）
    var anchors = utils.extractAnchors(data.html || '');
    anchors.forEach(function (a) { push(a.href, a.text || null); });
    // 3) 纯文本兜底
    var guessed = utils.guessTitleFromHtml(data.html || '');
    var plainUrls = utils.extractDeepseekUrls(data.plain || '');
    plainUrls.forEach(function (u) { push(u, guessed || null); });
    return candidates;
  };

  global.DSF = global.DSF || {};
  global.DSF.utils = utils;
})(window);
