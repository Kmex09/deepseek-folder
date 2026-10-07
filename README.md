# DSF · DeepSeek 会话夹

> 一个纯 HTML / CSS / JS 的网页端实用小工具：把散落在几十个会话里的 DeepSeek 对话，
> 像文件一样**分类、固定、归档**。无框架、无构建、无外部依赖，双击即可运行。

```
痛点：DeepSeek 网页端会话一多就找不到 —— 没有归类功能。
思路：每个会话都有一条直达链接（登录浏览器后新标签页打开即可回到该会话）。
DSF 就是存放这些链接的「网页版文件夹」：拖入即存、点击直达、按文件夹归类。
```

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 🗂 文件夹管理 | 右侧 3/4 文件管理区：创建 / 重命名 / 删除文件夹，网格化浏览 |
| 🌳 子文件夹（任意层级） | 文件夹内可继续创建子文件夹；侧边栏目录树分层缩进、可折叠；文件夹可整树移动（防环保护）或级联删除 |
| ⬇️ 一键导入 | 把 DeepSeek 的**会话按钮 / 链接拖到顶部导入区**；或「粘贴链接导入」；整段文字拖入也会自动识别其中的链接 |
| 📥 拖到文件夹 | 链接直接拖到侧边栏某文件夹 / 文件夹卡片上，即保存到该文件夹 |
| 📂 归类管理 | 会话卡片支持改名、移动到其它文件夹、点击直达原会话（新标签页） |
| ⭐ 常用固定 | 侧边栏「常用固定」：手动 pin 常用文件夹与会话 |
| 🗑 最近关闭 | 「关闭」的会话自动归档到侧边栏「最近关闭」，可一键恢复到原文件夹 |
| 🔍 全局搜索 | 按会话标题 / 链接、文件夹名称实时搜索 |
| 💾 本地记忆 | 自动保存不丢失：桌面版存 `%APPDATA%`、网页版存 `dsf-data.json`，也可用浏览器 localStorage；支持 JSON 备份 / 恢复 |
| 🖥 桌面版（v0.3.0） | Electron 封装，双击即用、无需浏览器/Python/授权，数据零操作持久化；会话链接交给系统浏览器打开 |
| 🔒 本地接口访问控制（v0.3.2） | 数据接口校验回环 Host + 同源 Origin + 会话令牌，杜绝跨站页面覆盖你的数据文件 |
| 🌙 深色模式 | 跟随系统自动切换明暗主题 |

## 快速开始

### 1.桌面版

```bash
npm install        # 首次执行一次，下载 Electron（约 100MB，需联网）
npm start          # 打开 DSF 桌面应用
```

- 数据自动保存到 **`%APPDATA%\DSF 会话夹\dsf-data.json`**（macOS/Linux 为对应
  userData 目录）：重启电脑、清浏览器缓存都不受影响，**无需任何手动保存或授权**；
- 点击会话卡片时，DeepSeek 会话用**系统默认浏览器**打开（不在应用内开窗）；
- **快速导入悬浮窗**：侧边栏底部「悬浮窗」按钮开启后，主窗口不在前台（最小化 / 被
  浏览器挡住）时，屏幕角落会保留一个**始终置顶**的迷你窗 —— 把浏览器的会话链接直接
  拖进去，即自动唤起主窗口并完成导入；窗口位置会被记住，点小窗本体也能唤起主窗口；
- 快捷键：`F5` / `Ctrl+R` 刷新、`F12` 开发者工具、`F11` 全屏、`Ctrl+W` 关闭；
- 自检：`npm run smoke`（启动并校验数据接口）、`npm run smoke:quick`（悬浮窗 9 项检查）；
  `npm run smoke:write` 后再 `npm run smoke:persist`（写入 → 新进程重启 → 校验数据仍在）；
- 打包 exe：`npm install -D electron-builder && npm run dist`，产物在 `dist/`：
  - `DSF 会话夹 0.4.0.exe` —— **便携版**，拷到哪都能双击运行；
  - `DSF 会话夹 Setup 0.4.0.exe` —— 安装包（含开始菜单 / 桌面快捷方式）。
  已实测：便携版 exe 连续两次独立运行（写入 → 重启校验）数据均正确保留。
- 换图标：把任意图片传给生成脚本，再重新打包即可：
  ```bash
  python tools/make_icons.py "D:\路径\你的图.png"   # 自动裁方 + 生成 ico/png
  npm run dist
  ```

### 2.网页版

Windows 双击 `start-dsf.cmd`；macOS / Linux 运行 `./start-dsf.sh`。
脚本启动服务并自动打开浏览器 —— 所有改动写入项目目录的 **`dsf-data.json`**。

```bash
python server.py            # 默认 http://127.0.0.1:8000/
python server.py 8080       # 指定端口
node desktop/server.js 8000 # 或：Node 版服务器（无需 Python）
```

### 方式 C：直接双击 `index.html`（file://，最简但最弱）

数据存浏览器本地存储；若浏览器拒绝存储或重启后清空，页面顶部会给出醒目提示，
请改用方式 A 或 B。

## 数据保存在哪里？

| 运行方式 | 保存位置 | 说明 |
| --- | --- | --- |
| 桌面版 `npm start` | `%APPDATA%\DSF 会话夹\dsf-data.json` | **推荐**：零操作、跨重启可靠 |
| `start-dsf.cmd` / `server.py` / `node desktop/server.js` | 项目目录 `dsf-data.json` | 网页版的文件级持久化 |
| 双击 `index.html` | 浏览器 localStorage | 免安装；受浏览器隐私设置影响 |
| 全都不满足 | 仅内存 | 页面会明显提示，请立即「导出备份」 |

> - **如何确认正在“文件保存模式”**：侧边栏底部显示绿色“自动保存到数据文件…”；
> - 数据文件与浏览器存储**自动按时间取最新**，平时无需手动同步；
> - 会话标题在拖入时只能拿到 URL（浏览器不允许跨站读取 DeepSeek 页面内容），
>   可在导入框里改名；同文件夹内重复链接会被自动跳过
>   （尾斜杠 / `#锚点` 等等价写法也算同一条）；
> - 用服务器模式打开时，**只有从本机页面发出的请求**才能读写数据接口
>   （校验回环 Host + 同源 Origin + 会话令牌），别的前缀或别处的网页无法覆盖你的数据文件。

## 首次使用三步

1. **新建文件夹** —— 例如「学习 / 工作 / 灵感」，进入文件夹后还能继续建**子文件夹**细分；
2. **导入会话** —— 在 DeepSeek 网页打开目标会话，把标签页/链接拖进导入区（或复制链接粘贴）；
3. **管理与直达** —— 点击卡片即在新标签页打开原会话；点亮 ☆ 固定到侧边栏；
   「关闭」的会话会进入「最近关闭」，随时可恢复。

## 目录结构

```
.
├── index.html            # 页面骨架 + 内联 SVG 图标库（网页版 / 桌面版共用）
├── package.json          # 桌面版（Electron）依赖与脚本
├── desktop/
│   ├── main.js           # Electron 主进程：内嵌服务 + 窗口 + 外链交给系统浏览器
│   └── server.js         # 内嵌本地服务（Node，零依赖；也可单独当服务器运行）
├── assets/               # 应用图标（icon-256/512 窗口用、icon-64 网页 favicon）
├── build/icon.ico        # 打包用多尺寸 Windows 图标（electron-builder 默认读取）
├── tools/make_icons.py   # 由一张图片生成全套图标（Pillow）
├── server.py             # 网页版一键数据服务器（Python，无需 Node）
├── start-dsf.cmd         # Windows 一键启动（网页版）
├── start-dsf.sh          # macOS / Linux 一键启动（网页版）
├── css/
│   └── style.css         # 全部样式（明/暗双主题）
├── js/
│   ├── dsf.utils.js      # 工具层：DeepSeek 链接识别 / 归一化 / 解析
│   ├── dsf.store.js      # 数据层：浏览器/文件双持久化 + CRUD + 订阅
│   ├── dsf.ui.js         # 渲染层：侧边栏 / 内容区 / 弹窗 / Toast
│   └── dsf.app.js        # 主控层：路由、事件委托、拖拽导入、搜索、备份、文件同步
├── tests/
│   ├── smoke.js          # 数据层 / 链接解析冒烟测试
│   └── desktop-server.js # 内嵌服务接口测试（含目录穿越防护）
├── docs/
│   ├── ARCHITECTURE.md   # 架构设计文档
│   └── CHANGELOG.md      # 版本更新文档
├── dsf-data.json         # 网页版运行后自动生成的数据文件（勿手改）
├── dist/                 # 打包产物（npm run dist 生成）
├── LICENSE               # MIT 许可证
└── AGENT.txt             # 原始需求描述
```

## 运行测试

```bash
node --check js/*.js          # 页面脚本语法检查
npm test                      # 一次跑完下面两个 Node 测试套件
node tests/smoke.js           # 数据层 / 链接解析 / 索引缓存 / 批量提交（87 项断言）
node tests/desktop-server.js  # 内嵌服务接口 + 访问控制（23 项断言）
npm run smoke                 # 桌面版启动自检
npm run smoke:quick           # 快速导入悬浮窗自检（9 项）
npm run smoke:write && npm run smoke:persist   # 桌面版“写入 → 重启 → 数据仍在”自检
```

## 文档

- [架构设计 ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 分层设计、数据模型、关键流程、取舍与限制
- [更新日志 CHANGELOG.md](docs/CHANGELOG.md) —— 各版本变更记录

## 技术栈

HTML5 + CSS3（Grid / Flex / 自定义属性）+ 原生 JavaScript（ES5 语法、经典脚本加载，
兼容 `file://` 与旧浏览器）。数据仅存于本地，不上传任何内容。
