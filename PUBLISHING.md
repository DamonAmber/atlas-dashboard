# Atlas 发版流程

> ⚠️ **这是 AI 与人类共同维护的标准流程文档**。
>
> - 任何流程变更（新工具、新步骤、新自动化、新 hook）**必须同步更新本文档**。
> - 下次发版时如果发现本文档与实际不符，**先修文档再发版**。
> - 这是约束，不是建议。

仓库：https://github.com/DamonAmber/atlas-dashboard
npm：https://www.npmjs.com/package/atlas-dashboard

---

## 目录

- [TL;DR — 标准发版命令序列](#tldr--标准发版命令序列)
- [前置检查（每次发版前）](#前置检查每次发版前)
- [决定版本号](#决定版本号)
- [详细发版步骤](#详细发版步骤)
- [自动化（你不用管）](#自动化你不用管)
- [验证发版成功](#验证发版成功)
- [故障排查](#故障排查)
- [紧急回滚](#紧急回滚)
- [一次性环境配置](#一次性环境配置)
- [给未来 AI / 自己的话](#给未来-ai--自己的话)
- [已发布版本](#已发布版本)

---

## TL;DR — 标准发版命令序列

适用：你已经做完代码改动 + 跑过测试 + 改过 `PUBLISHING.md` 加了新版描述。

```bash
cd ~/Documents/AIProjects/Atlas

# 1. 升版本号（手动改 package.json，或用下面的 node 一行）
NEW_VERSION="0.x.y"   # 替换成实际新版本号
node -e "const p=require('./package.json'); p.version='$NEW_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n');"

# 2. 看清单（不真发）
npm publish --dry-run

# 3. 真发布到 npm（已配 token，免 OTP）
npm publish

# 4. 验证 registry 同步
npm view atlas-dashboard version

# 5. push 到 GitHub（CI 会自动跑测试）
git add -A
git commit -m "feat/fix: <一句话描述本版改动>"
git push

# 6. 创建并推送 tag → 自动触发 GitHub Release workflow
git tag "v$NEW_VERSION"
git push origin "v$NEW_VERSION"

# 7. 升级本机的全局 atlas（让未来发版时 update-check 基准是新版）
npm install -g atlas-dashboard@latest
atlas --version   # 应显示新版本号
```

发完之后**必看**：[验证发版成功](#验证发版成功) 章节确认 4 项绿。

---

## 前置检查（每次发版前）

```bash
# 你必须能给出"是"的几个问题：
git status                          # 工作区干净？
git rev-parse --abbrev-ref HEAD     # 当前在 main 分支？
gh auth status                      # gh CLI 已登录？
npm whoami                          # npm 已登录？(应输出 d4monwang)
grep authToken ~/.npmrc             # token 已配置？(应输出 1 行)
atlas status                        # atlas 服务在跑？(测试需要)
```

如果任意一项不对，停下来修，不要发版。

---

## 决定版本号

按 [SemVer](https://semver.org/) 严格执行：

| 类别 | 当前 → 目标 | 触发条件 |
|---|---|---|
| **patch** | `0.3.0` → `0.3.1` | 仅 bug 修复、文案微调、CSS 微调 |
| **minor** | `0.3.x` → `0.4.0` | 新功能、新 CLI 子命令、新 API 端点（向后兼容） |
| **major** | `0.x.x` → `1.0.0` | 破坏性变更（配置 schema / CLI 参数 / 默认行为） |

**有疑问就升 minor**——多发一个版本号比留下混乱便宜。

> 当前版本：见 [已发布版本](#已发布版本) 第一行；或 `node -p "require('./package.json').version"`

---

## 详细发版步骤

### 步骤 0：跑全套测试

测试都依赖一个本地运行的 Atlas 服务（默认 `:4321`）。

```bash
# 确保服务在跑且用最新代码（不是 npm 包里的旧版）
atlas stop
lsof -ti :4321 | xargs kill 2>/dev/null
node bin/atlas.js > /tmp/atlas-dev.log 2>&1 &
sleep 2
curl -sf http://localhost:4321/api/state >/dev/null && echo "服务 OK"

# 跑全部 spec
for spec in tests/*.spec.js; do
  echo "=== $spec ==="
  node "$spec" 2>&1 | tail -3
done
```

**要求所有 spec 都"失败 0 项"**。任意一个失败必须先修才能发版。

> 当前 spec 清单（14 个）：
> - `inline-edit.spec.js` — 编辑文件名 / 备注（17 项）
> - `sidebar.spec.js` — 侧边栏开关、宽度、动画（5 项）
> - `sidebar-perf.spec.js` — 帧率门槛（p95 ≤ 25ms / max ≤ 50ms）
> - `scroll-stuck.spec.js` — 拖 resizer 不卡死（8 项）
> - `scroll-after-toggle.spec.js` — 滚动到中间后切侧栏不卡
> - `drag-stress.spec.js` — 连续随机拖拽不死循环
> - `drag-to-root.spec.js` — 文件拖到根目录不卡
> - `drag-hover-expand.spec.js` — 拖到折叠 folder 头上 600ms 自动展开（6 项）
> - `no-sortable-leak.spec.js` — Sortable 实例不累积（5 项）
> - `v0.2-features.spec.js` — 键盘导航 / 最近打开 / 全文搜索（15 项）
> - `click-with-jitter.spec.js` — 点击带抖动仍能打开（5 项）
> - `search-cn-and-highlight.spec.js` — 中文单字搜索 + iframe 内高亮跳转（13 项）
> - `landing-demo.spec.js` — landing page demo 交互（27 项，file://，不依赖服务）
> - `e2e-install.spec.js` — npm pack + 模拟陌生用户安装

### 步骤 1：更新 PUBLISHING.md

在本文档底部 [已发布版本](#已发布版本) 列表**最上方**加一条新版本描述。格式严格匹配：

```markdown
- **<版本号>** (<YYYY-MM-DD>) — <一段 fix/feat 类描述，可含①②③ 编号。具体到改了什么文件、为什么、对用户的影响>。
```

**重要**：必须用 `- **<X.Y.Z>**` 这种格式（前面短横线、版本号用双星号包裹），因为 GitHub Release workflow 用 awk 按这个 pattern 抽取本版变更日志。

### 步骤 2：升 package.json 版本号

```bash
NEW_VERSION="0.x.y"
node -e "const p=require('./package.json'); p.version='$NEW_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n');"
node -p "require('./package.json').version"   # 确认
```

> 不用 `npm version patch`，因为它会自动 git commit + tag。我们要分开做，让流程更可控。

### 步骤 3：dry-run 预览

```bash
npm publish --dry-run
```

检查输出：
- `name: atlas-dashboard`
- `version: <新版本>`
- `total files:` 应在 11~15 之间（bin/lib/public/server/README/LICENSE）
- 不应含 `tests/`、`data/`、`*.tgz`、`config.json`（这些在 `package.json` 的 `files` 白名单外）

### 步骤 4：真实发布

```bash
npm publish
```

期望最后一行是 `+ atlas-dashboard@<新版本>`。

> 当前账号配置了 **Granular Access Token with bypass 2FA**（写到 `~/.npmrc`），所以**不需要 OTP**。如果 token 失效（403）或被撤销，去 https://www.npmjs.com/settings/d4monwang/tokens 重新生成。

### 步骤 5：commit + push

```bash
git add -A
git status -s   # 确认改动范围
git commit -m "$(cat <<'EOF'
feat/fix(<scope>): <概括，不超过 72 字符>

<空行>

<主体段，详细说明动机、做法、测试覆盖>
EOF
)"
git push
```

GitHub Actions `tests` workflow 会自动跑（push 触发）。**等它绿**再继续。看状态：

```bash
gh run list --limit 1
gh run watch   # 实时跟随最新 run（可选）
```

### 步骤 6：打 tag → 自动创建 GitHub Release

```bash
git tag "v$NEW_VERSION"
git push origin "v$NEW_VERSION"
```

`release` workflow 在 ~10 秒内自动：
1. 从 `PUBLISHING.md` 用 awk 抽取该版本的描述段
2. 调 `gh release create` 创建 Release
3. body 含变更日志 + npm 链接 + 网站链接 + 安装命令

验证：

```bash
sleep 10
gh release view "v$NEW_VERSION"   # 看 body 是否正确
```

### 步骤 7：本机升级到新版

```bash
npm install -g atlas-dashboard@latest
atlas --version    # 应显示新版本号
atlas restart      # 让本机服务也用新版
```

---

## 自动化（你不用管）

每次发版自动发生的事，列在这里方便调试：

| 触发 | Workflow | 做什么 |
|---|---|---|
| `git push` 到 main | `.github/workflows/test.yml` | CLI smoke + landing demo + e2e install + 6 个服务依赖 spec（用 fixture HTML） |
| `git push origin v*` (tag) | `.github/workflows/release.yml` | 抽取 PUBLISHING.md 该版本段落 → 创建 GitHub Release |
| 任何 push 到 main | GitHub Pages（仓库设置） | 自动重新部署 `docs/` 到 https://damonamber.github.io/atlas-dashboard/ |
| `npm publish` | npm registry | 包上架 + CDN 同步（约 1-2 分钟） |
| 任意时刻已安装的用户 `atlas start/status` | （客户端逻辑 v0.3.0+） | 后台查 npm registry，发现新版即在终端框格提示 |
| 已安装的用户访问 dashboard | （客户端逻辑 v0.3.0+） | 顶栏右侧脉动小标签 + 点击复制升级命令 |

---

## 验证发版成功

发版后必须 4 项都绿才算完成：

```bash
# ① npm registry 已同步
test "$(npm view atlas-dashboard version)" = "$NEW_VERSION" && echo "✓ npm"

# ② GitHub Release 已自动创建
gh release view "v$NEW_VERSION" >/dev/null 2>&1 && echo "✓ GitHub Release"

# ③ tests workflow 通过
LATEST_RUN=$(gh run list --limit 1 --json conclusion --jq '.[0].conclusion')
test "$LATEST_RUN" = "success" && echo "✓ CI tests"

# ④ landing page 已更新（curl 看版本号）
curl -sL "https://damonamber.github.io/atlas-dashboard/?_=$(date +%s)" | grep -q "$NEW_VERSION" && echo "✓ landing page"
```

注意 ④ 需要等 GitHub Pages 重新部署（约 1-2 分钟）。

---

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `npm publish` → 401 Unauthorized | token 过期或被 revoke。重新生成 Granular Token（勾 bypass 2FA），写回 `~/.npmrc`：`npm config set //registry.npmjs.org/:_authToken <new_token>` |
| `npm publish` → 403 Two-factor authentication | token 没勾 bypass-2FA。重生成时确保勾上 **"Bypass two-factor authentication when publishing packages"** |
| `npm publish` → `You cannot publish over the previously published versions` | 同一版本号重复发。`npm version` 已经升过版本号，你忘了改 `package.json`。重新 step 2 |
| `git push origin v*` 后 release workflow 失败 | 看 `gh run view <run-id> --log-failed`。最常见：PUBLISHING.md 格式不对，awk 抽不到内容。确保版本行格式严格是 `- **X.Y.Z** (...)` |
| 发完别人 `npm i -g` 装不到 | 等 1-2 分钟 CDN 同步。`npm view atlas-dashboard versions` 看是否已在 registry |
| 发完发现 bug | 见 [紧急回滚](#紧急回滚) |
| tests workflow 失败但本地通过 | 多半是 fixture HTML 不够长 / 不含某关键字。看 `.github/workflows/test.yml` 里 `Prepare fixture HTML files` 那一步，按需调整 |

---

## 紧急回滚

### 24 小时内：直接 unpublish

```bash
npm unpublish atlas-dashboard@<bad-version>
# 这个版本号会被永久占用，不能再 publish 同一个号
# 立即发一个 patch（升号）修复
```

### 超过 24 小时：deprecate + 升号

```bash
npm deprecate atlas-dashboard@<bad-version> "请升级到 X.Y.Z，本版本有 <bug>"
# 然后立即 patch 修复并发新版
```

### GitHub Release 删除

```bash
gh release delete "v<bad-version>" --yes
git push --delete origin "v<bad-version>"
git tag -d "v<bad-version>"
```

---

## 一次性环境配置

只在第一次发版前做一次。

### 1. npm 登录

```bash
npm login --auth-type=web
npm whoami   # 应输出 d4monwang
```

### 2. 配置 Granular Access Token（绕开 2FA，免每次输 OTP）

1. 浏览器打开 https://www.npmjs.com/settings/d4monwang/tokens
2. **Generate New Token → Granular Access Token**
3. 填：
   - **Token name**: `atlas-publish-<machine>`
   - **Expiration**: `365 days`
   - **Permissions → Packages and scopes**: `Read and write`
   - **Select packages and scopes**: 选 `Only select packages I choose`，输入 `atlas-dashboard` 选中
   - ⚡ **关键**：勾选 **"Bypass two-factor authentication when publishing packages"**
4. **Generate Token** → 立刻复制
5. **不要把 token 粘到任何聊天 / 笔记 / 截图里**。直接终端：
   ```bash
   npm config set //registry.npmjs.org/:_authToken <粘贴 token>
   ```
6. 验证：
   ```bash
   grep authToken ~/.npmrc      # 应输出 1 行
   npm publish --dry-run        # 应不报 401/403
   ```

### 3. gh CLI 登录

```bash
gh auth login   # 选 GitHub.com → HTTPS → 浏览器登录
gh auth status  # 应输出 "Logged in to github.com account DamonAmber"
```

token 至少要 `repo`、`workflow` 权限。

### 4. （可选）配 GitHub Repo 启用 Pages

已经做过。如果 fork 此仓库或迁移：

```bash
gh api -X POST repos/<owner>/atlas-dashboard/pages \
  -f 'source[branch]=main' \
  -f 'source[path]=/docs'
```

---

## 给未来 AI / 自己的话

如果你（Claude / 其他 AI / 失忆的我）受用户委托发版：

1. **先读这份文档**，特别是 [TL;DR](#tldr--标准发版命令序列) 和 [前置检查](#前置检查每次发版前)。
2. **不确定时不要发**——问用户具体期望、版本号要不要 patch 还是 minor。
3. **publish 前必须 dry-run** 确认包内容。
4. **凭据类东西从不在聊天里贴**：npm token、access token、recovery codes、密码——一律让用户在他自己终端粘贴到 `~/.npmrc` 或环境变量。
5. **发布后必须验证**（[验证发版成功](#验证发版成功) 4 项）。
6. **流程有变化？发完最后必须做的事**：
   - 把新版本加到本文档底部 [已发布版本](#已发布版本)
   - 如果改了发版步骤（新增工具、改了命令、新增自动化等）→ 改对应章节
   - 如果加了新的 spec 文件 → 加到 [步骤 0](#步骤-0跑全套测试) 的 spec 清单
   - 如果改了 token / 凭据机制 → 改 [一次性环境配置](#一次性环境配置)
7. **流程出错的话留痕**：在故障排查章节加一行"现象 → 修复"，让下次少踩坑。
8. **不要主动用破坏性命令**（unpublish 24h 外、git tag -d、git push --force 之类）—— 必须先和用户确认。

---

## 已发布版本

> ⚠️ 每次发版**必须**在此列表最上方加一行。GitHub Release workflow 依赖此格式抽取变更日志。
> 格式：`- **X.Y.Z** (YYYY-MM-DD) — <描述>`

- **0.3.1** (2026-05-22) — ① 修复全文搜索：中文单字（如"灯"）原本被 `q.length < 2` 拦截不发请求。后端区分 ASCII / 非 ASCII，中文/日文/韩文等单字符放行，ASCII 仍要求 ≥ 2 字符避免 'a' 这种太宽的查询。② 新功能：打开文件后 iframe 内自动高亮命中文字（同源直接操作 contentDocument，TreeWalker 注入 `<mark>`），首个匹配自动滚到中间标橙色，顶栏出现 `1 / N` 跳转徽章 + ▲▼ 按钮，搜索框 Enter / Shift+Enter 也能跳。

- **0.3.0** (2026-05-22) — ① 修复：鼠标点击文件时若有 1-3px 抖动会被 SortableJS 当成拖拽吞掉 click，表现为"点 3-4 次才打开"。改用 pointerdown 记位置 + pointerup 检查偏移触发 openFile，绕开 click 事件链。② 升级提示：CLI 启动时显示新版本可用（每天最多查一次，缓存到 `~/.atlas/update-check.json`）；Dashboard 顶栏右侧出现脉动小标签，点击复制升级命令。③ GitHub Releases 自动化：push tag `v*` 时 workflow 抽取 PUBLISHING.md 当版本描述自动创建 Release。
- **0.2.1** (2026-05-22) — 修复：键盘导航留下的 `.kbd-focus` 视觉态没自动清除，与 `.active` 同时出现造成"多个文件被选中"的视觉异常。`setActiveFile` 切换 active 时统一清掉 kbd-focus，CSS 上 kbd-focus 改为 outline-only（不再争夺背景色）。
- **0.2.0** (2026-05-22) — 三个功能改进：① 键盘导航（搜索框 `↓` 进列表、`↑↓` 切换、`Enter` 打开、`Esc` 回搜索）；② 最近打开快捷栏（侧栏顶部 LRU 队列，最多 10 项，跨项目秒回）；③ HTML 全文搜索（后端 contains 匹配 + mtime 缓存，仅内容命中的文件标 🔍）。GitHub Actions CI 落地（push/PR 自动跑测试）。
- **0.1.2** (2026-05-21) — 加拖拽 hover-to-expand：拖文件悬停在折叠 folder 头上 600ms 自动展开。`forceFallback: true` 让 SortableJS 走统一 mouse 事件路径；`document.mousemove + elementFromPoint` 检测鼠标下方真实元素（onMove 不可靠，只在 sibling 切换时触发）。同步 `state.collapsed` + localStorage 持久化。
- **0.1.1** (2026-05-21) — 加 `atlas start / stop / restart / status / log` 守护进程子命令。PID 文件升级为 JSON（含端口 + 启动时间），status 准确显示真实端口。不再依赖用户本地 `~/.zshrc` alias。
- **0.1.0** (2026-05-21) — 首次发布。CLI、首次引导、嵌套分组、桌面通知、备注名等全部功能就位。
