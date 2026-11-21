/* 通用工具函数 */
(function (global) {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function toBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(b64) {
    var clean = String(b64 || '').replace(/\s/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function base64ToBytes(b64) {
    var clean = String(b64 || '').replace(/\s/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  var BINARY_EXT = ('png jpg jpeg gif bmp ico webp svg pdf zip gz tar rar 7z exe dll bin dat db sqlite '
    + 'woff woff2 ttf eot otf mp3 wav ogg mp4 mov avi webm mkv wasm class jar pyc lock').split(' ');

  function isBinaryName(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return BINARY_EXT.indexOf(ext) !== -1;
  }

  function hasNullByte(text) {
    var sample = text.slice(0, 8000);
    return sample.indexOf('\u0000') !== -1;
  }

  function badgeFor(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var map = { markdown: 'md', javascript: 'js', typescript: 'ts', txt: 'txt' };
    var label = map[ext] || ext;
    if (label.length > 4) label = label.slice(0, 3);
    return { label: (label || 'file').toUpperCase(), cls: ext };
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function toast(message, type, duration, action) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var icons = { ok: 'i-check', err: 'i-warn', warn: 'i-warn', info: 'i-info' };
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = '<svg class="ico"><use href="#' + (icons[type] || 'i-info') + '"></use></svg><div class="toast-body"><span class="toast-msg"></span></div>';
    el.querySelector('.toast-msg').textContent = message;
    if (action && typeof action.onClick === 'function') {
      var btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label || '撤销';
      btn.addEventListener('click', function () {
        el.remove();
        action.onClick();
      });
      el.querySelector('.toast-body').appendChild(btn);
      duration = Math.max(duration || 3200, 10000);
    }
    host.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'opacity .2s, transform .2s';
      setTimeout(function () { el.remove(); }, 220);
    }, duration || 3200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  /* 轻量 Markdown 渲染（先转义 HTML，避免执行仓库内容中的脚本） */
  function markdown(src) {
    var blocks = [];
    function stash(html) { blocks.push(html); return '\u0000B' + (blocks.length - 1) + '\u0000'; }

    var text = String(src || '').replace(/\r\n?/g, '\n');
    text = escapeHtml(text);

    // 围栏代码块
    text = text.replace(/```([\w-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return stash('<pre><code class="lang-' + lang + '">' + code.replace(/\n$/, '') + '</code></pre>');
    });

    // 标题 / 分割线 / 引用 / 列表（逐行）
    var lines = text.split('\n');
    var out = [];
    var listType = null;
    function closeList() { if (listType) { out.push('</' + listType + '>'); listType = null; } }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\u0000B\d+\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>'); continue; }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
      if (/^&gt;\s?/.test(line)) {
        closeList();
        var quote = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) quote.push(lines[i].replace(/^&gt;\s?/, '')); i++;
        i--;
        out.push('<blockquote>' + inline(quote.join('\n')) + '</blockquote>');
        continue;
      }
      var ul = line.match(/^\s*[-*+]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        var type = ul ? 'ul' : 'ol';
        if (listType !== type) { closeList(); out.push('<' + type + '>'); listType = type; }
        out.push('<li>' + inline((ul || ol)[1]) + '</li>');
        continue;
      }
      closeList();
      if (line.trim() === '') { out.push(''); continue; }
      out.push('<p>' + inline(line) + '</p>');
    }
    closeList();

    function inline(s) {
      return s
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    }

    var html = out.join('\n');
    html = html.replace(/\u0000B(\d+)\u0000/g, function (_, idx) { return blocks[+idx]; });
    return html;
  }

  global.Utils = {
    escapeHtml: escapeHtml, formatBytes: formatBytes, toBase64: toBase64,
    fromBase64: fromBase64, base64ToBytes: base64ToBytes,
    arrayBufferToBase64: arrayBufferToBase64, isBinaryName: isBinaryName,
    hasNullByte: hasNullByte, badgeFor: badgeFor, debounce: debounce,
    toast: toast, copyText: copyText, markdown: markdown
  };
})(window);
