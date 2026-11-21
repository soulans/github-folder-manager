/* GitHub 文件管理器 —— 主逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  // 默认仅为一个公开示例仓库，请在「设置」中改成自己要管理的仓库
  var DEFAULT_REPO = 'https://github.com/soulans/github-folder-manager';
  var K_CFG = 'ghe.config', K_EXP = 'ghe.expanded', K_THEME = 'ghe.theme', K_SIDE = 'ghe.sidebar';
  var K_INIT = 'ghe.initialized';

  var state = {
    cfg: null, client: null, entries: [], tree: null, root: null,
    expanded: new Set(), currentFolder: '', selected: '', search: '',
    tabs: [], active: null, editor: null, suppressChange: false,
    preview: false, connecting: false, pending: {}, dragDepth: 0, dropFiles: [],
    mode: 'browse', checked: new Set(), staged: [], stageEditing: null,
    lastSnapshot: null, lastAnchor: null,
    listSort: { key: 'name', dir: 1 }, marquee: null, draggingPaths: null
  };

  /* ============ 持久化 ============ */
  function loadJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function defaultConfig() {
    return { repo: DEFAULT_REPO, token: '', branch: '', apiBase: 'https://api.github.com', proxy: '', remember: true };
  }
  function loadConfig() {
    var saved = loadJSON(K_CFG, null);
    if (saved && typeof saved === 'object') return Object.assign(defaultConfig(), saved);
    return defaultConfig();
  }
  function persistConfig(cfg) {
    if (cfg.remember) saveJSON(K_CFG, cfg);
    else { try { localStorage.removeItem(K_CFG); } catch (e) {} }
  }

  /* ============ 工具 ============ */
  function joinPath(folder, name) {
    var f = String(folder || '').replace(/^\/+|\/+$/g, '');
    var n = String(name || '').replace(/^\/+|\/+$/g, '');
    return f ? f + '/' + n : n;
  }
  function parentOf(path) {
    var parts = String(path || '').split('/');
    parts.pop();
    return parts.join('/');
  }
  function baseOf(path) { return String(path || '').split('/').pop(); }
  function findEntry(path) {
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].path === path) return state.entries[i];
    return null;
  }
  function descendants(path) {
    var prefix = path + '/';
    return state.entries.filter(function (e) { return e.path.indexOf(prefix) === 0 && e.type === 'blob'; });
  }
  function activeTab() {
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].path === state.active) return state.tabs[i];
    return null;
  }
  function commitMessage(fallback) {
    var v = (state.mode === 'manage' ? $('manageCommitInput') : $('commitInput')).value.trim();
    return v || fallback;
  }
  function clearCommitInput() {
    (state.mode === 'manage' ? $('manageCommitInput') : $('commitInput')).value = '';
  }
  function setBusy(busy, text) {
    $('btnSaveFile').disabled = busy;
    $('btnCommitAll').disabled = busy;
    if (busy) {
      if (text) {
        setBusy._prevStatus = $('treeStatus').textContent;
        $('treeStatus').textContent = text;
      }
    } else if (setBusy._prevStatus !== undefined) {
      $('treeStatus').textContent = setBusy._prevStatus;
      delete setBusy._prevStatus;
    }
  }

  var uploadProgressTimer = null;
  function showUploadProgress(title, detail) {
    if (uploadProgressTimer) { clearTimeout(uploadProgressTimer); uploadProgressTimer = null; }
    $('uploadProgress').hidden = false;
    $('uploadTitle').textContent = title || '正在上传';
    $('uploadPercent').textContent = '0%';
    $('uploadBar').style.width = '0%';
    $('uploadDetail').textContent = detail || '准备中…';
  }
  function updateUploadProgress(pct, detail, title) {
    var n = Math.max(0, Math.min(100, Math.round(pct || 0)));
    $('uploadBar').style.width = n + '%';
    $('uploadPercent').textContent = n + '%';
    if (detail !== undefined) $('uploadDetail').textContent = detail;
    if (title !== undefined) $('uploadTitle').textContent = title;
  }
  function hideUploadProgress(delay) {
    if (uploadProgressTimer) clearTimeout(uploadProgressTimer);
    uploadProgressTimer = setTimeout(function () {
      $('uploadProgress').hidden = true;
      uploadProgressTimer = null;
    }, delay === undefined ? 600 : delay);
  }
  function readFileBase64(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      fr.onload = function () {
        var base64 = Utils.arrayBufferToBase64(fr.result);
        if (onProgress) onProgress(1);
        resolve(base64);
      };
      fr.onerror = function () { reject(fr.error || new Error('读取本地文件失败')); };
      fr.readAsArrayBuffer(file);
    });
  }
  const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

  /* ============ 文件树构建 ============ */
  function buildTree(entries) {
    var root = { name: '', path: '', type: 'tree', children: new Map() };
    entries.forEach(function (e) {
      var parts = e.path.split('/');
      var node = root;
      for (var i = 0; i < parts.length; i++) {
        var isLeaf = i === parts.length - 1;
        var name = parts[i];
        var path = parts.slice(0, i + 1).join('/');
        if (!node.children.has(name)) {
          node.children.set(name, {
            name: name, path: path,
            type: isLeaf ? (e.type === 'tree' ? 'tree' : 'blob') : 'tree',
            size: isLeaf ? e.size : null,
            sha: isLeaf ? e.sha : null,
            children: isLeaf && e.type !== 'tree' ? null : new Map()
          });
        } else if (!isLeaf) {
          var existing = node.children.get(name);
          if (!existing.children) existing.children = new Map();
        }
        node = node.children.get(name);
        if (!node.children) node.children = new Map();
      }
    });
    return root;
  }
  function sortedChildren(node) {
    return Array.from(node.children.values()).sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    });
  }

  /* ============ 树渲染 ============ */
  function renderTree() {
    var host = $('tree');
    host.innerHTML = '';
    if (!state.root) {
      host.innerHTML = '<div class="tree-empty">点击刷新或配置仓库后显示文件</div>';
      return;
    }
    var term = state.search.trim().toLowerCase();
    if (term) {
      var matches = state.entries.filter(function (e) {
        return e.type === 'blob' && e.path.toLowerCase().indexOf(term) !== -1;
      }).slice(0, 300);
      if (!matches.length) {
        host.innerHTML = '<div class="tree-empty">没有匹配「' + Utils.escapeHtml(state.search) + '」的文件</div>';
      } else {
        matches.forEach(function (e) {
          var row = makeRow(baseOf(e.path), e.path, 'blob', 0, e.size, true);
          row.querySelector('.size').textContent = e.path.indexOf('/') >= 0 ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
          host.appendChild(row);
        });
      }
      $('treeStatus').textContent = '匹配 ' + matches.length + ' 个文件';
      return;
    }

    function walk(node, depth) {
      sortedChildren(node).forEach(function (child) {
        host.appendChild(makeRow(child.name, child.path, child.type, depth, child.size, false));
        if (child.type === 'tree' && state.expanded.has(child.path)) walk(child, depth + 1);
      });
    }
    walk(state.root, 0);
    if (!host.children.length) host.innerHTML = '<div class="tree-empty">仓库是空的</div>';
    var base = state.entries.filter(function (e) { return e.type === 'blob'; }).length + ' 个文件 · '
      + state.entries.filter(function (e) { return e.type === 'tree'; }).length + ' 个文件夹';
    $('treeStatus').textContent = base + (state.mode === 'manage' && state.checked.size
      ? ' · 已选 ' + state.checked.size + ' 项' : '');
  }

  function makeRow(name, path, type, depth, size, showPath) {
    var row = document.createElement('div');
    var checked = state.checked.has(path);
    row.className = 'tree-row' + (type === 'tree' && state.expanded.has(path) ? ' open' : '')
      + (state.selected === path && state.mode === 'browse' ? ' selected' : '')
      + (checked ? ' checked' : '');
    row.dataset.path = path;
    row.dataset.type = type;
    row.style.paddingLeft = (6 + depth * 14) + 'px';

    var check = state.mode === 'manage'
      ? '<input type="checkbox" class="tree-check" ' + (checked ? 'checked' : '') + '>' : '';
    if (type === 'tree') {
      row.innerHTML = check + '<span class="caret"><svg class="ico"><use href="#i-chevron"></use></svg></span>'
        + '<svg class="ico folder-ico"><use href="#i-folder"></use></svg>'
        + '<span class="name">' + Utils.escapeHtml(name) + '</span><span class="size"></span>';
    } else {
      var badge = Utils.badgeFor(name);
      row.innerHTML = check + '<span class="leaf"></span>'
        + '<span class="badge ' + badge.cls + '">' + Utils.escapeHtml(badge.label) + '</span>'
        + '<span class="name">' + Utils.escapeHtml(name) + '</span>'
        + '<span class="size">' + (showPath ? '' : Utils.formatBytes(size)) + '</span>';
    }

    var checkbox = row.querySelector('.tree-check');
    if (checkbox) {
      checkbox.addEventListener('change', function (ev) {
        ev.stopPropagation();
        if (checkbox.checked) state.checked.add(path); else state.checked.delete(path);
        state.lastAnchor = path;
        updateSelectionUI();
      });
    }

    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state.mode === 'manage') {
        if (ev.target.closest('.caret')) {
          if (type === 'tree') {
            if (state.expanded.has(path)) state.expanded.delete(path); else state.expanded.add(path);
            state.currentFolder = path;
            saveJSON(K_EXP, Array.from(state.expanded));
            renderTree(); renderBreadcrumb();
          }
          return;
        }
        selectRow(path, type, ev.ctrlKey || ev.metaKey, ev.shiftKey);
        return;
      }
      state.selected = path;
      document.querySelectorAll('.tree-row.selected').forEach(function (el) { el.classList.remove('selected'); });
      row.classList.add('selected');
      if (type === 'tree') {
        if (state.expanded.has(path)) state.expanded.delete(path); else state.expanded.add(path);
        state.currentFolder = path;
        saveJSON(K_EXP, Array.from(state.expanded));
        renderTree(); renderBreadcrumb();
      } else {
        openFile(path);
      }
    });

    if (state.mode === 'manage') {
      row.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        if (type === 'blob') stageEditExisting(path);
        else if (type === 'tree') {
          if (state.expanded.has(path)) state.expanded.delete(path); else state.expanded.add(path);
          state.currentFolder = path; renderTree(); renderBreadcrumb();
        }
      });
    }

    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (state.mode === 'manage') {
        if (!state.checked.has(path)) {
          state.checked.clear(); state.checked.add(path); updateSelectionUI();
        }
        showManagerContextMenu(ev.clientX, ev.clientY);
        return;
      }
      state.selected = path;
      document.querySelectorAll('.tree-row.selected').forEach(function (el) { el.classList.remove('selected'); });
      row.classList.add('selected');
      showContextMenu(ev.clientX, ev.clientY, path, type);
    });
    return row;
  }

  function updateSelectionUI() {
    document.querySelectorAll('.tree-row, .file-row').forEach(function (el) {
      var on = state.checked.has(el.dataset.path);
      el.classList.toggle('checked', on);
      var cb = el.querySelector('.tree-check');
      if (cb) cb.checked = on;
    });
    var n = state.checked.size;
    $('manageSelection').textContent = n ? '已选 ' + n + ' 项' : '未选择文件';
    $('treeStatus').textContent = state.entries.filter(function (e) { return e.type === 'blob'; }).length
      + ' 个文件 · ' + state.entries.filter(function (e) { return e.type === 'tree'; }).length
      + ' 个文件夹' + (n ? ' · 已选 ' + n + ' 项' : '');
  }

  function selectRow(path, type, additive, range) {
    if (range && state.lastAnchor) {
      var paths = Array.from($('tree').querySelectorAll('.tree-row')).map(function (el) { return el.dataset.path; });
      var a = paths.indexOf(state.lastAnchor), b = paths.indexOf(path);
      if (a >= 0 && b >= 0) {
        paths.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (p) { state.checked.add(p); });
      }
    } else if (additive) {
      if (state.checked.has(path)) state.checked.delete(path); else state.checked.add(path);
      state.lastAnchor = path;
    } else {
      state.checked.clear();
      state.checked.add(path);
      state.lastAnchor = path;
    }
    state.currentFolder = type === 'tree' ? path : parentOf(path);
    updateSelectionUI(); renderBreadcrumb();
  }

  function renderBreadcrumb() {
    var host = $('breadcrumb');
    host.innerHTML = '';
    var parts = state.currentFolder ? state.currentFolder.split('/') : [];
    var a = document.createElement('a');
    a.textContent = state.client ? state.client.repo : '仓库根目录';
    a.addEventListener('click', function () { state.currentFolder = ''; renderBreadcrumb(); });
    host.appendChild(a);
    parts.forEach(function (part, idx) {
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/';
      host.appendChild(sep);
      var seg = parts.slice(0, idx + 1).join('/');
      var el = document.createElement('a');
      el.textContent = part;
      el.addEventListener('click', function () { state.currentFolder = seg; renderBreadcrumb(); });
      host.appendChild(el);
    });
    if (state.active) {
      var sep2 = document.createElement('span'); sep2.className = 'sep'; sep2.textContent = '/';
      host.appendChild(sep2);
      var cur = document.createElement('span'); cur.textContent = baseOf(state.active);
      host.appendChild(cur);
    }
    $('statusPath').textContent = state.active || ('/' + state.currentFolder);
    if (state.mode === 'manage') renderFileList();
  }

  /* ============ 管理模式：右侧资源管理器列表 ============ */
  var STATUS_LABEL = {
    create: '待新建', folder: '待新建', edit: '待修改', upload: '待上传',
    delete: '待删除', rename: '待重命名', move: '待移动', copy: '待复制'
  };
  function listNodes() {
    var prefix = state.currentFolder ? state.currentFolder + '/' : '';
    var map = new Map();
    function restOf(p) {
      if (!p) return '';
      if (prefix) return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : '';
      return p;
    }
    state.entries.forEach(function (e) {
      var rest = restOf(e.path);
      if (!rest || rest.indexOf('/') >= 0) return;
      map.set(rest, {
        name: rest, path: e.path, type: e.type, size: e.size || 0, sha: e.sha, staged: null
      });
    });
    function mark(p, kind) {
      var rest = restOf(p);
      if (!rest || rest.indexOf('/') >= 0) return;
      var node = map.get(rest);
      if (node) {
        if (!node.staged || node.staged === 'delete') node.staged = kind;
      } else {
        map.set(rest, {
          name: rest, path: p, type: kind === 'folder' ? 'tree' : 'blob',
          size: 0, staged: kind, virtual: true
        });
      }
    }
    state.staged.forEach(function (s) {
      if (s.kind === 'delete') mark(s.path, 'delete');
      else if (s.kind === 'rename' || s.kind === 'move' || s.kind === 'copy') {
        mark(s.from, s.kind); mark(s.to, s.kind === 'copy' ? 'create' : s.kind);
      } else mark(s.path, s.kind);
    });
    return Array.from(map.values());
  }
  function sortedListNodes() {
    var nodes = listNodes();
    var sort = state.listSort;
    function value(n) {
      if (sort.key === 'name') return n.name.toLowerCase();
      if (sort.key === 'type') return n.type === 'tree' ? '' : baseOf(n.name).split('.').pop().toLowerCase();
      if (sort.key === 'size') return n.size || 0;
      return n.staged ? STATUS_LABEL[n.staged] || '' : '';
    }
    return nodes.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      var av = value(a), bv = value(b);
      var cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true });
      return cmp * sort.dir;
    });
  }
  function updateSortHeaders() {
    document.querySelectorAll('.explorer-head .sortable').forEach(function (el) {
      el.classList.remove('asc', 'desc');
      if (el.dataset.sort === state.listSort.key) el.classList.add(state.listSort.dir === 1 ? 'asc' : 'desc');
    });
  }
  function makeFileRow(n) {
    var row = document.createElement('div');
    var checked = state.checked.has(n.path);
    var cls = 'file-row' + (checked ? ' checked' : '');
    if (n.staged) cls += ' is-staged staged-' + (n.staged === 'delete' ? 'delete' : 'new');
    row.className = cls;
    row.dataset.path = n.path;
    row.dataset.type = n.type;
    var ico = n.type === 'tree' ? 'i-folder' : 'i-file';
    var icoCls = n.type === 'tree' ? 'folder-ico' : 'file-ico';
    var typeText = n.type === 'tree' ? '文件夹' : (function () {
      var badge = Utils.badgeFor(n.name);
      return badge.label + ' 文件';
    })();
    row.innerHTML = '<div class="cell cell-name"><svg class="ico ' + icoCls + '"><use href="#'
      + ico + '"></use></svg><span class="name">' + Utils.escapeHtml(n.name) + '</span></div>'
      + '<div class="cell cell-type">' + Utils.escapeHtml(typeText) + '</div>'
      + '<div class="cell cell-size">' + (n.type === 'tree' ? '' : Utils.formatBytes(n.size)) + '</div>'
      + '<div class="cell cell-status">' + (n.staged ? Utils.escapeHtml(STATUS_LABEL[n.staged] || '待更改') : '') + '</div>';

    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      selectListRow(n.path, ev.ctrlKey || ev.metaKey, ev.shiftKey);
    });
    row.addEventListener('dblclick', function (ev) {
      ev.stopPropagation();
      if (n.type === 'tree') {
        state.currentFolder = n.path;
        state.expanded.add(n.path);
        saveJSON(K_EXP, Array.from(state.expanded));
        renderBreadcrumb(); renderTree();
      } else if (Utils.isBinaryName(n.path)) {
        Utils.toast('二进制文件无法在线编辑，可下载后修改再上传', 'warn');
      } else stageEditExisting(n.path);
    });
    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (!state.checked.has(n.path)) {
        state.checked.clear(); state.checked.add(n.path); state.lastAnchor = n.path;
        updateSelectionUI();
      }
      showManagerContextMenu(ev.clientX, ev.clientY);
    });

    row.draggable = true;
    row.addEventListener('dragstart', function (ev) {
      if (!state.checked.has(n.path)) {
        state.checked.clear(); state.checked.add(n.path); state.lastAnchor = n.path;
        updateSelectionUI();
      }
      state.draggingPaths = Array.from(state.checked);
      try {
        ev.dataTransfer.setData('text/plain', state.draggingPaths.join('\n'));
        ev.dataTransfer.effectAllowed = 'move';
      } catch (e) {}
    });
    row.addEventListener('dragend', function () {
      state.draggingPaths = null;
      document.querySelectorAll('.file-row.drop-target').forEach(function (el) { el.classList.remove('drop-target'); });
    });
    if (n.type === 'tree') {
      row.addEventListener('dragover', function (ev) {
        if (!state.draggingPaths || state.draggingPaths.indexOf(n.path) >= 0) return;
        ev.preventDefault(); ev.stopPropagation();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', function () { row.classList.remove('drop-target'); });
      row.addEventListener('drop', function (ev) {
        if (!state.draggingPaths) return;
        ev.preventDefault(); ev.stopPropagation();
        row.classList.remove('drop-target');
        var paths = state.draggingPaths.slice();
        state.draggingPaths = null;
        stageMoveTo(n.path, paths);
      });
    }
    return row;
  }
  function renderFileList() {
    var host = $('fileList');
    if (!host || state.mode !== 'manage') return;
    var band = $('rubberBand');
    host.innerHTML = '';
    if (band) { band.hidden = true; host.appendChild(band); }
    if (!state.client || !state.root) {
      host.innerHTML = '<div class="tree-empty">连接仓库后可在此浏览文件</div>';
      if (band) host.appendChild(band);
      $('explorerStatus').textContent = '尚未连接';
      return;
    }
    var nodes = sortedListNodes();
    if (!nodes.length) {
      host.innerHTML = '<div class="tree-empty">这个文件夹是空的</div>';
      if (band) host.appendChild(band);
    } else nodes.forEach(function (n) { host.appendChild(makeFileRow(n)); });
    var dirs = nodes.filter(function (n) { return n.type === 'tree'; }).length;
    $('explorerStatus').textContent = '/' + state.currentFolder + ' · ' + dirs + ' 个文件夹 · ' + (nodes.length - dirs) + ' 个文件';
    updateSortHeaders();
    updateSelectionUI();
  }
  function selectListRow(path, additive, range) {
    var paths = Array.from($('fileList').querySelectorAll('.file-row')).map(function (el) { return el.dataset.path; });
    if (range && state.lastAnchor) {
      var a = paths.indexOf(state.lastAnchor), b = paths.indexOf(path);
      if (a >= 0 && b >= 0) {
        paths.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (p) { state.checked.add(p); });
        state.lastAnchor = path;
      } else { state.checked.clear(); state.checked.add(path); state.lastAnchor = path; }
    } else if (additive) {
      if (state.checked.has(path)) state.checked.delete(path); else state.checked.add(path);
      state.lastAnchor = path;
    } else {
      state.checked.clear(); state.checked.add(path); state.lastAnchor = path;
    }
    updateSelectionUI();
  }
  function bindMarquee() {
    var host = $('fileList');
    var band = $('rubberBand');
    host.appendChild(band);
    host.addEventListener('mousedown', function (e) {
      if (state.mode !== 'manage' || e.button !== 0) return;
      if (e.target.closest && e.target.closest('.file-row')) return;
      e.preventDefault();
      var rect = host.getBoundingClientRect();
      var x0 = e.clientX - rect.left + host.scrollLeft;
      var y0 = e.clientY - rect.top + host.scrollTop;
      var additive = e.ctrlKey || e.metaKey;
      var rows = Array.from(host.querySelectorAll('.file-row'));
      band.hidden = false;
      state.marquee = true;

      function move(ev) {
        var x1 = ev.clientX - rect.left + host.scrollLeft;
        var y1 = ev.clientY - rect.top + host.scrollTop;
        band.style.left = Math.min(x0, x1) + 'px';
        band.style.top = Math.min(y0, y1) + 'px';
        band.style.width = Math.abs(x1 - x0) + 'px';
        band.style.height = Math.abs(y1 - y0) + 'px';
        var box = {
          left: Math.min(x0, x1), top: Math.min(y0, y1),
          right: Math.max(x0, x1), bottom: Math.max(y0, y1)
        };
        var next = new Set();
        rows.forEach(function (row) {
          var r = { left: row.offsetLeft, top: row.offsetTop, right: row.offsetLeft + row.offsetWidth, bottom: row.offsetTop + row.offsetHeight };
          if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) next.add(row.dataset.path);
        });
        if (additive) state.checked.forEach(function (p) { next.add(p); });
        state.checked = next;
        updateSelectionUI();
      }
      function up(ev) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        band.hidden = true;
        band.style.width = band.style.height = '0px';
        state.marquee = null;
        if (state.checked.size) state.lastAnchor = Array.from(state.checked).pop();
        updateSelectionUI();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  /* ============ 连接 / 刷新 ============ */
  async function connect() {
    if (!state.cfg || !state.cfg.repo) { openSettings(); return; }
    state.connecting = true;
    $('treeStatus').textContent = '正在连接…';
    $('tree').innerHTML = '<div class="tree-loading">正在读取仓库文件树…</div>';
    try {
      state.client = new GitHubClient(state.cfg);
      var result = await state.client.validate();
      var info = result.info;
      $('repoLabel').textContent = state.client.slug;
      $('branchPill').textContent = state.client.branch;
      $('statusRepo').textContent = state.client.slug + ' @ ' + state.client.branch + (info.private ? ' · 私有' : '');
      await refreshTree();
      var rate = await state.client.getRateLimit();
      if (rate) $('statusRate').textContent = 'API ' + rate.remaining + '/' + rate.limit;
      if (!state.cfg.token) Utils.toast('未配置 Token：可浏览公开仓库，编辑前请在设置中填写 Token。', 'warn', 5000);
      else Utils.toast('已连接 ' + state.client.slug, 'ok');
    } catch (e) {
      $('tree').innerHTML = '<div class="tree-empty">连接失败：' + Utils.escapeHtml(e.message)
        + '<br><br><button class="btn" onclick="window.__gheOpenSettings()">打开设置</button></div>';
      $('treeStatus').textContent = '连接失败';
      Utils.toast(e.message, 'err', 5000);
    } finally {
      state.connecting = false;
    }
  }

  async function refreshTree(silent) {
    if (!state.client) return;
    try {
      var res = await state.client.getTree();
      state.entries = res.entries.filter(function (e) { return e.type === 'blob' || e.type === 'tree'; });
      var validPaths = new Set(state.entries.map(function (e) { return e.path; }));
      Array.from(state.checked).forEach(function (p) { if (!validPaths.has(p)) state.checked.delete(p); });
      state.tree = res;
      state.root = buildTree(state.entries);
      if (res.truncated) Utils.toast('仓库文件较多，文件树可能不完整。', 'warn');
      renderTree();
      if (state.mode === 'manage') { updateSelectionUI(); renderFileList(); }
      if (!silent) $('treeStatus').textContent = '已同步 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      if (!silent) {
        Utils.toast('刷新失败：' + e.message, 'err');
        throw e;
      }
    }
  }

  /* ============ 编辑器 ============ */
  var CM_MODES = {
    md: 'markdown', markdown: 'markdown', js: 'javascript', mjs: 'javascript', jsx: 'javascript',
    json: 'javascript', ts: 'javascript', tsx: 'javascript', html: 'xml', htm: 'xml', xml: 'xml',
    svg: 'xml', vue: 'xml', css: 'css', scss: 'css', less: 'css', py: 'python', yml: 'yaml',
    yaml: 'yaml', sh: 'shell', bash: 'shell', c: 'clike', cpp: 'clike', h: 'clike',
    java: 'clike', cs: 'clike', go: 'clike', rs: 'clike', sql: 'sql', php: 'php'
  };
  var loadedModes = {};
  function loadCMMode(mode, cb) {
    if (!mode || loadedModes[mode]) { cb(); return; }
    loadedModes[mode] = true;
    var script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/' + mode + '/' + mode + '.min.js';
    script.onload = cb;
    script.onerror = cb;
    document.head.appendChild(script);
  }
  function editor() {
    if (!window.CodeMirror) return null;
    if (!state.editor) {
      state.editor = CodeMirror.fromTextArea($('code'), {
        lineNumbers: true, tabSize: 2, indentUnit: 2, indentWithTabs: false,
        lineWrapping: false, styleActiveLine: false, mode: 'text/plain'
      });
      state.editor.on('change', function () {
        if (state.suppressChange) return;
        var t = activeTab();
        if (!t || t.isBinary) return;
        var dirty = getValue() !== t.savedContent;
        if (dirty !== t.dirty) { t.dirty = dirty; renderTabs(); }
        $('dirtyDot').hidden = !dirty;
      });
    }
    return state.editor;
  }
  function getValue() {
    var cm = editor();
    return cm ? cm.getValue() : $('code').value;
  }
  function setValue(text, mode) {
    state.suppressChange = true;
    var cm = editor();
    if (cm) {
      cm.setValue(text || '');
      if (mode && CM_MODES[mode]) {
        loadCMMode(CM_MODES[mode], function () { cm.setOption('mode', CM_MODES[mode] || 'text/plain'); cm.refresh(); });
      } else {
        cm.setOption('mode', 'text/plain');
      }
      cm.refresh();
    } else {
      $('code').value = text || '';
    }
    state.suppressChange = false;
  }
  function updateTabState() {
    var t = activeTab();
    $('dirtyDot').hidden = !(t && t.dirty);
    renderTabs();
  }
  function renderTabs() {
    var host = $('tabs');
    host.innerHTML = '';
    state.tabs.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'tab' + (t.path === state.active ? ' active' : '');
      el.innerHTML = '<span class="badge ' + Utils.badgeFor(t.name).cls + '">' + Utils.escapeHtml(Utils.badgeFor(t.name).label) + '</span>'
        + '<span class="tab-name">' + Utils.escapeHtml(t.name) + '</span>'
        + (t.dirty ? '<span class="tab-dot" title="未保存"></span>' : '')
        + '<span class="tab-x" title="关闭"><svg class="ico"><use href="#i-close"></use></svg></span>';
      el.addEventListener('click', function () { activateTab(t.path); });
      el.querySelector('.tab-x').addEventListener('click', function (ev) { ev.stopPropagation(); closeTab(t.path); });
      host.appendChild(el);
    });
  }

  async function openFile(path) {
    if (!state.client) { Utils.toast('请先配置并连接仓库', 'warn'); return; }
    var existing = state.tabs.find(function (t) { return t.path === path; });
    if (existing) { activateTab(path); return; }
    try {
      $('treeStatus').textContent = '正在读取 ' + baseOf(path) + '…';
      var f = await state.client.getFile(path);
      var tab = {
        path: f.path, name: f.name, content: f.content, savedContent: f.content,
        isBinary: f.isBinary || f.tooLarge, tooLarge: f.tooLarge,
        size: f.size, downloadUrl: f.downloadUrl, dirty: false
      };
      state.tabs.push(tab);
      activateTab(f.path);
      $('treeStatus').textContent = '已打开 ' + f.path;
    } catch (e) {
      Utils.toast('打开文件失败：' + e.message, 'err');
    }
  }

  function activateTab(path) {
    var t = state.tabs.find(function (x) { return x.path === path; });
    if (!t) return;
    state.active = path;
    state.preview = false;
    $('preview').hidden = true;
    $('preview').innerHTML = '';
    $('btnTogglePreview').classList.remove('primary');
    $('emptyState').hidden = true;
    $('editorWrap').hidden = false;
    $('editorFileName').textContent = t.path;
    var badge = Utils.badgeFor(t.name);
    $('fileBadge').className = 'badge ' + badge.cls;
    $('fileBadge').textContent = badge.label;
    var editable = !t.isBinary && !t.tooLarge;
    $('codeHost').hidden = !editable;
    $('binaryState').hidden = editable;
    $('btnTogglePreview').hidden = !editable;
    $('btnSaveFile').hidden = !editable;
    $('binaryInfo').textContent = t.tooLarge
      ? '文件超过 1 MB，GitHub API 无法直接读取内容，可下载后在本地编辑。'
      : '无法在文本编辑器中修改，可下载后查看或替换。';
    if (editable) {
      setValue(t.content || '', t.name.split('.').pop().toLowerCase());
      if (/\.md$/i.test(t.name)) $('btnTogglePreview').click();
    }
    $('dirtyDot').hidden = !t.dirty;
    renderTabs(); renderBreadcrumb();
  }

  function closeTab(path) {
    var t = state.tabs.find(function (x) { return x.path === path; });
    if (!t) return;
    if (t.dirty) Utils.toast('已关闭「' + t.name + '」，未保存的修改已丢弃', 'warn');
    doClose(path);
  }
  function doClose(path) {
    var idx = state.tabs.findIndex(function (x) { return x.path === path; });
    if (idx < 0) return;
    state.tabs.splice(idx, 1);
    if (state.active === path) {
      var next = state.tabs[Math.min(idx, state.tabs.length - 1)];
      if (next) activateTab(next.path);
      else {
        state.active = null;
        $('editorWrap').hidden = true;
        $('emptyState').hidden = false;
        renderTabs(); renderBreadcrumb();
      }
    } else renderTabs();
  }

  function togglePreview() {
    var t = activeTab();
    if (!t || t.isBinary) return;
    state.preview = !state.preview;
    $('btnTogglePreview').classList.toggle('primary', state.preview);
    if (state.preview) {
      var text = getValue();
      if (/\.md$/i.test(t.name)) $('preview').innerHTML = Utils.markdown(text);
      else $('preview').innerHTML = '<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px">'
        + Utils.escapeHtml(text) + '</pre>';
      $('preview').hidden = false;
    } else $('preview').hidden = true;
    if (state.editor) setTimeout(function () { state.editor.refresh(); }, 0);
  }

  /* ============ 提交操作 ============ */
  async function runCommit(changes, fallbackMsg) {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return false; }
    var message = commitMessage(fallbackMsg);
    try {
      setBusy(true, '正在提交…');
      await state.client.commit(changes, message);
      await refreshTree(true);
      clearCommitInput();
      $('statusRate').textContent = '刚刚已提交';
      return true;
    } catch (e) {
      Utils.toast('提交失败：' + e.message, 'err', 5000);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveActive() {
    var t = activeTab();
    if (!t || t.isBinary) return;
    var content = getValue();
    var previous = t.savedContent;
    var ok = await runCommit([{ op: 'upsert', path: t.path, content: content }], '更新 ' + t.path);
    if (ok) {
      t.savedContent = content;
      t.dirty = false;
      updateTabState();
      Utils.toast('已提交 ' + t.path, 'ok', 6000, {
        label: '撤销',
        onClick: async function () {
          var restored = await runCommit([{ op: 'upsert', path: t.path, content: previous }], '撤销修改 ' + t.path);
          if (restored) {
            t.savedContent = previous;
            t.dirty = false;
            if (activeTab() === t) setValue(previous, t.name.split('.').pop().toLowerCase());
            updateTabState();
            Utils.toast('已撤销修改', 'ok');
          }
        }
      });
    }
  }

  function doNew(type) {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return; }
    promptInput(type === 'file' ? '新建文件' : '新建文件夹',
      type === 'file' ? '文件名（可包含 / 以创建多级目录）' : '文件夹名称（可包含 /）',
      type === 'file' ? '例如：docs/guide.md' : '例如：docs/images', '', async function (name) {
        if (!name) return false;
        var path = joinPath(state.currentFolder, name);
        var exists = !!findEntry(path);
        if (exists) { Utils.toast('该路径已存在：' + path, 'err'); return false; }
        if (type === 'folder') path = joinPath(path, '.gitkeep');
        var content = type === 'file' && /\.md$/i.test(path) ? '# ' + baseOf(path) + '\n' : '';
        var ok = await runCommit([{ op: 'upsert', path: path, content: content }],
          (type === 'file' ? '新建文件 ' : '新建文件夹 ') + path);
        if (ok) {
          state.currentFolder = parentOf(path);
          if (type === 'file') {
            state.expanded.add(state.currentFolder);
            saveJSON(K_EXP, Array.from(state.expanded));
            openFile(path);
          } else {
            state.expanded.add(parentOf(path));
            renderTree(); renderBreadcrumb();
          }
          Utils.toast('已创建 ' + path, 'ok');
        }
        return ok;
      });
  }

  function doRename(path, type) {
    if (!state.client) return;
    promptInput('重命名', '新的名称或路径', '支持移动到其他目录，例如 docs/new-name.md', baseOf(path), async function (name) {
      if (!name || name === baseOf(path)) return false;
      var parent = type === 'tree' ? parentOf(path) : parentOf(path);
      var newPath = joinPath(parent, name);
      if (newPath === path) return false;
      if (findEntry(newPath)) { Utils.toast('目标路径已存在：' + newPath, 'err'); return false; }
      var files = type === 'tree' ? descendants(path) : [findEntry(path)].filter(Boolean);
      if (!files.length) { Utils.toast('没有可重命名的文件', 'warn'); return false; }
      var changes = [];
      files.forEach(function (f) {
        var target = type === 'tree' ? newPath + f.path.slice(path.length) : newPath;
        changes.push({ op: 'delete', path: f.path });
        changes.push({ op: 'upsert', path: target, sha: f.sha });
      });
      var ok = await runCommit(changes, '重命名 ' + path + ' → ' + newPath);
      if (!ok) return false;
      state.tabs.slice().forEach(function (t) {
        var target = type === 'tree' ? newPath + t.path.slice(path.length) : newPath;
        if (t.path === path || t.path.indexOf(path + '/') === 0) {
          var idx = state.tabs.indexOf(t);
          state.tabs.splice(idx, 1);
          t.path = target; t.name = baseOf(target);
          state.tabs.push(t);
          if (state.active === path) state.active = target;
        }
      });
      if (state.currentFolder === path || state.currentFolder.indexOf(path + '/') === 0) {
        state.currentFolder = newPath + state.currentFolder.slice(path.length);
      }
      state.expanded.delete(path); state.expanded.add(newPath);
      saveJSON(K_EXP, Array.from(state.expanded));
      renderTree(); renderBreadcrumb(); renderTabs();
      if (state.active === newPath) activateTab(newPath);
      Utils.toast('已重命名为 ' + newPath, 'ok');
      return true;
    });
  }

  function doDelete(path, type) {
    if (!state.client) return;
    var files = type === 'tree' ? descendants(path) : [findEntry(path)].filter(Boolean);
    if (!files.length) { Utils.toast('没有可删除的文件', 'warn'); return; }
    var snapshot = files.map(function (f) { return { path: f.path, sha: f.sha }; });
    var changes = files.map(function (f) { return { op: 'delete', path: f.path }; });
    runCommit(changes, '删除 ' + path).then(function (ok) {
      if (!ok) return;
      state.tabs.slice().forEach(function (t) {
        if (t.path === path || t.path.indexOf(path + '/') === 0) doClose(t.path);
      });
      state.selected = '';
      renderTree();
      Utils.toast('已删除 ' + files.length + ' 个文件', 'ok', 6000, {
        label: '撤销',
        onClick: async function () {
          var restored = await runCommit(snapshot.map(function (s) {
            return { op: 'upsert', path: s.path, sha: s.sha };
          }), '撤销删除 ' + path);
          if (restored) { renderTree(); Utils.toast('已撤销删除', 'ok'); }
        }
      });
    });
  }

  async function downloadFile(path) {
    if (!state.client) return;
    try {
      Utils.toast('正在下载 ' + baseOf(path) + '…', 'info', 1500);
      var blob = await state.client.downloadBlob(path);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = baseOf(path);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
    } catch (e) { Utils.toast('下载失败：' + e.message, 'err'); }
  }

  async function prepareUploads(files, folder, onProgress) {
    var results = [];
    var progress = files.map(function () { return 0; });
    function emit(detail, title) {
      var avg = progress.reduce(function (a, b) { return a + b; }, 0) / files.length;
      onProgress(avg * 100, detail, title);
    }
    emit('准备中…', '正在上传 ' + files.length + ' 个文件');
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var path = joinPath(folder, f.path);
      var size = f.file.size || 0;
      if (size > MAX_UPLOAD_BYTES) {
        throw new Error(f.path + ' 超过 GitHub 单文件 100 MB 限制');
      }
      progress[i] = 0.02;
      emit('读取 ' + f.path + '…');
      var base64;
      try {
        base64 = await readFileBase64(f.file, function (frac) {
          progress[i] = 0.02 + frac * 0.38;
          emit('读取 ' + f.path + '（' + Utils.formatBytes(Math.round(size * frac)) + ' / ' + Utils.formatBytes(size) + '）');
        });
      } catch (e) {
        throw new Error('读取 ' + f.path + ' 失败：' + e.message);
      }
      progress[i] = 0.45;
      emit('上传文件内容 ' + f.path + '…');
      var sha;
      try {
        sha = await state.client.createBlob(base64);
      } catch (e) {
        throw new Error('上传 ' + f.path + ' 失败：' + e.message);
      }
      progress[i] = 0.95;
      emit('已上传 ' + f.path);
      results.push({ path: path, sha: sha, name: f.path, size: size });
    }
    return results;
  }

  async function uploadFiles(files) {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return; }
    if (!files.length) return;
    var folder = state.currentFolder;
    var previous = files.map(function (f) {
      var target = joinPath(folder, f.path);
      var entry = findEntry(target);
      return entry ? { path: target, sha: entry.sha } : null;
    }).filter(Boolean);
    showUploadProgress('正在上传 ' + files.length + ' 个文件', '准备中…');
    try {
      var uploaded = await prepareUploads(files, folder, updateUploadProgress);
      updateUploadProgress(98, '正在创建提交…');
      var changes = uploaded.map(function (u) { return { op: 'upsert', path: u.path, sha: u.sha }; });
      var ok = await runCommit(changes, '上传 ' + files.length + ' 个文件到 ' + (folder || '根目录'));
      if (!ok) { hideUploadProgress(0); return; }
      updateUploadProgress(100, '上传完成');
      hideUploadProgress(900);
      renderTree();
      Utils.toast('已上传 ' + files.length + ' 个文件', 'ok', 6000, previous.length ? {
        label: '撤销覆盖',
        onClick: async function () {
          var restored = await runCommit(previous.map(function (p) {
            return { op: 'upsert', path: p.path, sha: p.sha };
          }), '撤销覆盖上传');
          if (restored) { renderTree(); Utils.toast('已撤销覆盖', 'ok'); }
        }
      } : undefined);
      var first = files[0];
      if (first && !Utils.isBinaryName(first.path)) openFile(joinPath(folder, first.path));
    } catch (e) {
      hideUploadProgress(0);
      Utils.toast('上传失败：' + e.message, 'err', 8000);
    }
  }

  /* ============ 管理模式：待提交更改 ============ */
  var KIND_TAG = {
    create: '新建', folder: '新建', edit: '修改', upload: '上传',
    delete: '删除', rename: '重命名', move: '移动', copy: '复制'
  };
  function stagedLabel(s) {
    switch (s.kind) {
      case 'create': return '新建文本 ' + baseOf(s.path);
      case 'folder': return '新建文件夹 ' + s.path;
      case 'edit': return '修改 ' + baseOf(s.path);
      case 'upload': return '上传 ' + baseOf(s.path);
      case 'delete': return '删除 ' + baseOf(s.path) + (s.recursive ? '（含子文件）' : '');
      case 'rename': return '重命名 ' + baseOf(s.from) + ' → ' + baseOf(s.to);
      case 'move': return '移动 ' + baseOf(s.from) + ' → ' + s.to;
      case 'copy': return '复制 ' + baseOf(s.from) + ' → ' + s.to;
      default: return s.kind;
    }
  }
  function dropStagedFor(path) {
    if (!path) return;
    state.staged = state.staged.filter(function (s) {
      var own = [s.path, s.from, s.to].filter(Boolean);
      for (var i = 0; i < own.length; i++) {
        if (own[i] === path || own[i].indexOf(path + '/') === 0 || path.indexOf(own[i] + '/') === 0) return false;
      }
      return true;
    });
  }
  function stageChange(op) {
    op.id = 'st' + Date.now() + Math.random().toString(36).slice(2, 6);
    dropStagedFor(op.path);
    if (op.from) dropStagedFor(op.from);
    if (op.to) dropStagedFor(op.to);
    state.staged.push(op);
    renderStaged();
    return op.id;
  }
  function renderStaged() {
    var host = $('stagedList');
    if (!host) return;
    host.innerHTML = '';
    $('stagedCount').textContent = state.staged.length;
    if (!state.staged.length) {
      host.innerHTML = '<div class="staged-empty">还没有待提交的更改。<br>在右侧文件列表中选择文件后删除/重命名，或点击上方「新建文本」「上传」。<br>双击右侧文本文件可直接编辑内容。</div>';
      if (state.mode === 'manage') renderFileList();
      return;
    }
    state.staged.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'staged-item kind-' + s.kind;
      item.innerHTML = '<span class="staged-kind">' + (KIND_TAG[s.kind] || '更改') + '</span>'
        + '<div class="staged-info"><div class="staged-label">' + Utils.escapeHtml(stagedLabel(s)) + '</div>'
        + '<div class="staged-path">' + Utils.escapeHtml(s.from ? s.from + ' → ' + s.to : s.path) + '</div></div>';
      var actions = document.createElement('div');
      actions.className = 'file-actions';
      if (s.kind === 'create' || s.kind === 'edit') {
        var editBtn = document.createElement('button');
        editBtn.className = 'btn small';
        editBtn.innerHTML = '<svg class="ico"><use href="#i-edit"></use></svg><span>编辑内容</span>';
        editBtn.addEventListener('click', function () { openStageEditor(s.id); });
        actions.appendChild(editBtn);
      }
      var rm = document.createElement('button');
      rm.className = 'btn small icon-only';
      rm.title = '从待提交中移除';
      rm.innerHTML = '<svg class="ico"><use href="#i-close"></use></svg>';
      rm.addEventListener('click', function () {
        state.staged = state.staged.filter(function (x) { return x.id !== s.id; });
        if (state.stageEditing === s.id) { state.stageEditing = null; $('stageEditor').hidden = true; }
        renderStaged();
      });
      actions.appendChild(rm);
      item.appendChild(actions);
      host.appendChild(item);
    });
    if (state.mode === 'manage') renderFileList();
  }
  function openStageEditor(id) {
    var s = state.staged.find(function (x) { return x.id === id; });
    if (!s) return;
    state.stageEditing = id;
    $('stageEditor').hidden = false;
    $('stageEditorName').textContent = s.path;
    $('stageCode').value = s.content || '';
    $('stageCode').focus();
  }
  function finishStageEdit() {
    if (!state.stageEditing) return;
    var s = state.staged.find(function (x) { return x.id === state.stageEditing; });
    if (s) s.content = $('stageCode').value;
    state.stageEditing = null;
    $('stageEditor').hidden = true;
    renderStaged();
    Utils.toast('修改已暂存，点击「一键提交」生效', 'ok');
  }
  function stageNewText() {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return; }
    promptInput('新建文本文件', '文件路径', '例如：docs/readme.md', '', function (name) {
      var path = joinPath(state.currentFolder, name);
      if (findEntry(path) || state.staged.some(function (s) { return s.path === path; })) {
        Utils.toast('该路径已存在：' + path, 'err'); return false;
      }
      var id = stageChange({ kind: 'create', path: path, content: /\.md$/i.test(path) ? '# ' + baseOf(path) + '\n' : '' });
      openStageEditor(id);
      return true;
    });
  }
  function stageNewFolder() {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return; }
    promptInput('新建文件夹', '文件夹路径', '例如：docs/images', '', function (name) {
      var path = joinPath(state.currentFolder, name);
      if (findEntry(path) || state.staged.some(function (s) { return s.path === path; })) {
        Utils.toast('该路径已存在：' + path, 'err'); return false;
      }
      stageChange({ kind: 'folder', path: path });
      Utils.toast('文件夹已暂存', 'ok');
      return true;
    });
  }
  async function stageUpload(files) {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return; }
    if (!files || !files.length) return;
    var folder = state.currentFolder;
    showUploadProgress('正在上传 ' + files.length + ' 个文件', '准备中…');
    try {
      var uploaded = await prepareUploads(files, folder, updateUploadProgress);
      uploaded.forEach(function (u) {
        stageChange({ kind: 'upload', path: u.path, sha: u.sha, name: u.name, size: u.size });
      });
      updateUploadProgress(100, '已暂存，点击「一键提交」生效');
      hideUploadProgress(900);
      Utils.toast('已上传 ' + files.length + ' 个文件，点击「一键提交」生效', 'ok');
    } catch (e) {
      hideUploadProgress(0);
      Utils.toast('上传失败：' + e.message, 'err', 8000);
    }
  }
  function stageRename(kind) {
    if (state.checked.size !== 1) { Utils.toast('请先选择且仅选择一个文件或文件夹', 'warn'); return; }
    var from = Array.from(state.checked)[0];
    var entry = findEntry(from);
    if (!entry && !state.staged.some(function (s) { return s.path === from; })) {
      Utils.toast('所选路径不存在', 'err'); return;
    }
    promptInput(kind === 'rename' ? '重命名' : (kind === 'move' ? '移动' : '复制'),
      '新的名称或路径', '支持相对路径，例如 docs/new-name.md', baseOf(from), function (name) {
        var to = joinPath(parentOf(from), name);
        if (to === from) return false;
        if (findEntry(to)) { Utils.toast('目标路径已存在：' + to, 'err'); return false; }
        // 对尚未提交的新建项，直接改其暂存路径
        var pending = state.staged.find(function (s) { return s.path === from; });
        if (pending && kind !== 'copy') {
          dropStagedFor(to);
          pending.path = to;
          if (pending.content !== undefined) pending.content = pending.content;
          renderStaged(); renderTree();
          Utils.toast('已更新暂存路径', 'ok');
          return true;
        }
        stageChange({ kind: kind, from: from, to: to });
        return true;
      });
  }
  function stageMoveTo(folder, paths) {
    if (!folder || !paths || !paths.length) return;
    var moved = 0, skipped = 0;
    paths.forEach(function (from) {
      if (!from || from === folder || from.indexOf(folder + '/') === 0) { skipped++; return; }
      var to = joinPath(folder, baseOf(from));
      if (to === from || findEntry(to) || state.staged.some(function (s) {
        return s.to === to || s.path === to;
      })) { skipped++; return; }
      var pending = state.staged.find(function (s) {
        return s.path === from && (s.kind === 'create' || s.kind === 'upload' || s.kind === 'folder');
      });
      if (pending) pending.path = to;
      else stageChange({ kind: 'move', from: from, to: to });
      moved++;
    });
    if (moved) Utils.toast('已暂存移动 ' + moved + ' 项到 ' + folder, 'ok');
    if (skipped) Utils.toast('有 ' + skipped + ' 项无法移动（目标已存在或为自身子目录）', 'warn');
    renderStaged();
  }
  function stageDelete() {
    if (!state.checked.size) { Utils.toast('请先勾选要删除的文件或文件夹', 'warn'); return; }
    var paths = Array.from(state.checked), created = 0, missing = 0, staged = 0;
    paths.forEach(function (path) {
      // 尚未提交的新建项：直接撤销该暂存项，不生成删除操作（GitHub 删除不存在的文件会报错）
      var pending = state.staged.find(function (s) {
        return s.path === path && (s.kind === 'create' || s.kind === 'upload' || s.kind === 'folder');
      });
      if (pending) {
        state.staged = state.staged.filter(function (s) { return s.id !== pending.id; });
        created++;
        return;
      }
      var e = findEntry(path);
      var hasFiles = e && (e.type === 'tree' ? descendants(path).length > 0 : true);
      if (!hasFiles) { missing++; return; }
      stageChange({ kind: 'delete', path: path, recursive: e && e.type === 'tree' });
      staged++;
    });
    renderStaged();
    if (staged) Utils.toast('已暂存删除 ' + staged + ' 项', 'ok');
    if (created) Utils.toast('已撤销 ' + created + ' 项尚未提交的创建', 'ok');
    if (missing) Utils.toast(missing + ' 项不存在或为空，已跳过', 'warn');
  }
  async function stageEditExisting(path) {
    if (!state.client) return;
    if (Utils.isBinaryName(path)) { Utils.toast('二进制文件无法在线编辑', 'warn'); return; }
    try {
      var f = await state.client.getFile(path);
      if (f.isBinary || f.tooLarge) { Utils.toast('该文件无法在线编辑', 'warn'); return; }
      var id = stageChange({ kind: 'edit', path: path, content: f.content || '', sha: f.sha });
      openStageEditor(id);
    } catch (e) { Utils.toast('读取文件失败：' + e.message, 'err'); }
  }
  function selectAllInFolder() {
    var paths = listNodes().map(function (n) { return n.path; });
    if (!paths.length) { Utils.toast('当前目录没有文件', 'warn'); return; }
    var all = paths.every(function (p) { return state.checked.has(p); });
    paths.forEach(function (p) { if (all) state.checked.delete(p); else state.checked.add(p); });
    updateSelectionUI();
  }
  function stagedToChanges() {
    var changes = [], skipped = [];
    var known = new Set(state.entries.map(function (e) { return e.path; }));
    var treePaths = new Set(state.entries.filter(function (e) { return e.type === 'tree'; }).map(function (e) { return e.path; }));
    state.staged.forEach(function (s) {
      switch (s.kind) {
        case 'create':
        case 'edit':
          changes.push({ op: 'upsert', path: s.path, content: s.content || '' });
          break;
        case 'folder':
          changes.push({ op: 'upsert', path: joinPath(s.path, '.gitkeep'), content: '' });
          break;
        case 'upload':
          changes.push({ op: 'upsert', path: s.path, sha: s.sha, base64: s.base64 });
          break;
        case 'delete': {
          if (treePaths.has(s.path)) {
            var paths = descendants(s.path).map(function (f) { return f.path; });
            if (!paths.length) skipped.push(s.path);
            paths.forEach(function (p) { changes.push({ op: 'delete', path: p }); });
          } else if (known.has(s.path)) {
            changes.push({ op: 'delete', path: s.path });
          } else skipped.push(s.path);
          break;
        }
        case 'rename':
        case 'move':
        case 'copy': {
          var src = findEntry(s.from);
          var files = src && src.type === 'tree'
            ? descendants(s.from) : (src ? [src] : []);
          if (!files.length && s.fromSha) files = [{ path: s.from, sha: s.fromSha }];
          if (!files.length) { skipped.push(s.from); break; }
          files.forEach(function (f) {
            var target = s.to + f.path.slice(s.from.length);
            if (s.kind !== 'copy') changes.push({ op: 'delete', path: f.path });
            changes.push({ op: 'upsert', path: target, sha: f.sha });
          });
          break;
        }
      }
    });
    // 同一路径保留最后一个操作
    var map = new Map();
    changes.forEach(function (c) { map.set(c.path, c); });
    state.lastSkipped = skipped;
    return Array.from(map.values());
  }
  async function commitAll() {
    if (!state.client) { Utils.toast('请先连接仓库', 'warn'); return; }
    if (!state.staged.length) { Utils.toast('没有待提交的更改', 'warn'); return; }
    // 提交前同步最新树，避免删除已不存在的文件导致 GitHub 返回错误
    try { await refreshTree(true); } catch (e) {}
    var changes = stagedToChanges();
    if (!changes.length) { Utils.toast('没有有效的更改，可能文件已在远端被删除', 'warn'); return; }
    if (state.lastSkipped && state.lastSkipped.length) {
      Utils.toast('已跳过 ' + state.lastSkipped.length + ' 项不存在的文件', 'warn');
    }
    state.lastSnapshot = state.entries.map(function (e) { return { path: e.path, sha: e.sha }; });
    var message = commitMessage('批量更新 ' + state.staged.length + ' 项');
    try {
      setBusy(true, '正在提交 ' + changes.length + ' 项更改…');
      await state.client.commit(changes, message);
      await refreshTree(true);
      clearCommitInput();
      state.staged = [];
      state.checked.clear();
      state.stageEditing = null;
      $('stageEditor').hidden = true;
      renderStaged(); renderTree(); updateSelectionUI();
      Utils.toast('已一键提交 ' + changes.length + ' 项更改', 'ok', 8000, {
        label: '撤销', onClick: undoLastCommit
      });
    } catch (e) {
      Utils.toast('提交失败：' + e.message + (e.status ? '（HTTP ' + e.status + '）' : ''), 'err', 8000);
    } finally {
      setBusy(false);
    }
  }
  async function undoLastCommit() {
    if (!state.lastSnapshot || !state.client) return;
    var snap = state.lastSnapshot;
    state.lastSnapshot = null;
    var snapMap = new Map(snap.map(function (e) { return [e.path, e]; }));
    var curMap = new Map(state.entries.map(function (e) { return [e.path, e]; }));
    var changes = [];
    state.entries.forEach(function (e) {
      if (!snapMap.has(e.path)) changes.push({ op: 'delete', path: e.path });
    });
    snap.forEach(function (e) {
      var c = curMap.get(e.path);
      if (!c || c.sha !== e.sha) changes.push({ op: 'upsert', path: e.path, sha: e.sha });
    });
    if (!changes.length) { Utils.toast('没有可撤销的更改', 'warn'); return; }
    try {
      setBusy(true, '正在撤销…');
      await state.client.commit(changes, '撤销上次批量提交');
      await refreshTree(true);
      renderTree();
      Utils.toast('已撤销上次批量提交', 'ok');
    } catch (e) { Utils.toast('撤销失败：' + e.message, 'err'); }
    finally { setBusy(false); }
  }
  function showManagerContextMenu(x, y) {
    var menu = $('contextMenu');
    menu.innerHTML = '';
    function item(label, icon, cls, fn) {
      var b = document.createElement('button');
      b.className = 'context-item' + (cls ? ' ' + cls : '');
      b.innerHTML = '<svg class="ico"><use href="#' + icon + '"></use></svg><span>' + label + '</span>';
      b.addEventListener('click', function () { hideContextMenu(); fn(); });
      menu.appendChild(b);
    }
    item('新建文本', 'i-plus', '', stageNewText);
    item('新建文件夹', 'i-folder-plus', '', stageNewFolder);
    item('上传本地文件', 'i-upload', '', function () { $('mgrFileInput').click(); });
    menu.appendChild(document.createElement('div')).className = 'context-sep';
    item('重命名', 'i-edit', '', function () { stageRename('rename'); });
    item('复制到…', 'i-copy', '', function () { stageRename('copy'); });
    item('移动到…', 'i-move', '', function () { stageRename('move'); });
    menu.appendChild(document.createElement('div')).className = 'context-sep';
    item('删除所选', 'i-trash', 'danger', stageDelete);
    item('全选本目录', 'i-select-all', '', selectAllInFolder);
    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  function setMode(mode) {
    if (state.mode === mode) return;
    if (state.stageEditing) finishStageEdit();
    state.mode = mode;
    document.body.classList.toggle('manage-mode', mode === 'manage');
    $('managePanel').hidden = mode !== 'manage';
    $('editorArea').hidden = mode === 'manage';
    $('tabs').hidden = mode === 'manage';
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (mode === 'manage') {
      renderStaged();
      renderFileList();
      updateSelectionUI();
    } else {
      state.checked.clear();
    }
    renderTree();
    if (state.editor) setTimeout(function () { state.editor.refresh(); }, 0);
  }

  /* ============ 右键菜单 ============ */
  function showContextMenu(x, y, path, type) {
    var menu = $('contextMenu');
    menu.innerHTML = '';
    function item(label, icon, cls, fn) {
      var b = document.createElement('button');
      b.className = 'context-item' + (cls ? ' ' + cls : '');
      b.innerHTML = '<svg class="ico"><use href="#' + icon + '"></use></svg><span>' + label + '</span>';
      b.addEventListener('click', function () { hideContextMenu(); fn(); });
      menu.appendChild(b);
    }
    if (type === 'blob') {
      item('打开 / 编辑', 'i-edit', '', function () { openFile(path); });
      item('下载', 'i-download', '', function () { downloadFile(path); });
      menu.appendChild(document.createElement('div')).className = 'context-sep';
    } else {
      item('在此新建文件', 'i-plus', '', function () { state.currentFolder = path; renderBreadcrumb(); doNew('file'); });
      item('在此新建文件夹', 'i-folder-plus', '', function () { state.currentFolder = path; renderBreadcrumb(); doNew('folder'); });
      menu.appendChild(document.createElement('div')).className = 'context-sep';
    }
    item('复制路径', 'i-copy', '', function () {
      copyToClipboard(path);
    });
    item('重命名 / 移动', 'i-edit', '', function () { doRename(path, type); });
    menu.appendChild(document.createElement('div')).className = 'context-sep';
    item('删除', 'i-trash', 'danger', function () { doDelete(path, type); });

    menu.hidden = false;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  function hideContextMenu() { $('contextMenu').hidden = true; }
  function copyToClipboard(text) {
    Utils.copyText(text).then(function () { Utils.toast('已复制路径：' + text, 'ok'); })
      .catch(function () { Utils.toast('复制失败', 'err'); });
  }

  /* ============ 弹窗 ============ */
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  function promptInput(title, label, help, value, onOk) {
    $('promptTitle').textContent = title;
    $('promptLabel').textContent = label;
    $('promptHelp').textContent = help || '';
    $('promptInput').value = value || '';
    state.pending.prompt = onOk;
    openModal('promptModal');
    setTimeout(function () { $('promptInput').focus(); $('promptInput').select(); }, 30);
  }
  function submitPrompt() {
    var fn = state.pending.prompt;
    var value = $('promptInput').value.trim().replace(/^\/+|\/+$/g, '');
    if (!value) { Utils.toast('请输入内容', 'warn'); return; }
    Promise.resolve(fn(value)).then(function (ok) {
      if (ok !== false) closeModal('promptModal');
    }).catch(function (e) { Utils.toast(e.message, 'err'); });
  }

  function openSettings() {
    var c = state.cfg || defaultConfig();
    $('cfgRepo').value = c.repo || DEFAULT_REPO;
    $('cfgToken').value = c.token || '';
    $('cfgBranch').value = c.branch || '';
    $('cfgApi').value = c.apiBase === 'https://api.github.com' ? '' : (c.apiBase || '');
    $('cfgProxy').value = c.proxy || '';
    $('cfgRemember').checked = c.remember !== false;
    $('cfgToken').type = 'password';
    $('btnToggleToken').textContent = '显示';
    $('testResult').textContent = '';
    $('testResult').className = 'test-result';
    openModal('settingsModal');
    setTimeout(function () { $('cfgRepo').focus(); }, 30);
  }
  function readSettings() {
    return {
      repo: $('cfgRepo').value.trim(),
      token: $('cfgToken').value.trim(),
      branch: $('cfgBranch').value.trim().replace(/^refs\/heads\//, ''),
      apiBase: $('cfgApi').value.trim() || 'https://api.github.com',
      proxy: $('cfgProxy').value.trim(),
      remember: $('cfgRemember').checked
    };
  }
  function saveSettings() {
    try {
      var cfg = readSettings();
      parseRepo(cfg.repo); // 校验地址格式
      if (cfg.proxy && !(window.electronAPI && window.electronAPI.gheFetch)) {
        Utils.toast('代理仅在安装版 / 便携版中生效，浏览器预览模式会忽略代理设置。', 'warn', 5000);
      }
      state.cfg = cfg;
      persistConfig(cfg);
      closeModal('settingsModal');
      state.currentFolder = ''; state.selected = '';
      state.search = ''; $('searchInput').value = '';
      state.tabs = []; state.active = null;
      state.checked.clear(); state.staged = []; state.stageEditing = null;
      $('stageEditor').hidden = true; renderStaged();
      $('editorWrap').hidden = true; $('emptyState').hidden = false;
      renderTabs(); renderBreadcrumb();
      connect();
    } catch (e) { Utils.toast(e.message, 'err'); }
  }
  async function testConnection() {
    var result = $('testResult');
    result.className = 'test-result';
    result.textContent = '正在连接…';
    try {
      var cfg = readSettings();
      var client = new GitHubClient(cfg);
      var res = await client.validate();
      result.className = 'test-result ok';
      result.textContent = '✓ 连接成功 · 默认分支 ' + res.info.default_branch;
    } catch (e) {
      result.className = 'test-result err';
      result.textContent = '✗ ' + e.message;
    }
  }

  /* ============ 拖拽上传 ============ */
  function collectEntry(entry, prefix) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (file) { resolve([{ file: file, path: prefix + entry.name }]); }, function () { resolve([]); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var batches = [];
        function readBatch() {
          reader.readEntries(function (items) {
            if (items.length) { batches.push(items); readBatch(); return; }
            Promise.all(batches.map(function (list) {
              return Promise.all(Array.from(list).map(function (e) {
                return collectEntry(e, prefix + entry.name + '/');
              }));
            })).then(function (nested) {
              resolve([].concat.apply([], [].concat.apply([], nested)));
            });
          }, function () { resolve([]); });
        }
        readBatch();
      } else resolve([]);
    });
  }
  async function filesFromDrop(dt) {
    if (!dt || !dt.items) return Array.from(dt.files || []).map(function (f) { return { file: f, path: f.name }; });
    var entries = [];
    for (var i = 0; i < dt.items.length; i++) {
      var item = dt.items[i];
      if (item.kind === 'file' && item.webkitGetAsEntry) {
        var e = item.webkitGetAsEntry();
        if (e) entries.push(await collectEntry(e, ''));
      }
    }
    var flat = [].concat.apply([], entries);
    if (!flat.length) return Array.from(dt.files || []).map(function (f) { return { file: f, path: f.name }; });
    return flat;
  }

  /* ============ 事件绑定 ============ */
  function bindEvents() {
    $('btnSettings').addEventListener('click', openSettings);
    $('btnSetupNow').addEventListener('click', openSettings);
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnTest').addEventListener('click', testConnection);
    $('btnToggleToken').addEventListener('click', function () {
      var show = $('cfgToken').type === 'password';
      $('cfgToken').type = show ? 'text' : 'password';
      $('btnToggleToken').textContent = show ? '隐藏' : '显示';
    });
    $('btnRefresh').addEventListener('click', function () { refreshTree().then(function () { Utils.toast('文件树已刷新', 'ok'); }).catch(function () {}); });
    $('btnCollapseAll').addEventListener('click', function () { state.expanded.clear(); saveJSON(K_EXP, []); renderTree(); });
    $('btnNewFile').addEventListener('click', function () {
      if (state.mode === 'manage') stageNewText(); else doNew('file');
    });
    $('btnNewFolder').addEventListener('click', function () {
      if (state.mode === 'manage') stageNewFolder(); else doNew('folder');
    });
    $('btnUpload').addEventListener('click', function () {
      if (state.mode === 'manage') $('mgrFileInput').click(); else $('fileInput').click();
    });
    $('fileInput').addEventListener('change', function (ev) {
      uploadFiles(Array.from(ev.target.files).map(function (f) { return { file: f, path: f.name }; }));
      ev.target.value = '';
    });
    $('btnSaveFile').addEventListener('click', saveActive);
    $('btnTogglePreview').addEventListener('click', togglePreview);
    $('btnCloseTab').addEventListener('click', function () { if (state.active) closeTab(state.active); });
    $('btnDownloadFile').addEventListener('click', function () { if (state.active) downloadFile(state.active); });
    $('btnDownloadBinary').addEventListener('click', function () { if (state.active) downloadFile(state.active); });
    $('promptInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPrompt(); });
    $('code').addEventListener('input', function () {
      if (state.suppressChange || state.editor) return;
      var t = activeTab();
      if (!t || t.isBinary) return;
      var dirty = $('code').value !== t.savedContent;
      if (dirty !== t.dirty) { t.dirty = dirty; renderTabs(); }
      $('dirtyDot').hidden = !dirty;
    });
    $('btnPromptOk').addEventListener('click', submitPrompt);
    document.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeModal(el.dataset.close); });
    });
    document.querySelectorAll('.overlay').forEach(function (ov) {
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(ov.id); });
    });

    $('searchInput').addEventListener('input', Utils.debounce(function () {
      state.search = $('searchInput').value;
      renderTree();
    }, 120));

    $('btnTheme').addEventListener('click', function () {
      var dark = document.body.classList.toggle('dark');
      saveJSON(K_THEME, dark ? 'dark' : 'light');
      updateThemeIcon();
      if (state.editor) state.editor.refresh();
    });

    document.addEventListener('click', function () { hideContextMenu(); });

    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        hideContextMenu();
        document.querySelectorAll('.overlay').forEach(function (ov) { closeModal(ov.id); });
        return;
      }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); }
      if (mod && e.key.toLowerCase() === 'w' && state.active) { e.preventDefault(); closeTab(state.active); }
      if (mod && e.key.toLowerCase() === 'a' && state.mode === 'manage') {
        e.preventDefault();
        var target = e.target;
        if (target && target.id === 'stageCode') return;
        selectAllInFolder();
      }
      if (state.mode === 'manage' && !mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        var el = e.target;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        if (state.checked.size) { e.preventDefault(); stageDelete(); }
      }
    });

    // 侧栏宽度拖拽
    var resizer = $('resizer');
    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      resizer.classList.add('active');
      function move(ev) {
        var w = Math.max(180, Math.min(520, ev.clientX));
        $('sidebar').style.width = w + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        resizer.classList.remove('active');
        saveJSON(K_SIDE, $('sidebar').offsetWidth);
        if (state.editor) state.editor.refresh();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // 拖拽上传（整个窗口）
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.from(e.dataTransfer.types).indexOf('Files') < 0) return;
      e.preventDefault();
      state.dragDepth++;
      $('dropMask').hidden = false;
    });
    window.addEventListener('dragover', function (e) { if ($('dropMask').hidden === false) e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (!state.dragDepth) $('dropMask').hidden = true;
    });
    window.addEventListener('drop', async function (e) {
      e.preventDefault();
      state.dragDepth = 0;
      $('dropMask').hidden = true;
      var files = await filesFromDrop(e.dataTransfer);
      if (state.mode === 'manage') stageUpload(files); else uploadFiles(files);
    });

    // 管理模式事件
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });
    document.querySelectorAll('.explorer-head .sortable').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.dataset.sort;
        if (state.listSort.key === key) state.listSort.dir *= -1;
        else state.listSort = { key: key, dir: 1 };
        renderFileList();
      });
    });
    $('btnStagedToggle').addEventListener('click', function () {
      $('stagedPanel').classList.toggle('collapsed');
    });
    bindMarquee();
    $('btnMgrNewFile').addEventListener('click', stageNewText);
    $('btnMgrNewFolder').addEventListener('click', stageNewFolder);
    $('btnMgrUpload').addEventListener('click', function () { $('mgrFileInput').click(); });
    $('mgrFileInput').addEventListener('change', function (ev) {
      stageUpload(Array.from(ev.target.files).map(function (f) { return { file: f, path: f.name }; }));
      ev.target.value = '';
    });
    $('btnMgrSelectAll').addEventListener('click', selectAllInFolder);
    $('btnMgrRename').addEventListener('click', function () { stageRename('rename'); });
    $('btnMgrCopy').addEventListener('click', function () { stageRename('copy'); });
    $('btnMgrMove').addEventListener('click', function () { stageRename('move'); });
    $('btnMgrDelete').addEventListener('click', stageDelete);
    $('btnStagedClear').addEventListener('click', function () {
      state.staged = [];
      state.stageEditing = null;
      $('stageEditor').hidden = true;
      renderStaged();
    });
    $('btnStageEditDone').addEventListener('click', finishStageEdit);
    $('btnCommitAll').addEventListener('click', commitAll);
    $('manageCommitInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') commitAll();
    });

    // 供树中空状态的按钮使用
    window.__gheOpenSettings = openSettings;
  }

  /* ============ Electron 无边框窗口 ============ */
  function initElectron() {
    var api = window.electronAPI;
    if (!api) return; // 浏览器中运行时隐藏自定义标题栏
    document.body.classList.add('electron');
    $('winControls').hidden = false;
    function setMaxIcon(max) {
      $('winMax').innerHTML = '<svg class="ico"><use href="#'
        + (max ? 'i-win-restore' : 'i-win-max') + '"></use></svg>';
    }
    $('winMin').addEventListener('click', function () { api.minimize(); });
    $('winMax').addEventListener('click', function () { api.maximize(); });
    $('winClose').addEventListener('click', function () { api.close(); });
    // 双击顶栏空白处最大化 / 还原，沿用常见窗口操作习惯
    var topbar = $('topbar');
    if (topbar) topbar.addEventListener('dblclick', function (e) {
      if (e.target && e.target.closest && e.target.closest('button, input, a, .win-controls')) return;
      api.maximize();
    });
    if (api.onMaximizeChange) api.onMaximizeChange(setMaxIcon);
    if (api.getMaximized) api.getMaximized().then(setMaxIcon).catch(function () {});
    if (api.openExternal) {
      document.addEventListener('click', function (e) {
        var target = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
        if (target) { e.preventDefault(); api.openExternal(target.href); }
      });
    }
  }

  function updateThemeIcon() {
    var dark = document.body.classList.contains('dark');
    $('btnTheme').innerHTML = '<svg class="ico"><use href="#' + (dark ? 'i-sun' : 'i-moon') + '"></use></svg>';
  }

  function init() {
    state.cfg = loadConfig();
    state.expanded = new Set(loadJSON(K_EXP, []));
    var theme = loadJSON(K_THEME, 'light');
    if (theme === 'dark') document.body.classList.add('dark');
    var side = loadJSON(K_SIDE, 280);
    if (side) $('sidebar').style.width = side + 'px';
    updateThemeIcon();
    bindEvents();
    initElectron();
    setMode('manage');
    renderBreadcrumb();
    renderTree();
    $('repoLabel').textContent = state.cfg.repo ? (function () { try { var p = parseRepo(state.cfg.repo); return p.owner + '/' + p.repo; } catch (e) { return state.cfg.repo; } })() : '未配置仓库';
    $('branchPill').textContent = state.cfg.branch || 'auto';
    if (state.cfg.repo) connect();
    if (!localStorage.getItem(K_INIT)) {
      try { localStorage.setItem(K_INIT, '1'); } catch (e) {}
      openSettings();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
