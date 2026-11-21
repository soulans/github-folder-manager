const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

let HttpsProxyAgent = null, SocksProxyAgent = null;
try { ({ HttpsProxyAgent } = require('https-proxy-agent')); } catch (e) {}
try { ({ SocksProxyAgent } = require('socks-proxy-agent')); } catch (e) {}

let mainWindow = null;

// 软件改名后，把旧版本保存在用户目录里的 Token、仓库配置等迁移到新目录
function migrateUserData() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'GitTrinket');
    const newDir = path.join(app.getPath('appData'), 'github-folder-manager');
    if (oldDir === newDir || !fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    fs.readdirSync(oldDir).forEach(function (entry) {
      const from = path.join(oldDir, entry);
      const to = path.join(newDir, entry);
      if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, force: false });
    });
  } catch (e) {
    // 迁移失败不应阻止软件启动
  }
}
migrateUserData();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    frame: false,              // 不使用 Windows 标题栏
    backgroundColor: '#f6f8fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('maximize', () => {
    if (mainWindow) mainWindow.webContents.send('maximize-change', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow) mainWindow.webContents.send('maximize-change', false);
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 页面中的外部链接统一交给系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window-is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));
ipcMain.handle('open-external', (_event, url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  return false;
});

/* 通过本地代理转发 GitHub API 请求（HTTP / HTTPS / SOCKS5） */
ipcMain.handle('ghe-fetch', async (_event, payload) => {
  const { url, method = 'GET', headers = {}, body } = payload || {};
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('无效的请求地址');
  const target = new URL(url);
  const mod = target.protocol === 'http:' ? http : https;
  let agent;
  let proxy = String((payload && payload.proxy) || '').trim();
  if (proxy) {
    if (!/^[a-z]+:\/\//i.test(proxy)) proxy = 'http://' + proxy;
    if (/^socks/i.test(proxy)) {
      if (!SocksProxyAgent) throw new Error('SOCKS 代理组件不可用，请重新打包应用。');
      agent = new SocksProxyAgent(proxy);
    } else {
      if (!HttpsProxyAgent) throw new Error('HTTP 代理组件不可用，请重新打包应用。');
      agent = new HttpsProxyAgent(proxy);
    }
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(target, { method, headers, agent }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers || {},
        base64: Buffer.concat(chunks).toString('base64')
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
});
