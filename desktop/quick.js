/* =========================================================================
 * desktop/quick.js — 快速导入悬浮窗的渲染逻辑
 * -------------------------------------------------------------------------
 * 职责：接收从浏览器拖来的链接 / 文本 / 文本文件，用与网页版相同的
 *       DF.utils 解析规则识别 DeepSeek 链接，然后把原始数据交给主进程，
 *       由主进程唤起主窗口并转交给页面完成导入。
 * 注意：本窗口不做任何导入决策，只做「接收 → 转交」。
 * ========================================================================= */
'use strict';

(function () {
  var drop = document.getElementById('drop');
  var tip = document.getElementById('tip');
  var closeBtn = document.getElementById('close');
  var resetTimer = null;

  var IDLE_TEXT = '拖入链接';

  function setState(text, cls) {
    if (text !== null) tip.textContent = text;
    drop.className = cls || '';
  }

  function scheduleReset() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function () { setState(IDLE_TEXT, ''); }, 1800);
  }

  function safeGet(dt, type) {
    try { return dt.getData(type) || ''; } catch (e) { return ''; }
  }

  function readAsText(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { resolve(''); };
      reader.readAsText(file);
    });
  }

  /* ---------------------------- 拖放 ---------------------------- */

  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!drop.classList.contains('hot')) setState('松手导入', 'hot');
    });
  });

  window.addEventListener('dragleave', function (e) {
    if (e.relatedTarget) return; // 仅在真正离开窗口时复位
    clearTimeout(resetTimer);
    setState(IDLE_TEXT, '');
  });

  window.addEventListener('drop', function (e) {
    e.preventDefault();
    var dt = e.dataTransfer;
    var payload = {
      uriList: safeGet(dt, 'text/uri-list'),
      plain: safeGet(dt, 'text/plain'),
      html: safeGet(dt, 'text/html')
    };
    var files = Array.prototype.slice.call((dt && dt.files) || []);

    if (files.length) {
      Promise.all(files.map(readAsText)).then(function (parts) {
        payload.plain = (payload.plain ? payload.plain + '\n' : '') + parts.join('\n');
        finish(payload);
      });
    } else {
      finish(payload);
    }
  });

  function finish(payload) {
    var count = 0;
    try { count = window.DF.utils.buildCandidates(payload).length; } catch (err) { count = 0; }

    if (!count) {
      setState('未识别到链接', 'hot');
      scheduleReset();
      return;
    }

    setState('已接收 ' + count + ' 个链接', 'ok');
    if (window.dfQuick) window.dfQuick.sendDrop(payload);
    scheduleReset();
  }

  /* ---------------------------- 交互 ---------------------------- */

  closeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (window.dfQuick) window.dfQuick.close();
  });

  // 点击悬浮窗（非关闭按钮）＝ 唤起主窗口
  window.addEventListener('click', function () {
    if (window.dfQuick) window.dfQuick.restore();
  });
})();
