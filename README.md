# Atlas

> 本地 HTML 文档统一浏览/管理 dashboard。
> 扫描你指定的目录里的所有 `.html` 文件，提供：
> 目录树（嵌套分组、拖拽重排）· 备注名 · 未读红点 · 桌面通知 · 在访达打开 · ⌘B 收侧栏 · iframe 平滑预览。

适合的场景：你让 AI 在不同项目里到处生成 HTML 报告/原型/总结，浏览器 Tab 越积越多——Atlas 把它们汇聚在一处，AI 更新过的文档会标红，看完即清。

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

里面只有两个文件：

- `config.json` — 扫描根目录、端口、忽略列表、扫描深度
- `store.json` — 你拖拽形成的虚拟分组、备注名、已读时间

不会动你扫描根下的任何 HTML 文件。Atlas 只读、只预览。

可以用环境变量 `ATLAS_HOME` 把这俩文件挪到别的地方（比如同步盘）：

```bash
export ATLAS_HOME=~/Sync/atlas
atlas
```

---

## Dashboard 功能

- **目录树**：按你扫描根下的一级目录自动归类。可拖拽重排、新建嵌套分组、双击重命名分组。
- **拖拽**：文件拖到任意分组（含根级别），分组拖到分组内（嵌套）。folder 不会被拖进自己内部（系统会拦截）。
- **未读红点**：基于文件 `mtime` 检测。点开预览即清除；右上角有"标为未读"和"全部已读"。
- **备注名**：hover 文件 → ✎ → 起一个你能记住的名字。原文件名不变。
- **搜索 / 仅未读**：搜索框（按 `/` 聚焦）匹配文件名 / 备注 / 路径。
- **桌面通知**：⚙ 设置里勾选"桌面通知"，AI 更新 HTML 时弹系统通知。需要浏览器允许通知权限。
- **在访达 / 资源管理器中显示**：每个文件的 📂 按钮，跨平台（macOS `open -R` / Windows `explorer /select` / Linux `xdg-open`）。
- **侧边栏**：可拖拽调宽（中间 5px 拖拽条），可收起（⌘B / 顶栏左上图标）。
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

## License

MIT
