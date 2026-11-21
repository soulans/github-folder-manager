# GitHub Folder Manager · GitHub 文件管理器

> 把任意 GitHub 仓库当成本地文件夹来管理：像资源管理器一样浏览、编辑、上传、重命名、移动文件，改完一键提交。

**本项目使用 [WorkBuddy](https://www.workbuddy.cn/) 完成开发。**

一个 Windows 桌面应用，基于 **Electron + GitHub REST / Git Data API**。无需 `git clone`，本机不用安装 Git，直接通过 API 读写仓库内容。适合维护 GitHub Pages 站点、静态资源仓库，或者只是想用「文件夹」的方式管理仓库文件。

## 功能

- **资源管理器式浏览**：左侧目录树 + 右侧文件列表，支持排序、框选、Ctrl / Shift 多选、右键菜单、拖拽移动到文件夹。
- **两种模式**：`预览模式` 用于查看和编辑单个文件；`文件管理模式`（默认）用于批量操作。
- **完整文件操作**：新建文本、新建文件夹、重命名、复制、移动、删除、全选本目录。
- **编辑与预览**：内置代码编辑器，文本文件可直接编辑，Markdown 支持预览；二进制文件可下载。
- **上传本地文件**：选择文件即读取并显示进度，失败时给出具体原因。
- **一键提交**：所有改动先进入「待提交」列表，确认后合并为**一次原子提交**；支持撤销上次提交。
- **配置化**：仓库地址、分支、Token、API 地址、本地代理都在「设置」里填写，无需改代码。
- **本地代理**：支持 HTTP / HTTPS / SOCKS5 代理，网络受限环境也能连接。
- **其他**：深浅主题切换、无系统标题栏的自绘顶栏、可拖动的窗口、GitHub API 额度显示。

## 快速开始

### 方式一：使用打包版

从 [Releases](https://github.com/soulans/github-folder-manager/releases) 下载任一 exe：

| 文件 | 说明 |
| --- | --- |
| `GitHubFolderManager-Portable-1.0.0-x64.exe` | 免安装，双击即用 |
| `GitHubFolderManager-Setup-1.0.0-x64.exe` | 安装到本机，可创建桌面快捷方式 |

> Release 资源使用英文文件名，避免部分系统下载中文名时出现乱码；从源码自行构建时产物仍为中文文件名。

首次打开后点击右上角 **设置** 填写仓库信息即可。

### 方式二：从源码运行

需要 Node.js 18+：

```bash
npm install
npm start
```

也可以只用浏览器预览（不含代理与窗口控制等 Electron 能力）：

```bash
python serve.py
# 然后打开 http://localhost:8000
```

## 配置说明

打开右上角 **设置**，常用项如下：

| 配置项 | 说明 |
| --- | --- |
| 仓库 | `https://github.com/owner/repo` 或简写 `owner/repo`，例如 `soulans/github-folder-manager` |
| Token | GitHub Personal Access Token |
| 分支 | 留空会自动检测默认分支；也可手动指定，例如 `main` |
| API 地址 | 默认 `https://api.github.com`，GitHub Enterprise 可自行修改 |
| 代理 | 例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`，留空表示直连 |

> 程序不会预填任何仓库地址；请在「设置」中自行填写，输入框中的 `owner/repo` 仅为格式示例。

**Token 权限**：细粒度 Token 需要 `Contents: read and write`；经典 Token 需要 `repo` 权限。

- [创建细粒度 Token](https://github.com/settings/personal-access-tokens/new)
- [创建经典 Token](https://github.com/settings/tokens/new)

> Token 只保存在本机浏览器的 localStorage 中，不会上传到任何第三方服务器。请勿把它提交到仓库或分享给他人。

## 使用说明

1. **文件管理模式**（默认）：左侧选目录，右侧像资源管理器一样列出文件和文件夹；框选或 Ctrl / Shift 多选后可批量重命名、复制、移动、删除。
2. 新建 / 编辑 / 上传产生的改动会先进入底部 **待提交** 抽屉，可逐项查看或清空。
3. 填写提交信息后点 **一键提交**，所有改动合并成一次 commit 推送到仓库。
4. 提交后可点提示条中的 **撤销** 回退上一次提交。
5. **预览模式**：双击文件打开编辑器，文本可修改并保存提交，Markdown 可切换预览，其他文件可下载。
6. 状态栏的 `4996/5000` 是 **GitHub API 每小时剩余请求额度**（rate limit），不是文件数量或存储容量。

## 从源码构建

```bash
npm install
npm run dist
```

产物输出到 `dist/`：

- `GitHub文件管理器-便携版-1.0.0-x64.exe`
- `GitHub文件管理器-安装版-1.0.0-x64.exe`
- `win-unpacked/`（解压后的可执行程序）

## 技术说明

- 通过 GitHub **Git Data API** 完成提交：读取 ref → 读取 commit → 创建 tree / blob → 创建 commit → 更新 ref。
- 删除全部文件时使用 Git 空树 SHA，保证仓库仍可正常提交。
- 多文件变更合并为一次 commit，避免产生大量零碎提交。
- Electron 主进程负责网络请求与代理；渲染进程通过 `contextBridge` 调用，不直接暴露 Node 能力。

## 开发工具

本项目的代码、打包与文档均使用 [WorkBuddy](https://www.workbuddy.cn/) 完成，包括：

- 界面与交互：资源管理器式文件列表、框选 / 多选、编辑与 Markdown 预览、上传进度、提示条与自绘顶栏；
- 核心逻辑：GitHub REST / Git Data API 客户端、原子提交、空树处理、待提交列表与撤销；
- 桌面端：Electron 无边框窗口、IPC 窗口控制、HTTP / SOCKS5 代理、Windows exe 打包；
- 仓库文档：README、MIT LICENSE、.gitignore 与包元数据。

代码版权归仓库所有者所有，WorkBuddy 为开发工具，并非版权方。

## 许可证

[MIT](LICENSE) © 2026 soulans

自由使用、修改、分发（包括商用），只需保留版权与许可声明。

## 免责声明

本项目是个人开发的第三方工具，与 GitHub, Inc. 无官方关联。使用本工具产生的提交、删除等操作会直接作用于你的仓库，请在重要操作前自行备份。
