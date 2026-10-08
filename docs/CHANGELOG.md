# DeepSeek Folder 更新文档（CHANGELOG.md）

本文件记录 DeepSeek Folder 每个版本的功能变更与修复。
版本号遵循 `主.次.修订`；未发布计划见文末「规划中」。

---

## [v0.5.2] — 2026-10-08 · 启动诊断与自检日志

用户反馈“这一版连启动都不行”，而 GUI 版 exe 的 stdout 捕获不到、无法定位，
因此把**取证能力**做进应用与脚本。

### 新增
- **主进程启动日志**：`%APPDATA%\DeepSeek Folder\startup.log`（UTF-8 带 BOM，
  PowerShell 可正常显示），记录版本 / argv / execPath / `ELECTRON_RUN_AS_NODE` /
  userData / 全部 console 输出，并捕获 `uncaughtException` 与 `unhandledRejection`
  堆栈；日志路径不依赖 electron 的 app 对象，**即使 Electron 没起来也会先写日志**；
- **诊断启动器** `run-deepseek-folder.cmd`：清除 `ELECTRON_RUN_AS_NODE`、
  打开 `ELECTRON_ENABLE_LOGGING`、把输出写入 `dsf-run.log`，并自动附上应用
  `startup.log` 末尾 40 行 —— 双击一次即可拿到完整现场；
- 自检场景下日志跟随 `--user-data-dir` 隔离，不污染真实目录。

### 修复
- 上一版诊断启动器误用中文导致 cmd 解析错乱（与早前 `start-dsf.cmd` 同类问题），
  已改为**纯 ASCII**。

---

## [v0.5.1] — 2026-09-28 · 悬浮窗加载加固 + 诊断模式

针对“悬浮窗没有显示为窗体，而是显示一串 HTML 源码”这类现象做加固与排查工具。

### 变更
- **悬浮窗改经内嵌服务加载**：`http://127.0.0.1:<port>/desktop/quick.html`
  （服务对 `.html` 显式返回 `text/html; charset=utf-8`），不再依赖 Chromium 对
  `file://` 的 MIME 推断；失败时回落到 `loadFile` 并打印实际加载方式；
- **新增诊断模式** `npm run diagnose:quick`（`--diagnose-quick`）：打开悬浮窗并打印
  真实状态 —— 加载方式 / `document.contentType` / URL / 窗口位置与可见性 /
  `pill` 圆角与背景 / 正文前 120 字，用于出现异常时直接取证；
- **自检补强**：`smoke:quick` 增加两条断言 —— `document.contentType === 'text/html'`
  与“样式已生效（圆角胶囊渲染正常）”，共 12 项，防止该类问题静默回归；
- `.gitignore` 增加 `.tmp-*/` 与 `tests/.tmp-*`（自检残留）。

### 排查结论（本机实测）
- 开发环境与 asar 打包环境下，`loadFile` 与内嵌服务**都**返回 `text/html`，
  悬浮窗渲染正常（诊断输出：`contentType=text/html`、`pill` 圆角 12px、
  背景 `rgba(23,27,34,0.93)`、正文为“拖入链接”）；
- 因此若仍出现源码文本，请运行 `npm run diagnose:quick` 并把输出发回，
  其中 `加载方式` 与 `contentType` 两行即可定位问题所在。

---

## [v0.5.0] — 2026-09-27 · 项目更名：DSF → DeepSeek Folder

整个项目更名：英文主名 **DeepSeek Folder**（中文副名「DeepSeek 会话夹」），
代码命名空间 **DSF → DF**，GitHub 仓库更名为 `deepseek-folder`。

### 变更
- **程序名**：窗口标题、托盘/安装包/exe 名（`DeepSeek Folder 0.5.0.exe`）、
  NSIS 快捷方式名、应用 ID（`com.deepseekfolder.app`）、npm 包名（`deepseek-folder`）；
- **界面**：侧边栏品牌名改为 DeepSeek Folder（副标题「会话夹 · 本地优先」）、
  欢迎文案、悬浮窗标题（“DeepSeek Folder 快速导入”）；
- **文件**：`js/dsf.*.js → js/df.*.js`、`start-dsf.cmd/.sh → start-deepseek-folder.cmd/.sh`
  （均用 `git mv` 保留历史）；
- **技术标识**：全局命名空间 `window.DF`、localStorage key `deepseek-folder.data.v1`、
  数据文件 `deepseek-folder-data.json`、MIME（`application/x-deepseek-folder*`）、
  IPC 通道（`deepseek-folder:quick-*`）、令牌头 `X-DeepSeek-Folder-Token`、
  令牌占位符 `__DEEPSEEK_FOLDER_TOKEN__`、环境变量 `DEEPSEEK_FOLDER_PORT` /
  `DEEPSEEK_FOLDER_NO_BROWSER`、日志前缀 `[deepseek-folder]`、备份文件前缀
  `deepseek-folder-backup-`；
- **文档**：README / ARCHITECTURE / CHANGELOG 全面更名，新增「从旧版本升级」章节。

### 兼容与迁移（重要：旧数据不会丢）
改名会改变三处持久化位置，均已实现**自动迁移**（复制而非移动，旧文件保留）：

| 旧位置 | 新位置 | 迁移实现 |
| --- | --- | --- |
| `%APPDATA%\DSF 会话夹\dsf-data.json` | `%APPDATA%\DeepSeek Folder\deepseek-folder-data.json` | 桌面版启动时 `migrateLegacyUserData()`（设置文件一并迁移） |
| 项目目录 `dsf-data.json` | `deepseek-folder-data.json` | `server.py` / `desktop/server.js` 启动时迁移 |
| localStorage `dsf.data.v1` | `deepseek-folder.data.v1` | 页面加载时读旧键并写入新键，随后提示“已迁移” |

### 建议操作
- 桌面版用户：先卸载旧版「DSF 会话夹」再安装新版（应用 ID 已变更），
  首次启动会自动把数据搬到新目录；
- GitHub 旧地址 `Kmex09/dsf-session-folder` 会自动跳转到新地址。

---

## [v0.4.0] — 2026-09-27 · 快速导入悬浮窗（桌面版）

解决“从浏览器拖链接时，主窗口被挡住/最小化导致无法导入”的问题：新增一个
**始终置顶的迷你窗**，把链接拖进去即自动唤起主窗口完成导入。

### 新增
- **快速导入悬浮窗**：无边框胶囊小窗（168×66），`alwaysOnTop('floating')` +
  不占任务栏；顶部细条可拖动位置，位置会被记住并自动夹回可见工作区；
- **显隐规则**：开关开启后，**主窗口不在前台**（最小化 / 被浏览器挡住）时自动出现，
  主窗口一旦获得焦点立即隐藏，不遮挡应用本体；
- **拖入即导入**：悬浮窗复用网页版同一套 `DeepSeek Folder.utils` 规则识别 DeepSeek 链接，
  松手后把原始数据交给主进程 → 主进程 `restore()` 唤起主窗口 → 页面复用既有
  拖放导入流程（在文件夹视图内直接存进该文件夹，否则弹出导入对话框）；
- **手动开关**：主界面侧边栏底部新增「悬浮窗」按钮（仅桌面版显示，开启时高亮），
  悬浮窗自带的 ✕ 也能关闭并同步按钮状态；
- **状态持久化**：开关与窗口位置存于 `%APPDATA%\DeepSeek Folder\desktop-settings.json`，
  重启应用后保持；
- **点击悬浮窗**（非拖放）即唤起主窗口；
- **自检**：新增 `npm run smoke:quick` —— 9 项检查（初始关闭 / 前台时不显示 /
  开关落盘 / 最小化后置顶可见 / **悬浮窗页面加载成功（含链接解析）** /
  拖入后唤醒主窗 / 页面收到数据 / 状态持久化 / 关闭后隐藏）。

### 技术备注
- 新增 `desktop/quick.html`、`desktop/quick.js`、`desktop/quick-preload.js`、
  `desktop/preload.js`（主窗口）；
- IPC 通道：`deepseek-folder:quick-get / deepseek-folder:quick-set / deepseek-folder:quick-close / deepseek-folder:quick-drop /
  deepseek-folder:restore-main / deepseek-folder:quick-changed / deepseek-folder:quick-import`，
  转发内容做长度截断（uri-list 20KB、文本 200KB）；
- 渲染进程仍为 `contextIsolation + sandbox`，仅通过 `contextBridge` 暴露最小 API；
  网页版没有 `window.dfDesktop`，整段桌面逻辑特性检测后直接跳过，页面行为不变。

---

## [v0.3.2] — 2026-09-27 · 数据接口加固 + 规模性能

对全量代码做了一次系统性走查，修掉一个安全问题与两处性能架构成本，
并补齐一批交互/可访问性细节。**页面功能与数据格式完全兼容，无需迁移。**

### 安全（重要）
- **修复：本地数据接口可被任意网站静默覆盖**。`/api/state` 此前无任何鉴权，
  恶意网页可用简单请求（`Content-Type: text/plain`，不触发 CORS 预检）直接
  PUT 覆盖 `deepseek-folder-data.json` —— 响应虽读不到，破坏却已落地（已实测复现）。
  现两个后端统一做三层校验：**Host 必须是回环地址**（防 DNS rebinding）、
  **Origin 必须同源**、**必须携带本次会话令牌 `X-DeepSeek-Folder-Token`**。
  令牌由服务端渲染 `index.html` 时替换 `__DEEPSEEK_FOLDER_TOKEN__` 占位符注入，
  页面从 `<meta name="df-token">` 读取即可，**正常使用完全无感**；
  磁盘上的 `index.html` 不含任何密钥；
- 拒绝请求时先回完整响应再断连——否则客户端会因“请求体未发完”与服务端互相等待
  （在 Node `fetch` 上可稳定复现该僵死）；
- `server.py` 补上此前文档声称有、实际缺失的静态托管防护：
  目录穿越 / 隐藏目录 / `node_modules` / **数据文件本身**（`GET /deepseek-folder-data.json` 也拒绝）；
- 静态资源补 `X-Content-Type-Options: nosniff`；Python 侧文本资源统一带 `charset=utf-8`。

### 性能（400 文件夹 / 2000 会话实测）
- **侧边栏渲染的数据查询 21.4 ms → 0.28 ms**：`store` 引入惰性索引缓存
  （`childrenOf / subtreeSessionCount / folderSessionCount / getFolder / getSession /
  搜索` 全部走索引，随 `dataRev` 失效重建），修掉原「每行都重新 DFS + 全表过滤」的
  O(文件夹数² + 文件夹数 × 会话数) 开销；
- **导入 200 条链接 243 ms → 2 ms，落盘 200 次 → 1 次，序列化 94.9 MB → 0.5 MB**：
  新增 `mutate()` 批量提交上下文，批量操作整批只落盘一次、只通知一次；
- 重绘改为 `ui.scheduleRender()` 帧合并，同一帧内多次数据变更只重绘一次；
- 搜索索引里预存小写检索文本，2000 会话下单次搜索 0.05 ms。

### 修复
- **同一次会话不再被重复保存**：导入去重改按 `utils.urlKey()` 归一化比较，
  忽略尾斜杠 / `#fragment` / 查询参数顺序（`.../s/abc`、`.../s/abc/`、
  `.../s/abc#frag` 现在视为同一条），批次内部的重复也会被拦住；
  带非空查询串的地址仍视为不同条目，避免误合并；
- 启动时不再连续触发多次全量渲染；启动同步完成前不向后端写，避免竞态覆盖；
- 桌面版退出前调用页面 `DeepSeek Folder.flush()` 落盘后再关窗，修掉「最后一次改动还在 600ms
  防抖等待中就退出」导致的数据丢失；`npm run smoke:write` 也改为等待真实落盘事件；
- 级联删除文件夹后，「最近关闭」的归档顺序不再被反转；
- `confirm` 弹窗只接受纯文本并强制转义（原先的 `messageHtml` 未转义）；
- 导入区去掉重复的点击监听与 `stopPropagation`；清掉 `'__content__'` 死分支；
  `normalizeUrl` 去掉恒真的冗余协议判断；`clampTitle` 截断长度不再超出 `max`。

### 体验与可访问性
- 弹窗新增 Tab 焦点陷阱、`aria-labelledby`，关闭后焦点归还触发元素；
  弹窗内再开新弹窗时不会互相抢焦点；
- 卡片图标按钮补 `aria-label`；侧边栏收起后其控件不再能被 Tab 聚焦；
- 桌面版数据文件写入改用唯一临时名（并发写不再互相截断）；Python 侧同理；
- `package.json` 新增 `npm test`（一次跑两个 Node 测试套件）；版本号对齐 `0.3.2`。

### 测试
- `tests/smoke.js` 64 → **87 项**：新增 `urlKey` 语义、按归一化去重（含批次内重复）、
  批量提交只落盘一次（可计数的 localStorage 桩）、索引缓存与朴素全表扫描逐一对齐
  （含改名 / 移动后的缓存重建）、级联删除归档顺序；
- `tests/desktop-server.js` 12 → **23 项**：新增访问控制全套
  （无令牌 / 错令牌 / 跨站 Origin / 跨站预检 / 非回环 Host 均被拒且数据未被破坏、
  令牌确实注入 HTML 而磁盘文件不含令牌、数据文件不经静态托管外泄）。

---

## [v0.3.1] — 2026-09-21 · 应用图标

- 新增 `tools/make_icons.py`：用一张图片一键生成全套图标
  （居中裁方 → LANCZOS 缩放 → EXIF 旋正；控制台编码兜底）；
- 应用图标改为指定图片：`build/icon.ico`（多尺寸 16/24/32/48/64/128/256，
  打包 exe 与安装包使用）、`assets/icon-256.png`（窗口 / 任务栏）、
  `assets/icon-64.png`（网页 favicon）、`assets/icon-512.png`（备用大图）；
- `package.json` 增加 `build.win.icon` 与 NSIS 安装/卸载图标、快捷方式名称；
  `build.files` 纳入 `assets/**`；
- `desktop/main.js` 为窗口设置图标；`index.html` favicon 由内联 SVG 改为 PNG。

---

## [v0.3.0] — 2026-09-21 · 桌面版（Electron）：零操作的本地存储

按“扩展技术栈、让本地存储更简便”的需求，新增 Electron 桌面版：**页面代码零改动**，
数据自动落到用户数据目录，不需要浏览器存储、不需要授权、不需要保持黑窗。

### 新增
- **桌面应用**：`npm install && npm start` 即可打开；
  主进程内嵌 `desktop/server.js`（与 `server.py` 同接口），窗口加载
  `http://127.0.0.1:<随机端口>/`，前端自动进入“数据文件”模式（侧栏显示绿色）；
- **数据位置**：`%APPDATA%\DeepSeek Folder\deepseek-folder-data.json`（macOS/Linux 为对应 userData 目录），
  与安装位置解耦，升级 / 重装不影响数据；
- **外链分流**：会话卡片、页面内 http(s) 跳转统一交给系统默认浏览器
  （`setWindowOpenHandler` + `will-navigate` 拦截）；
- **导出备份**改为弹出系统“另存为”对话框；关闭页面权限请求（更安全）；
- **单实例锁**：重复启动只聚焦已有窗口；随机端口避免与 `server.py` 抢 8000；
- **快捷键补齐**（无菜单栏）：`F5`/`Ctrl+R` 刷新、`F12` 开发者工具、`F11` 全屏、`Ctrl+W` 关闭；
- **Node 版服务器**：`node desktop/server.js [端口]` 可替代 `python server.py`（无需 Python）；
- **打包**：`npm install -D electron-builder && npm run dist` 生成便携版 / 安装包（`dist/`）；
- **自检脚本**：`npm run smoke`（启动 + 接口校验）、
  `npm run smoke:write` + `npm run smoke:persist`（写入 → 新进程重启 → 校验数据仍在，
  使用 `--user-data-dir` 临时目录，不污染真实数据）。

### 修复
- `start-deepseek-folder.cmd` 此前含中文 + `chcp 65001`，在中文 Windows 上会被 cmd 代码页解析错乱、
  双击后黑窗闪退；已改为**纯 ASCII 单窗口前台运行**，出错时窗口保留错误信息，
  并自动尝试 `python` / `python3` / `py`。

### 技术备注
- 依赖仅 `electron`（devDependency），前端仍为零依赖经典脚本；
- 渲染进程 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`，
  文件读写仅存在于主进程；
- 新增测试：`tests/desktop-server.js`（内嵌服务 12 项断言，含目录穿越防护）。

---

## [v0.2.2] — 2026-09-04 · 持久化加固与自检

针对“重启电脑后数据消失”的排查，加固服务器模式的可观测性：

- **数据文件开机即建**：`server.py` 首次启动自动创建 `deepseek-folder-data.json`（空数据）。
  只要看到项目目录里有该文件，就说明你正处于“文件级持久化”模式；
- **重启后的正确用法**：每次重启电脑后需**再次双击 `start-deepseek-folder.cmd`** 打开
  （数据文件在硬盘上，不会被重启清掉；浏览器本地存储才可能被浏览器清空）；
- **写入失败不再静默**：数据文件写入失败时页面会切换存储标识并弹提示
  （绿=数据文件 / 灰=浏览器存储 / 橙=仅本次会话），杜绝“以为保存了其实没有”；
- **file:// 引导条**：若直接双击 `index.html` 打开，页面顶部显示醒目提示，
  引导改用一键启动脚本（该模式持久化依赖浏览器，重启有丢失风险）；
- `start-deepseek-folder.cmd` 改为**单窗口前台运行 + 纯 ASCII 内容**：修复了此前批处理内含中文
  且 `chcp 65001` 导致脚本解析错乱、双击后黑窗一闪即退的问题；出错时窗口会停在
  屏幕前显示错误，兼容更多 Python 安装方式（python / python3 / py）；
- `server.py` 启动后自动打开默认浏览器（可用环境变量 `DEEPSEEK_FOLDER_NO_BROWSER=1` 关闭）。

### 排查指引（存疑时自检）
1. 双击 `start-deepseek-folder.cmd` 后，确认弹出的黑色窗口显示“DeepSeek Folder 服务器已启动”；
2. 确认项目目录出现 `deepseek-folder-data.json`（本次更新后首次启动即自动生成）；
3. 页面上建一个文件夹，等 1 秒后查看该文件的修改时间是否更新；
4. 侧边栏底部应显示绿色“自动保存到数据文件 deepseek-folder-data.json”。

---

## [v0.2.1] — 2026-09-04 · 持久化修复 + 数据文件自动保存

修复重新打开页面后数据丢失的问题，并提供不依赖浏览器的文件级持久化。

### 修复
- **（根因）加载时误删数据**：此前每次启动都会用“可写性探测”写入又删除
  localStorage，但探测用的正是正式数据键 `deepseek-folder.data.v1` —— 若该次会话未再产生任何
  保存，重开页面时已保存的数据会被探测逻辑清空。现已改用**独立探测键**，
  正式数据在加载 / 探测过程中不再被写入或删除。
- **落盘回滚**：每次真实保存才盖 `savedAt` 时间戳；写入失败时回滚时间戳并切换提示，
  避免“以为保存了其实没有”的误导。

### 新增
- **`server.py` 数据文件后端**：一键启动脚本（`start-deepseek-folder.cmd` / `start-deepseek-folder.sh`），
  除托管页面外，通过 `GET/PUT /api/state` 把每次改动**原子写入项目目录的
  `deepseek-folder-data.json`**——换浏览器、清缓存、换端口都不丢数据（真正的“本地记忆”）；
- **自动取最新**：启动时比较浏览器存储与数据文件的 `savedAt`，本地为空则直接采用
  文件数据，本地更新则同步回写文件；刷新 / 关页前用 `pagehide` 兜底落盘；
- **存储状态指示**：侧边栏底部实时显示存储模式（绿=数据文件 / 灰=浏览器存储 /
  橙=仅本次会话）；浏览器拒绝存储且未连接数据文件时给出醒目提示与改用指引；
- 数据文件采用临时文件 + 原子替换写入，避免写到一半损坏。

### 技术备注
- 数据模型新增 `savedAt`（最近一次成功保存时间）；store 新增 `hydrateFrom() /
  fileSnapshot()`；冒烟测试扩至 **64 项断言**（新增 savedAt 与外部数据接入）。

---

## [v0.2.0] — 2026-09-04 · 子文件夹（目录树）

目录深度不再受限：任何文件夹内部都可以继续创建子文件夹，形成任意层级的树形目录。

### 新增
- **嵌套文件夹**：文件夹视图内新增「子文件夹」区块与「＋ 子文件夹」入口，
  进入某文件夹后可继续新建下一级子文件夹（无限层级）；
- **侧边栏目录树**：文件夹导航树按层级缩进展示，带展开 / 折叠箭头（会话内记忆），
  导航时自动展开祖先链并高亮当前文件夹；
- **移动文件夹**：文件夹卡片与顶栏新增「移动到…」，可把文件夹（含整棵子树）
  移动到其它文件夹或根目录；选择器中显示目标路径与子树会话数；
- **拖拽移动文件夹**：文件夹卡片本身可拖拽，拖到侧边栏目录 / 文件夹卡片即可移动；
- **防环保护**：禁止把文件夹移动到自己或自己的后代之下（拖拽与选择器均拦截并提示）；
- **级联删除**：删除文件夹会删除整棵子树；子文件夹里的会话同样进入「最近关闭」，
  删除确认框会明示将影响的子文件夹数与会话数；
- **智能恢复定位**：「最近关闭」记录增加 `parentId` 快照，恢复会话时若原父级仍在，
  会话回到原位置；父级也已删除则自动重建同级文件夹后放入；
- **展示增强**：面包屑显示完整祖先链（可点击跳回任意层级）；文件夹卡片与顶栏
  展示「n 个会话 · m 个子文件夹」；根视图统计包含子文件夹的总数；
- 导入目标选择器 / 移动选择器以路径（如 `学习 / 数学`）消歧同名文件夹。

### 修复
- 无（相对 v0.1.0 无回归；v0.1.0 的平铺数据在升级后自动按根目录文件夹读取，
  `parentId` 缺失自动补 `null`）。

### 技术备注
- 数据模型：`folders[].parentId`（`null` = 根目录），`recentClosed[].parentId`；
- store 新增：`childrenOf / subtreeFolderIds / subtreeSessionCount / folderChain /
  folderPathLabel / moveFolder / childrenFolderCount`；
- 冒烟测试扩至 **60 项断言**（新增子文件夹创建 / 树查询 / 子树统计 / 移动防环 /
  级联删除归档 / 智能恢复 / 整体移动层级保持）。

---

## [v0.1.0] — 2026-09-04 · 首个可运行版本

依据 `AGENT.txt` 需求完成从零到可用的全部核心功能。

### 新增

**导入与链接**
- 顶部常驻**导入区**：把 DeepSeek 会话按钮 / 链接 / 整段文字 / 文本文件拖入即触发导入；
- **粘贴链接导入**：多行文本框，自动从任意文字中识别 DeepSeek 链接；
- 链接归一化：容忍 URL 后粘连的中英文标点、相邻中文文本；仅接受 `*.deepseek.com`；
- 导入对话框：逐条改名、勾选是否导入、选择目标文件夹、就地新建文件夹；
- 同文件夹重复链接自动跳过（导入结果 toast 汇报：导入 / 重复 / 无效数量）。

**文件夹管理（右侧 3/4 文件管理区）**
- 文件夹网格视图（含「新建文件夹」虚线卡片入口）；
- 文件夹创建 / 重命名 / 删除；删除时其中会话自动转入「最近关闭」，不丢失；
- 面包屑导航（全部文件夹 › 名称），顶栏操作：固定 ☆ / 重命名 / 删除 / 会话数。

**会话管理**
- 会话卡片：标题 + 域名 + 相对时间（创建 / 最近打开）；
- 单击卡片或 ↗ 按钮在新标签页直达原会话，并记录访问时间；
- 重命名、点亮 ☆ 固定、「移动到…」选择器、✕ 关闭（转入最近关闭）；
- 跨视图移动：会话卡片可拖到侧边栏任一文件夹 / 文件夹卡片上。

**侧边栏（左侧 1/4，参考 DeepSeek / DSH 原生 UI）**
- 文件夹导航树（含会话数徽标、当前文件夹高亮）；
- **常用固定**：手动 pin 的文件夹与会话集中展示，支持一键取消；
- **最近关闭**：自动归档被关闭 / 随文件夹删除的会话（上限 50），
  可一键恢复到原文件夹（文件夹已删则自动重建同名文件夹），支持单条/全部清理；
- 顶部搜索框：实时过滤文件夹与会话（标题 / 链接 / 名称）；底部统计与备份入口。

**数据与体验**
- localStorage 持久化（`deepseek-folder.data.v1`），数据变更自动保存并即时重绘；
- JSON 备份导出 / 导入（整体覆盖，导入前二次确认）；
- 空状态引导（三步上手）、Toast 反馈、明暗双主题随系统自动切换、
  纯内联 SVG 图标零外链；所有用户内容渲染前转义。

### 修复
- 无（首个版本）。

### 技术备注
- 纯 HTML/CSS/JS（ES5 语法、经典脚本），无框架 / 无构建 / 无外部依赖，
  兼容 `file://` 直接双击打开；
- `tests/smoke.js`：36 项无浏览器冒烟断言（链接解析 + 数据层全流程）。

---

## 规划中（未发布）

- [ ] 会话自定义备注与收藏备注搜索
- [ ] 文件夹内手动排序 / “最近打开优先”
- [ ] 会话标题自动抓取（需浏览器扩展配合，见 ARCHITECTURE.md §8）
- [ ] 拖拽文件夹排序
- [ ] 中英文双语界面
