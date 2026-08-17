# Atlas

[![npm version](https://img.shields.io/npm/v/atlas-dashboard?color=5b9cff&label=npm&style=flat-square)](https://www.npmjs.com/package/atlas-dashboard)
[![npm downloads](https://img.shields.io/npm/dm/atlas-dashboard?color=8b95a7&label=downloads&style=flat-square)](https://www.npmjs.com/package/atlas-dashboard)
[![license](https://img.shields.io/npm/l/atlas-dashboard?color=8b95a7&style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/atlas-dashboard?color=8b95a7&style=flat-square)](https://nodejs.org/)
[![website](https://img.shields.io/badge/website-damonamber.github.io-5b9cff?style=flat-square)](https://damonamber.github.io/atlas-dashboard/)

> 本地 HTML / Markdown 文档统一浏览/管理 dashboard。
> 扫描你指定的目录里的所有 `.html` 与 `.md` 文件，提供：
> 目录树（嵌套分组、拖拽重排）· 备注名 · 未读红点 · **和上次已读版本对比** · ⌘K 快速打开 · 桌面通知 · 在访达打开 · ⌘B 收侧栏 · iframe 平滑预览 · Markdown 实时预览与编辑。

适合的场景：你让 AI 在不同项目里到处生成 HTML 报告/原型/总结，浏览器 Tab 越积越多——Atlas 把它们汇聚在一处，AI 更新过的文档会标红，看完即清。

🌐 介绍页：**https://damonamber.github.io/atlas-dashboard/**
📦 npm：**https://www.npmjs.com/package/atlas-dashboard**

---

## 安装与启动

零配置直接跑（不写到磁盘）：

```bash
npx atlas-dashboard
```

或全局安装：

```bash
npm install -g atlas-dashboard
atlas
```

第一次启动会问你三个问题（全部都有合理默认值，回车跳过即可）：

```
👋 欢迎使用 Atlas — 一次性配置后即可使用

? 要扫描哪些目录的 HTML 文件？(多个用逗号分隔，支持 ~)
  默认: ~/Documents › 
? 监听端口？
  默认: 4321 ›
? 要忽略的目录名？(逗号分隔)
  默认: node_modules,.git,dist,build,... ›
? 扫描最大深度？
  默认: 6 ›

✓ 已写入 ~/.atlas/config.json
→ http://localhost:4321
```

之后再跑 `atlas` 直接启动，不再询问。

---

## 命令

```
atlas                       前台启动（首次会引导配置；Ctrl+C 退出）
atlas start                 后台启动，立即返回，写 PID 与日志
atlas stop                  停止后台服务
atlas restart               重启后台服务
atlas status                查看运行状态（pid / url / uptime）
atlas log                   tail -f 日志（Ctrl+C 退出）
atlas init                  重新进入交互引导（仅配置，不启动）

atlas --port <n>            临时换端口（不写回配置）
atlas --root <path>         临时加扫描根（可重复，不写回配置）
atlas --config              打印配置 / 日志 / PID 文件位置
atlas --version
atlas --help
```

最常用的两组：

**临时跑一会儿（开发/调试）**：
```bash
atlas                     # 前台启动，关终端就停
```

**长期后台跑**：
```bash
atlas start               # 后台启动，关终端不影响
atlas status              # 想用时看下还活着没
atlas stop                # 不需要时停掉
```

例子：

```bash
# 临时把桌面也扫上
atlas --root ~/Desktop

# 临时换端口（4321 被别的服务占了）
atlas --port 5000

# 重新配置
atlas init

# 排查问题
atlas log                 # 实时跟随日志
```

被占用的端口会自动让位（4321 占用 → 试 4322 → ...），`atlas status` 会显示真实在跑的端口。

---

## 配置文件位置

| 平台 | 路径 |
|---|---|
| macOS / Linux | `~/.atlas/` |
| Windows | `%LOCALAPPDATA%\atlas\` |

里面是：

- `config.json` — 扫描根目录、端口、忽略列表、扫描深度
- `store.json` — 你拖拽形成的虚拟分组、备注名、已读时间、分享链接、对比底本的索引
- `versions/` — 「和上次已读版本对比」用的底本快照（每个文件最近 5 份）
- `backups/` — 编辑保存前的安全备份（每个文件最近 20 份）

不用「编辑」功能的话，Atlas 不会动你扫描根下的任何文档——只读、只预览。
用了编辑 / 重命名功能才会写盘，而且写前一定先备份到 `backups/`。

可以用环境变量 `ATLAS_HOME` 把这些挪到别的地方（比如同步盘）：

```bash
export ATLAS_HOME=~/Sync/atlas
atlas
```

---

## Dashboard 功能

- **HTML + Markdown 双模**：在 ⚙ 设置里勾选要扫描的文档类型，HTML（`.html`/`.htm`）与 Markdown（`.md`/`.markdown`）**可同时启用共存**。目录树里用不同图标 + 彩色角标（`HTML` / `MD`）一眼区分。
- **Markdown 渲染**：本地相对路径的图片正常显示；YAML front matter 渲染成元信息块而不是乱码；代码块带语言标签与一键复制；`- [ ]` / `- [x]` 是真复选框；标题 hover 出锚点链接；宽表格有独立横向滚动；**跟随系统深浅色**。含两个以上标题的长文档会自动出现**可折叠侧边目录**（按层级折叠展开、点击平滑跳转、滚动高亮当前章节，状态记忆）。
- **Markdown 编辑器**：点「编辑」进入**源码 / 预览分栏编辑器**。分栏宽度可拖拽（双击复位）、两侧滚动百分比同步、可开侧边**大纲**。**光标或选区落在一边，另一边会同步标出对应的内容块**——光标所在块用细高亮，跨块选区把覆盖到的块全部标上，两个方向都生效。回车自动续列表（有序列表序号自增、任务项续出未勾选框）、`Tab` / `Shift+Tab` 多行缩进与反缩进、`⌘B` 加粗 / `⌘I` 斜体 / `⌘K` 插链接 / `⌘E` 行内代码 / `⌘S` 保存，另有一条格式工具栏。**预览区也支持直接所见即所得编辑**，并且只重写你真正改过的那几个块——表格对齐、段落软换行、front matter 都逐字节保留，不会给 git 留下满屏无意义 diff。编辑期间自动存本地草稿，浏览器意外关闭后可恢复。保存写回原文件，带内容哈希冲突检测与自动备份（存 `~/.atlas/backups/`）。
- **和上次已读版本对比**：未读红点告诉你"AI 动过这个文件"，顶栏的**对比**按钮告诉你"动了什么"。它会拿磁盘上的当前内容和**你上次看到的那一版**逐行 diff（绿色新增 / 红色删除 / 未改动的大段自动折叠，上下文行数可调）。看完点「标记为已看过」即把当前内容设为新底本。底本在你每次打开文档时自动记录，存在 `~/.atlas/versions/`，每个文件保留最近 5 份。
- **目录树**：按你扫描根下的一级目录自动归类。可拖拽重排、新建嵌套分组、双击重命名分组。
- **预览区轻量编辑**：点工具栏「编辑」可在预览里直接改文案、拖动 `ul/ol` 列表项、表格行、以及同类卡片组（同标签+同 class、≥3 个、连续）排序，所见即所得。点入链接文字还会浮出小编辑条，可顺便改超链接地址。hover 高亮提示可编辑处；脚本/图表/代码块等风险内容自动不可编辑。保存只改你碰过的源码、其余字节不动（不会破坏图表与格式），写前自动备份（存 `~/.atlas/backups/`），取消即还原。
- **拖拽**：文件拖到任意分组（含根级别），分组拖到分组内（嵌套）。folder 不会被拖进自己内部（系统会拦截）。**拖文件悬停在折叠 folder 头上 600ms 自动展开**——直接拖进去。
- **最近打开**：侧栏顶部显示最近 10 个打开的文件，跨项目秒回。可折叠。
- **⌘K 快速打开**：模糊匹配文件名 / 备注 / 项目名（`aprt` 能命中 `api-report`），`↑↓` 选、`Enter` 打开。
- **键盘导航**：搜索框按 `↓` 进入文件列表，`↑↓` 切换，`Enter` 打开，`Esc` 回搜索框。所有弹窗支持 `Esc` 关闭，`Tab` 焦点锁在面板内。
- **未读红点**：基于文件 `mtime` 检测。点开预览即清除；右上角有"标为未读"和"全部已读"。
- **备注名**：hover 文件 → ✎ → 起一个你能记住的名字。原文件名不变。
- **重命名文件**：hover 文件 → `Aa` → 直接改磁盘上的真实文件名（备注、已读状态、分组位置都会跟着迁移）。
- **搜索**：搜索框（按 `/` 聚焦）匹配文件名 / 备注 / 路径 / 项目名，**也搜文档内容**（仅内容命中的文件会标 🔍）。空格分隔的多个关键词按"都要出现"过滤（`配网 转化率`），需要整段短语用引号（`"error rate"`）。
- **桌面通知**：⚙ 设置里勾选"桌面通知"，AI 更新 HTML 时弹系统通知。需要浏览器允许通知权限。
- **在访达 / 资源管理器中显示**：每个文件的 📂 按钮，跨平台（macOS `open -R` / Windows `explorer /select` / Linux `xdg-open`）。
- **侧边栏**：可拖拽调宽（中间 5px 拖拽条），可收起（⌘B / 顶栏左上图标）。
- **局域网分享**：hover 文件 → 🔗 → 生成不可猜的 token URL + 二维码，同 Wi-Fi 的同事扫码即看（Markdown 会展示渲染后的页面）。**默认只放行这份文档真正引用到的资源**，同目录其它文件访问不到；页面在 JS 里动态拼路径导致缺图时可切成「同目录全部资源」。**链接默认 2 小时后失效**（可选 30 分钟 / 24 小时 / 不过期），也能一键停止全部。
- **导出 PDF**：HTML 与 Markdown 都支持，调本机 Chrome / Edge / Brave headless 渲染，保存到 `~/Downloads/`。没装 chromium 系浏览器会降级到浏览器打印对话框。
- **多扫描根**：在 ⚙ 设置面板增删，立即生效。

---

## 让 AI 不要再每次打开 HTML

Atlas 解决了"散乱 + 浏览器 Tab 爆炸"，但**自动 `open xxx.html`** 是 AI 端的行为，需要你告诉它别这么做。把这条加到 `~/.claude/CLAUDE.md`（或对应 AI 工具的全局规则）：

```
生成或更新 HTML 文档后，不要执行 open / xdg-open 打开浏览器。
本机运行着 Atlas dashboard（http://localhost:4321），它会自动通过 mtime 显示未读红点。
```

---

## 跑在后台

直接 `atlas start` 即可——内置的守护进程管理已经处理好 PID、日志、健康检查、端口冲突自动切换。**不需要写 nohup/alias 这些手工脚本**。

如果想开机自启（macOS launchd 示例）：

```bash
cat > ~/Library/LaunchAgents/com.atlas.dashboard.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.atlas.dashboard</string>
  <key>ProgramArguments</key> <array>
    <string>/usr/local/bin/atlas</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>/tmp/atlas.log</string>
  <key>StandardErrorPath</key><string>/tmp/atlas.err.log</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.atlas.dashboard.plist
```

如果 `which atlas` 输出的不是 `/usr/local/bin/atlas`，把 plist 里的路径替换成你实际的（一般是 `/Users/<you>/.npm-global/bin/atlas`）。

---

## 故障排查

```bash
atlas --config              # 打印配置文件路径
cat ~/.atlas/config.json    # 看当前配置
atlas init                  # 删配置重新来一遍
rm ~/.atlas/store.json      # 重置目录树/已读状态（不影响磁盘 HTML）
ATLAS_HOME=/tmp/atlas-debug atlas init   # 用临时配置不污染主配置
```

如果 `atlas` 启动后扫不到文件，检查：
1. `~/.atlas/config.json` 里 `scanRoots` 是不是绝对路径
2. `maxDepth` 够不够（默认 6 层）
3. HTML 是否在 `ignore` 名单的目录里（`node_modules` `.git` 等）

---

## 维护者文档

- **[PUBLISHING.md](./PUBLISHING.md)** — 发版的标准流程（npm publish + GitHub Release + CI 验证）。**任何改动了发版方式的 PR 必须同步更新此文件**。
- **[.github/workflows/](./.github/workflows/)** — CI / Release 自动化配置。

## License

MIT
