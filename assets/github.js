/* GitHub REST API 客户端 —— 纯浏览器直接调用，无需后端 */
(function (global) {
  'use strict';

  // Git 中固定的空树对象。GitHub 不允许通过 Git Data API 新建空树，
  // 删除仓库最后一个文件时必须直接提交这个 SHA。
  var EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  function parseRepo(input) {
    var raw = String(input || '').trim();
    if (!raw) throw new Error('请填写仓库地址');
    // git@github.com:owner/repo.git
    var ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (ssh) return { owner: ssh[1], repo: ssh[2] };
    // https://github.com/owner/repo(/tree/branch)
    var url = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
    if (url) return { owner: url[1], repo: url[2] };
    // owner/repo
    var slug = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (slug) return { owner: slug[1], repo: slug[2] };
    throw new Error('无法识别仓库地址，请填写 https://github.com/owner/repo 或 owner/repo');
  }

  function apiError(status, message) {
    var msg = message || '';
    var friendly;
    if (status === 401) friendly = 'Token 无效或已过期，请在设置中重新填写。';
    else if (status === 403) friendly = /rate limit/i.test(msg)
      ? 'GitHub API 请求次数已用尽，请稍后重试或配置 Token。'
      : '没有权限执行此操作，请检查 Token 是否具备 Contents 读写权限。';
    else if (status === 404) friendly = '仓库、分支、文件或 Git 对象不存在，请检查地址与分支配置。'
      + (msg && msg !== 'Not Found' ? '（GitHub：' + msg + '）' : '');
    else if (status === 409) friendly = '提交冲突：文件已被他人修改，请刷新后重试。';
    else if (status === 422 && /sha/i.test(msg)) friendly = '文件已发生变化，请刷新后重试。';
    else friendly = msg || ('请求失败（HTTP ' + status + '）');
    var err = new Error(friendly);
    err.status = status;
    err.raw = msg;
    return err;
  }

  function encodePath(path) {
    return String(path || '').split('/').map(encodeURIComponent).join('/');
  }

  class GitHubClient {
    constructor(cfg) { this.configure(cfg || {}); }

    configure(cfg) {
      var parsed = parseRepo(cfg.repo);
      this.owner = parsed.owner;
      this.repo = parsed.repo;
      this.token = cfg.token || '';
      this.branch = cfg.branch || '';
      this.apiBase = (cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '');
      this.proxy = (cfg.proxy || '').trim();
    }

    get slug() { return this.owner + '/' + this.repo; }

    /* 统一请求入口：配置代理且运行在 Electron 时走主进程转发 */
    async rawFetch(url, headers, method, body) {
      var api = this.proxy && global.electronAPI ? global.electronAPI : null;
      if (api && api.gheFetch) {
        var r = await api.gheFetch({ url: url, method: method, headers: headers, body: body, proxy: this.proxy });
        var bytes = Utils.base64ToBytes(r.base64 || '');
        var text = '';
        try { text = new TextDecoder().decode(bytes); } catch (e) { text = String.fromCharCode.apply(null, bytes); }
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: {
            get: function (name) {
              var v = (r.headers || {})[String(name).toLowerCase()];
              return v === undefined ? null : (Array.isArray(v) ? v.join(', ') : String(v));
            }
          },
          json: async function () { return JSON.parse(text); },
          text: async function () { return text; },
          bytes: bytes
        };
      }
      return fetch(url, { method: method, headers: headers, body: body });
    }

    async request(path, options) {
      options = options || {};
      var url = /^https?:\/\//i.test(path) ? path : this.apiBase + path;
      var headers = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      var res;
      try {
        res = await this.rawFetch(url, headers, options.method || 'GET',
          options.body !== undefined ? JSON.stringify(options.body) : undefined);
      } catch (e) {
        throw new Error('无法连接到 GitHub，请检查网络或 API 地址设置。' + (e.message ? '（' + e.message + '）' : ''));
      }
      if (!res.ok) {
        var msg = '';
        try { var data = await res.json(); msg = data.message || ''; } catch (_) {}
        if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
          msg = 'API rate limit exceeded';
        }
        throw apiError(res.status, msg);
      }
      if (res.status === 204 || res.headers.get('content-length') === '0') return null;
      return res.json();
    }

    /* 校验配置并确定实际分支 */
    async validate() {
      var info = await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo));
      var branch = this.branch;
      if (branch) {
        try {
          await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
            + '/branches/' + encodeURIComponent(branch));
        } catch (e) {
          if (e.status === 404) throw new Error('分支「' + branch + '」不存在，请检查设置。');
          throw e;
        }
      } else {
        branch = info.default_branch;
      }
      this.branch = branch;
      return { info: info, branch: branch };
    }

    async getRef() {
      var res = await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/git/ref/heads/' + encodeURIComponent(this.branch));
      return res.object.sha;
    }

    async getCommit(sha) {
      return this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/git/commits/' + encodeURIComponent(sha));
    }

    /* 一次性拿到整个仓库的扁平文件树 */
    async listTree(treeSha) {
      if (treeSha === EMPTY_TREE_SHA) return [];
      var res = await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/git/trees/' + encodeURIComponent(treeSha) + '?recursive=1');
      return res.tree || [];
    }

    async getTree() {
      var commitSha = await this.getRef();
      var commit = await this.getCommit(commitSha);
      var treeSha = commit.tree.sha;
      var res = treeSha === EMPTY_TREE_SHA ? null
        : await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
          + '/git/trees/' + encodeURIComponent(treeSha) + '?recursive=1');
      return {
        entries: res ? (res.tree || []) : [],
        truncated: !!(res && res.truncated),
        commitSha: commitSha,
        treeSha: treeSha
      };
    }

    /* 读取单个文件内容 */
    async getFile(path) {
      var res = await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(this.branch));
      if (Array.isArray(res)) throw new Error('该路径是一个文件夹，不是文件。');
      var isBinary = Utils.isBinaryName(path);
      var content = null;
      if (res.content && res.encoding === 'base64' && !isBinary) {
        var decoded = Utils.fromBase64(res.content);
        if (Utils.hasNullByte(decoded)) isBinary = true;
        else content = decoded;
      }
      return {
        path: res.path || path, name: res.name || path.split('/').pop(),
        sha: res.sha, size: res.size, content: content, isBinary: isBinary,
        tooLarge: !res.content && (res.size || 0) > 1024 * 1024,
        downloadUrl: res.download_url || this.rawUrl(path)
      };
    }

    /* 单独创建 blob，上传文件时可提前上传并拿到 SHA */
    async createBlob(base64) {
      var res = await this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/git/blobs', { method: 'POST', body: { content: base64, encoding: 'base64' } });
      return res.sha;
    }

    rawUrl(path) {
      return 'https://raw.githubusercontent.com/' + this.owner + '/' + this.repo + '/'
        + this.branch + '/' + encodePath(path);
    }

    /* 通过 Git Data API 原子提交：changes = [{op:'upsert'|'delete', path, content?, base64?}] */
    async commit(changes, message) {
      if (!changes.length) throw new Error('没有需要提交的更改');
      const step = async (label, fn) => {
        try { return await fn(); }
        catch (e) {
          e.step = label;
          e.message = label + '失败：' + e.message;
          throw e;
        }
      };
      var commitSha = await step('读取分支', () => this.getRef());
      var parent = await step('读取提交', () => this.getCommit(commitSha));
      var baseTreeSha = parent.tree.sha;
      var deletePaths = changes.filter(function (c) { return c.op === 'delete'; })
        .map(function (c) { return c.path; });
      var upserts = changes.filter(function (c) { return c.op === 'upsert'; });

      // 仓库当前已是空树：不能再把空树当 base_tree，删除操作也无意义
      if (baseTreeSha === EMPTY_TREE_SHA) {
        changes = upserts;
        deletePaths = [];
        if (!changes.length) throw new Error('仓库已经是空的，没有需要删除的文件');
      }

      // 删除全部文件：GitHub 不允许用 Git Data API 生成空树，
      // 会把 base_tree + 全部 sha:null 的创建树请求返回 404。
      // 这里直接引用 Git 固定的空树 SHA 创建提交。
      var useEmptyTree = false;
      if (!upserts.length && deletePaths.length && baseTreeSha !== EMPTY_TREE_SHA) {
        var all = await step('读取文件树', () => this.listTree(baseTreeSha));
        var filePaths = all.filter(function (e) { return e.type !== 'tree'; })
          .map(function (e) { return e.path; });
        useEmptyTree = filePaths.length > 0 && filePaths.every(function (p) {
          return deletePaths.indexOf(p) !== -1;
        });
      }

      var treeSha;
      if (useEmptyTree) {
        treeSha = EMPTY_TREE_SHA;
      } else {
        var tree = [];
        for (var i = 0; i < changes.length; i++) {
          var ch = changes[i];
          if (ch.op === 'delete') {
            tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
          } else {
            var content = ch.sha ? null
              : (ch.base64 !== undefined ? ch.base64 : Utils.toBase64(ch.content || ''));
            var blobSha = ch.sha;
            if (!blobSha) {
              blobSha = await step('创建文件内容', () => this.createBlob(content));
            }
            tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: blobSha });
          }
        }
        var treeBody = { tree: tree };
        if (baseTreeSha !== EMPTY_TREE_SHA) treeBody.base_tree = baseTreeSha;
        var newTree = await step('生成文件树', () => this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
          + '/git/trees', { method: 'POST', body: treeBody }));
        treeSha = newTree.sha;
      }

      var newCommit = await step('创建提交', () => this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/git/commits', {
          method: 'POST',
          body: { message: message, tree: treeSha, parents: [commitSha] }
        }));
      await step('更新分支', () => this.request('/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/git/refs/heads/' + encodeURIComponent(this.branch), {
          method: 'PATCH',
          body: { sha: newCommit.sha, force: false }
        }));
      return newCommit;
    }

    /* 下载原始文件（带鉴权，兼容私有仓库） */
    async downloadBlob(path) {
      var url = this.apiBase + '/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo)
        + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(this.branch);
      var headers = { 'Accept': 'application/vnd.github.raw+json' };
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      var res = await this.rawFetch(url, headers, 'GET', undefined);
      if (!res.ok) {
        var msg = '';
        try { msg = ((await res.json()).message) || ''; } catch (_) {}
        throw apiError(res.status, msg);
      }
      return res.bytes ? new Blob([res.bytes]) : res.blob();
    }

    async getRateLimit() {
      try {
        var res = await this.request('/rate_limit');
        return res && res.resources ? res.resources.core : null;
      } catch (e) { return null; }
    }
  }

  global.GitHubClient = GitHubClient;
  global.parseRepo = parseRepo;
})(window);
