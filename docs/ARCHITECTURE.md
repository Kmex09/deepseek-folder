# DSF 架构设计文档（ARCHITECTURE.md）

> 版本：v0.3.2 · 2026-09-27 · 配套代码：本仓库 `index.html` + `js/` + `css/` + `server.py` + `desktop/`

本文档说明 **DSF（DeepSeek Session Folder）** 的总体设计：需求映射、目录分层、
数据模型、关键流程、设计取舍与已知限制，以及测试与演进路线。

---

## 1. 需求 → 实现映射

需求来源见根目录 `AGENT.txt`（含后续迭代需求），逐条对照如下：

| AGENT.txt 需求 | 实现 |
| --- | --- |
| 网页版“文件夹”，存 DeepSeek 会话链接，按钮直达新窗口 | 每个「会话」卡片保存一条 URL，点击即 `window.open(url, '_blank')` 直达原会话（`js/dsf.app.js → openSession`、`store.openSession`） |
| 拖拽 DeepSeek 会话按钮到导入区，一键粘贴链接 | 顶部常驻「导入区」：接收拖拽的 `text/uri-list / text/plain / text/html / 文件`；另有「粘贴链接导入」多行对话框 |
| 手动创建分类文件夹、手动把会话放入不同文件夹 | 文件夹的创建 / 重命名 / 删除；会话支持改名、移动（拖拽到文件夹 + “移动到…”选择器） |
| 文件资源管理器式体验 | 右侧 3/4 主区：根视图 = 文件夹网格；点入文件夹 = 会话卡片网格；面包屑导航 |
| 左侧参考 DeepSeek / DSH 原生 UI 的侧边栏 | 左侧 1/4 侧边栏：品牌区、搜索框、文件夹导航树、**常用固定**、**最近关闭**、统计与备份入口 |
| 手动 pin 常用文件夹与会话 | 会话 / 文件夹卡片及文件夹顶栏的 ☆ 按钮切换 `pinned` 状态，固定项集中显示在侧边栏「常用固定」 |
| 自动保存最近关闭的会话 | 「关闭」会话（从文件夹移除）→ 自动写入 `recentClosed` 归档并显示于侧边栏，可一键恢复到原文件夹（见 §4.3 语义说明） |
| 子文件夹（v0.2.0 迭代需求）：文件夹中可继续创建子文件夹 | 数据模型引入 `parentId` 树形结构；文件夹视图内展示「子文件夹」区块与新建入口；侧边栏目录树分层缩进、可折叠；文件夹支持移动（含防环保护）与整树级联删除（见 §4.5） |
| 桌面版（v0.3.0 迭代需求）：更简便的本地存储 | Electron 封装：主进程内嵌与 `server.py` 同接口的本地服务，窗口加载 `http://127.0.0.1:<随机端口>/`，页面零改动即进入“数据文件”模式；数据落在 `%APPDATA%\DSF 会话夹\dsf-data.json`，无需授权与手动保存（见 §2.1） |
| 撰写架构与更新文档 | 本文件 + `CHANGELOG.md` + 根 `README.md` |

## 2. 目录与分层

三层运行形态共用同一套页面代码：

| 形态 | 启动方式 | 页面地址 | 数据位置 |
| --- | --- | --- | --- |
| 桌面版（推荐） | `npm start`（Electron） | `http://127.0.0.1:<随机端口>/`（内嵌服务） | `%APPDATA%\DSF 会话夹\dsf-data.json` |
| 网页版 + 服务 | `start-dsf.cmd` / `python server.py` / `node desktop/server.js` | `http://127.0.0.1:8000/` | 项目目录 `dsf-data.json` |
| 纯静态 | 双击 `index.html` | `file://…/index.html` | 浏览器 localStorage |

页面代码刻意保持**零构建、零依赖、经典脚本**：按顺序加载四个 JS 文件，共享同一个
`window.DSF` 命名空间；`file://` 直接打开也能运行（不使用 ES Module，规避本地文件
CORS 限制）。桌面版只是给它套了一层原生外壳，**没有改动任何前端逻辑**。

```
index.html          入口：页面骨架 + 内联 SVG 图标库（<symbol> + <use>）
css/style.css       样式：CSS 变量明暗双主题；Grid 布局（286px 侧栏 + 弹性主区）
js/dsf.utils.js     工具层   —— 无状态纯函数（UID、转义、链接识别/归一化）
js/dsf.store.js     数据层   —— 唯一数据源 + 浏览器/数据文件双持久化 + 变更订阅
js/dsf.ui.js        渲染层   —— 读 store+state 输出 DOM；弹窗/Toast/选择器组件
js/dsf.app.js       主控层   —— 视图路由、事件委托、拖拽 DnD、搜索、备份、文件同步
desktop/main.js     Electron 主进程 —— 内嵌服务 + 窗口 + 外链转交系统浏览器 + 自检
desktop/server.js   内嵌服务（Node 零依赖）—— 静态托管 + GET/PUT /api/state
assets/             应用图标（icon-256 窗口/任务栏、icon-64 网页 favicon、icon-512 备用）
build/icon.ico      打包用多尺寸 Windows 图标（electron-builder buildResources 约定目录）
tools/make_icons.py 图标生成脚本 —— 一张图片 → 裁方/缩放 → ico + 多尺寸 png
server.py           网页版后端（Python 标准库）—— 与 desktop/server.js 同接口
start-dsf.cmd/.sh   网页版一键启动（纯 ASCII，避免 cmd 代码页问题）
package.json        桌面版依赖与脚本（start / smoke / web / dist）
tests/smoke.js      数据层与链接解析冒烟测试
tests/desktop-server.js  内嵌服务接口测试（含目录穿越防护）
docs/…              文档
```

依赖方向（单向，禁止反向）：

```
Electron 主进程 ──嵌入──▶ desktop/server.js ──读写──▶ %APPDATA%/dsf-data.json
                                  ▲
浏览器渲染进程: app ──调用──▶ ui ──读取──▶ store ──写入──▶ localStorage
                                  └──(同源 fetch)──▶ /api/state（内嵌服务 或 server.py）
          ui / app 均不直接持有数据，只通过 store 方法修改
```

数据变更的完整闭环：

```
用户操作 → store.xxx()（改内存 → 写浏览器存储）→ commit() 通知订阅者
        → app 订阅(ui.scheduleRender) 合并到下一帧统一重绘（侧栏 + 顶栏 + 内容）
        → app 订阅(防抖 600ms + pagehide / 桌面版退出前 flush)  PUT /api/state 同步到数据文件
```

> **v0.3.2 的两条性能约定**（细节见 §9）：
> 1) 查询一律走 `store` 内部的惰性索引缓存，任何数据变动都经 `commit()` / `mutate()`
>    递增版本号使缓存失效——**不要绕过它们直接改 `store.data`**，否则缓存会陈旧；
> 2) 批量操作（导入 / 级联删除 / 恢复归档）用 `mutate()` 包住，整批只落盘一次、
>    只通知一次，配合 `ui.scheduleRender` 的帧合并，避免“每条都全量序列化 + 全量重绘”。

### 2.1 为什么桌面版是“更简便的本地存储”

浏览器沙箱不允许网页静默写本地文件，所以纯网页方案必须在「浏览器存储（可能被清空）」
与「跑一个本地服务并保持窗口」之间取舍。Electron 把后者的成本降到零：

- 主进程本身就能写文件，`desktop/server.js` 只是让**前端代码一行不改**地复用
  `fetch('/api/state')` 逻辑 —— 安全边界不变（渲染进程 `contextIsolation: true`、
  `nodeIntegration: false`、`sandbox: true`，没有任何 Node 能力）；
- 数据文件路径取 `app.getPath('userData')`，与安装位置无关，升级 / 迁移都不丢；
- 随机回环端口 + 单实例锁：不会与其他程序抢端口，重复启动只聚焦已有窗口；
- `window.open` / `will-navigate` 拦截：DeepSeek 会话链接交给系统浏览器，
  既保留“多点几个会话标签页”的习惯，又避免应用内堆窗口。


启动时 `bootstrapFileMode()` 先 GET `/api/state`：若数据文件存在，与浏览器存储
按 `savedAt` 比较**自动取最新**（本地为空则直接采用文件数据），之后所有改动
双写。`file://` 直接打开时无后端可连，自动回退为纯浏览器存储。
同步结束前（`booted === false`）页面不往后端写，避免启动竞态把旧数据盖回去。

#### 2.2 数据接口的访问控制（v0.3.2）

`/api/state` 是回环地址上的**写接口**。若不设防，用户浏览任意网站时，该网站可以
用「简单请求」（`Content-Type: text/plain`，不触发 CORS 预检）直接 PUT 覆盖
`dsf-data.json` —— 响应虽然读不到，破坏却已经落地。因此两个后端（`server.py` /
`desktop/server.js`）在数据接口上做三层校验，且**拒绝时先回完整响应再断连**
（否则客户端会因“请求体没发完”而与服务端互相等待）：

| 校验 | 作用 | 页面侧怎么配合 |
| --- | --- | --- |
| `Host` 必须是 `127.0.0.1 / localhost / [::1]` | 防 DNS rebinding | 无需配合 |
| `Origin`（若携带）必须与 `Host` 同源 | 防跨站请求伪造 | 无需配合（同源 fetch 自动满足） |
| `X-DSF-Token` 必须匹配本次会话令牌 | 最终闸门 | 服务端渲染 `index.html` 时把 `__DSF_TOKEN__` 占位符替换为随机令牌，页面从 `<meta name="dsf-token">` 读取并放进请求头 |

推论：`index.html` 里**不存任何密钥**（磁盘上始终是占位符），令牌只存在于服务进程内存与
当次响应的 HTML 中；`file://` 直开时占位符不变、无后端可连，逻辑自动退化为无令牌模式。
两个后端另有共同的静态托管防护：目录穿越、隐藏目录、`node_modules`、以及**数据文件本身**
（`GET /dsf-data.json` 也返回 403，页面只经 `/api/state` 读写）。

## 3. 数据模型（浏览器存储 key `dsf.data.v1` / 数据文件 `dsf-data.json` 同构）

```jsonc
{
  "v": 1,
  "savedAt": 1750000000000,             // 最近一次成功保存时间（双持久化按它取最新）
  "folders": [                          // 树形目录：parentId = null 表示根目录
    { "id": "uuid", "name": "学习", "parentId": null, "createdAt": 1750000000000, "pinned": false },
    { "id": "uuid", "name": "数学", "parentId": "父文件夹 id", "createdAt": 1750000000000, "pinned": false }
  ],
  "sessions": [
    {
      "id": "uuid",
      "folderId": "所属文件夹 id（直属，不含祖先文件夹）",
      "title": "牛顿力学笔记",          // 默认「未命名会话」，可重命名
      "url": "https://chat.deepseek.com/a/chat/s/xxx",
      "createdAt": 1750000000000,
      "updatedAt": 1750000000000,
      "lastOpenedAt": null,             // 最近一次点击直达的时间（用于展示）
      "pinned": false
    }
  ],
  "recentClosed": [                    // 「最近关闭」归档，上限 50 条
    {
      "id": "uuid", "title": "…", "url": "…",
      "folderId": "原文件夹 id", "folderName": "原文件夹名（用于重建）",
      "parentId": "原文件夹的父级 id（恢复时定位）",
      "closedAt": 1750000000000
    }
  ],
  "settings": { "sidebarCollapsed": false, "lastImportFolderId": "" }
}
```

要点：

- **文件夹是树形结构**：`parentId` 指向父文件夹，`null` 为根目录；文件夹可无限嵌套；
  移动文件夹 = 修改 `parentId`，移动的是**整棵子树**；
- **会话是扁平数组**，`folderId` 指向其**直属**文件夹（不继承祖先的会话）；
  子树会话统计（如删除确认、目录徽标）通过 `subtreeSessionCount()` 动态汇总；
- 删除文件夹**不会删除会话**：级联删除会把整棵子树中的会话批量写入
  `recentClosed`（可恢复，防误删）；
- `recentClosed` 快照了 `folderName` 与 `parentId`：原文件夹已删除时，恢复会重建同名
  文件夹；原父级若仍存在则挂回原父级，否则放根目录；
- `lastImportFolderId` 记忆最近一次导入目标，方便连续导入；
- **同一文件夹内「同一条会话」视为重复，导入时自动跳过**（`findDuplicate`）。
  比较不按原始字符串，而是按 `utils.urlKey()` 归一化：忽略协议大小写、末尾斜杠、
  fragment 与查询参数顺序 —— 同一次会话常被写成 `.../s/abc`、`.../s/abc/`、
  `.../s/abc#frag`，不归一化就会重复保存（批次内部的重复也会被拦住）；
  带非空查询串的地址仍视为不同条目，避免误合并不同会话；
- 读取时 `migrate()` 做结构修补（旧平铺数据自动补 `parentId: null`），兼容升级。

### 4. 关键流程

#### 4.1 导入（拖拽 / 粘贴 / 文件）

```
拖拽 DeepSeek 会话按钮 / 链接 / 文本 / .txt 文件 到 导入区(或某文件夹上)
        │
        ▼
drop 事件读取 dataTransfer：uri-list + text/plain + text/html(+ 文件→FileReader)
        │
        ▼  utils.buildCandidates()：归一化 → 仅保留 *.deepseek.com 链接 → 去重
        │        ├── uri-list 每行一个链接
        │        ├── html 中的 <a href>（顺带把锚文本作为候选标题）
        │        └── 纯文本兜底（正则扫描）
        ▼
┌─ 落在明确文件夹上 ──────────────┐   ┌─ 落在导入区 / 空白处 ─────────────┐
│ store.importItems(items, fid)   │   │ 「导入会话」对话框：改名、去勾选、│
│   → 同一文件夹重复项自动跳过      │   │ 选目标文件夹 / 新建文件夹         │
└──────────────┬──────────────────┘   └──────────────┬──────────────────┘
               ▼ store.importItems(...)
        toast 结果统计 → 自动跳转目标文件夹查看
```

#### 4.2 直达、移动与层级管理

- **直达**：点击会话卡片（或其 ↗ 按钮）→ `window.open(url, '_blank', 'noopener')`，
  同时刷新 `lastOpenedAt`；
- **移动会话**：拖拽会话卡片到侧边栏文件夹 / 文件夹卡片（内部 DnD 走自定义 MIME
  `application/x-dsf-session`），或使用卡片上「移动到…」选择器；
- **移动文件夹**：文件夹卡片可拖拽（MIME `application/x-dsf-folder`）或通过
  「移动到…」选择器改变父级 —— 移动的是**整棵子树**，后代层级保持不变；
  数据层 `moveFolder()` 内置防环校验（不能移入自身 / 自己的后代），
  拖拽落点与选择器均据此拦截并提示。

#### 4.3 「最近关闭」的语义（重要设计决策）

原始需求描述“自动保存最近关闭的会话”。浏览器存在两条硬限制：

1. 跨站无法读取 / 监听 DeepSeek 标签页的状态（无 CORS、无跨标签事件）；
2. 打开的是新标签页，DSF 无法感知用户何时关掉那个标签。

因此“关闭”在 DSF 中落地为**用户在 DSF 内把某会话从文件夹中移除（卡片 ✕ / 删除文件夹）**
这一可感知事件：会话立即进入侧边栏「最近关闭」归档（上限 50），可一键恢复。
删除文件夹 = 级联删除整棵子树，子树内全部会话一并归档。恢复时按快照定位：
原文件夹（乃至原父级）仍在则回到原位；已删除则自动重建同名文件夹
（父级仍存在则挂回父级，否则放根目录），形成“文件夹-会话”双层防误删。

> 如未来接入扩展（浏览器插件），可在 DeepSeek 页面侧监听标签关闭后再回写 DSF。

#### 4.4 会话标题从哪来？

拖拽数据中若 `<a>` 锚文本可读则作为候选标题；多数情况下浏览器只暴露 URL。
跨域限制下**无法自动抓取会话首条消息作为标题**，故导入对话框允许逐条改名，
卡片上也提供重命名。这是纯前端方案下的最优解，文档与界面均给出引导。

#### 4.5 目录树的读与写

- **读**：任何时刻需要“某一层的文件夹列表”都用 `childrenOf(parentId)`
  （`null` = 根目录），不遍历全表；文件夹卡片与侧边栏目录树共用同一查询；
- **导航**：`folderChain(id)` 自底向上回溯得到祖先链 → 面包屑逐级可点；
  `folderPathLabel(id)` 生成“学习 / 数学”式路径用于选择器消歧；
- **折叠**：侧边栏目录树每行带展开 / 折叠箭头，折叠状态是纯 UI 记忆
  （会话级 Set），不落盘；`expandPathTo()` 在导航 / 恢复 / 移动后展开祖先链；
- **写操作的安全边界**：`createFolder(name, parentId)` 对无效 parentId 回退根目录；
  `moveFolder()` 防环；`deleteFolder()` 级联；导入 / 移动 / 恢复都只接受
  `childrenOf` 校验过的存在文件夹。

### 5. UI 布局与交互

```
┌────────────┬──────────────────────────────────────────┐
│  侧边栏 1/4 │  导入区（常驻：拖 DeepSeek 会话链接到此处）  │
│            ├──────────────────────────────────────────┤
│ 搜索框      │  顶栏：☰ 面包屑(全部文件夹 › 学习 › 数学)  视图操作│
│ 新建文件夹   ├──────────────────────────────────────────┤
│ ──────────  │  内容区（按视图渲染）：                    │
│ 目录树       │   · 根视图   = 根目录文件夹卡片网格(+新建) │
│ (可折叠缩进) │   · 文件夹   = 子文件夹卡片网格(+新建子文件夹) + 会话卡片网格 │
│ ──────────  │   · 搜索     = 命中的文件夹 + 会话分组      │
│ ★ 常用固定   │                                          │
│ 🕒 最近关闭  │                                          │
│ ──────────  │                                          │
│ 统计·备份    │                                          │
└────────────┴──────────────────────────────────────────┘
```

- **事件策略**：内容区、侧栏列表全部使用**事件委托**（`#content`、`#folderNav`、
  `#pinnedList`、`#recentList` 等容器只绑一次监听，按 `data-action` / `data-id` 分发），
  全量重绘不会丢失监听；目录树折叠箭头独立成 `toggle-folder` 动作，与行点击导航解耦；
- **拖拽策略**：`document` 级 `dragstart/dragover/drop` 委托，用
  `data-drop-folder` 标记落点；内部移动通过 MIME type 区分
  （`application/x-dsf-session` = 会话、`application/x-dsf-folder` = 文件夹），
  与外部链接导入区分；文件夹落点额外做“移入自身 / 后代”防环校验；
  未命中落点时一律 `preventDefault`，避免浏览器把链接/文件直接打开在标签页；
- **弹窗**：Promise 化的 `prompt / confirm / picker / textDialog / openImportDialog`，
  支持叠加、Esc 只关顶层、遮罩点击取消（取消一律 resolve null/false，无悬挂 Promise）、
  Tab 焦点陷阱（键盘不会跑到背后的主界面）、关闭后焦点归还触发元素；
  `confirm` 只接受纯文本 `message` 并强制转义（不接受 HTML，接口层面杜绝注入）；
- **重绘策略**：数据变更 → `ui.scheduleRender()` 用 `requestAnimationFrame` 合并，
  同一帧内多次变更只重绘一次；需要立即反映时用 `ui.renderNow()`；
- **明暗主题**：CSS 变量 + `prefers-color-scheme` 自动切换；
- **可访问性**：弹窗带 `role="dialog"` + `aria-labelledby`，图标按钮带 `aria-label`，
  侧边栏收起时用 `visibility` 让其中控件不再可聚焦。

### 6. 安全、隐私与数据存储

- **数据只在本机**：桌面版写 `%APPDATA%\DSF 会话夹\dsf-data.json`；网页版写浏览器
  `localStorage`（key `dsf.data.v1`）与（可选）项目目录 `dsf-data.json`。
  除用户主动打开 DeepSeek 会话外不发起任何外部请求（图标均为内联 SVG）；
- **双写与取最新**：页面同时写浏览器存储与 `/api/state`，启动时按 `savedAt` 取较新者，
  `pagehide` / `beforeunload` / 桌面版退出前 `DSF.flush()` 兜底落盘；写入失败会显式降级
  提示，绝不“静默假装保存成功”；
- 存储可写性探测使用**独立探测键**，绝不读写正式数据键——避免误删用户数据；
- **数据接口访问控制**：Host 回环校验 + Origin 同源校验 + 会话令牌（见 §2.2），
  拒绝跨站写入与 DNS rebinding；令牌只存在于服务进程与当次 HTML，磁盘文件不含密钥；
- **进程隔离**：桌面版渲染进程 `contextIsolation: true`、`nodeIntegration: false`、
  `sandbox: true`，页面拿不到任何 Node/文件系统能力；文件读写只发生在主进程，
  且服务仅监听 `127.0.0.1` 的随机端口；退出时主进程先调用页面 `DSF.flush()` 落盘再关窗；
- 内嵌服务仅托管白名单扩展名（html/css/js/json/svg/…）并拒绝目录穿越、
  隐藏目录、`node_modules` 与数据文件本身；
- 渲染前所有用户内容经 `escapeHtml` 转义，杜绝存储型 XSS；
- 打开会话仅使用 `window.open(url, '_blank', 'noopener')`（桌面版转交系统浏览器）；
- 仅接受 `*.deepseek.com` 域名的链接作为合法会话地址。

### 7. 测试

- `node --check js/*.js`：页面脚本语法检查；
- `node tests/smoke.js`：以 Node vm + localStorage/URL/DOMParser 桩加载真实
  `utils` 与 `store` 源码，覆盖链接识别、归一化去重、文件夹/会话 CRUD、导入去重、
  搜索、关闭归档、恢复、文件夹级联归档、导出/导入备份，以及子文件夹场景
  （嵌套创建 / 树查询 / 子树统计 / 移动防环 / 整树级联删除归档 /
  智能恢复定位 / 整体移动层级保持）与持久化元数据
  （savedAt 时间戳 / hydrateFrom 外部数据接入 / fileSnapshot）；
  v0.3.2 追加：`urlKey` 归一化语义、按归一化的导入去重（含批次内重复）、
  批量提交只落盘一次（用可计数的 localStorage 桩断言）、索引缓存与朴素全表扫描
  逐一对齐（含改名 / 移动后缓存重建）、级联删除的归档顺序，共 87 项断言；
- `node tests/desktop-server.js`：内嵌服务接口测试 —— 首启动自动建文件、
  `GET/PUT /api/state` 往返（含中文）、数据确实落盘、静态托管与 MIME、
  目录穿越 / 隐藏目录 / `node_modules` / 数据文件防护、非法 JSON 拒绝且不破坏原数据，
  以及 v0.3.2 的访问控制（无令牌 / 错令牌 / 跨站 Origin / 跨站预检 / 非回环 Host
  全部被拒且数据文件未被破坏、令牌确实注入 HTML 而磁盘文件不含令牌），共 23 项断言；
- `npm test`：一次跑完上面两个 Node 测试套件；
- `npm run smoke`：桌面版启动并校验数据接口（含令牌注入）；
- `npm run smoke:write` → `npm run smoke:persist`：**写入 → 新进程重启 → 校验数据仍在**
  （等待真实的落盘事件而非猜延迟；用 `--user-data-dir` 指向临时目录，不污染真实数据）；
- `python server.py` / `node desktop/server.js` + 浏览器：人工冒烟数据文件往返。

浏览器端（拖拽 DnD、渲染）建议人工按 README 的三步走冒烟一遍。

### 8. 性能与规模（v0.3.2 实测）

页面是「全量重绘 + 单一数据源」的简单结构，规模上去后真正的瓶颈只有两个，
v0.3.2 把它们都消掉了。基准数据（Node 桩环境，400 文件夹 / 2000 会话）：

| 指标 | 优化前 | 优化后 | 做法 |
| --- | --- | --- | --- |
| 侧边栏一次渲染的数据查询 | 21.4 ms | **0.28 ms** | `store` 惰性索引缓存（见下） |
| 导入 200 条链接 | 243 ms · 落盘 200 次 · 序列化 94.9 MB | **2 ms · 落盘 1 次 · 0.5 MB** | `mutate()` 批量提交 + 帧合并重绘 |
| 一次搜索（2000 会话） | 每次全表 `toLowerCase` | **0.05 ms** | 索引里预存小写检索文本 |

1. **索引缓存**：`buildIndex()` 一次性生成 `folderById / sessionById / children /
   directCount / subtreeCount / byFolder / urlKeys / selfAndDesc / 搜索文本`，
   随 `dataRev` 失效重建。修复的关键点是原 `subtreeSessionCount()` 每行都要
   重新 DFS + 全表过滤（侧边栏展开时 O(文件夹数² + 文件夹数 × 会话数)），
   而且每次键入搜索都会重跑一遍。
2. **批量提交**：`createFolder / createSession` 等自身也只包一层 `mutate()`，
   嵌套时由 `batchDepth` 抑制中间提交；因此「导入 200 条」是**一次**落盘、
   **一次**通知，而不是 200 次「全量序列化 + 同步 localStorage 写 + 全量重绘」。
3. **帧合并重绘**：`ui.scheduleRender()` 把同一帧内的多次通知合并为一次 `render()`。

规模上限仍取决于 `localStorage` 容量（约 5 MB，纯 URL 数据可存数万条）与
一次性重绘的 DOM 量；再往上应换「分段渲染 / 虚拟滚动」，而不是继续加大缓存。

### 9. 数据安全取舍（已知风险，待决策）

启动同步采用「按 `savedAt` 取最新，否则整份覆盖」：

- 先用 `file://` 或纯静态方式打开并改动过（浏览器存储的 `savedAt` 更新），
  之后再用服务器打开 → 本地那份会**整份覆盖** `dsf-data.json`，文件里原有的数据丢失；
- 多浏览器 / 多机器指向同一份数据文件时同理：谁新谁赢，且没有任何提示。

彻底解决需要把「整份覆盖」改成「按 id 求并集合并 + 冲突提示」。改动会触及
`bootstrapFileMode` 的语义与用户预期的对话框，属于产品决策，故 v0.3.2 只在文档中
标注，未改行为。

### 10. 已知限制与演进路线

| 主题 | 现状 | 演进方向 |
| --- | --- | --- |
| 会话标题 | 拖入仅得 URL，手动/锚文本命名 | 浏览器扩展读取会话内容 |
| “最近关闭”感知 | 仅在 DSF 内移除会话时归档 | 扩展在 DeepSeek 页侧监听标签关闭 |
| 会话封面/预览 | 无 | 卡片可存用户备注 |
| 排序 | 按插入顺序 | 自定义排序 / 最近打开优先 |
| 多端同步 | 本地文件 + JSON 备份 | WebDAV / 浏览器同步存储 |
| 会话搜索标题 | 标题 + URL | 备注全文索引 |
| 双写数据源冲突 | 按 `savedAt` 取最新，整份覆盖（见 §9） | 按 id 并集合并 + 冲突提示 |
| 桌面版体验 | 已可 `npm start` / 打包 exe | 托盘常驻、开机自启、自动更新、应用图标 |

---

*文档与代码保持同步：修改核心流程时请同步更新本文档与 CHANGELOG.md。*
