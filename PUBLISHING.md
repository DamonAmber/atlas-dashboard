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

**所有 spec 都自起隔离实例，不需要预先起服务，也不会碰你真实的 `~/.atlas` 与文档。**
直接跑即可（跑之前不用 `atlas stop`，跑的时候你正在用的 Atlas 也不受影响）：

```bash
for spec in tests/*.spec.js; do
  echo "=== $spec ==="
  node "$spec" 2>&1 | tail -3
done
```

> 验证过：把本机 Atlas 完全停掉，全套 34 个 spec 依然全绿，且 `~/.atlas/config.json`
> 与 `store.json` 校验和逐字节未变。若将来某个 spec 在服务停止时失败，说明它偷偷依赖了
> 你的真实实例，按下面的约定改掉。

**要求所有 spec 都"失败 0 项"**。任意一个失败必须先修才能发版。

> ⚠️ 两个"假绿"陷阱，看到这两行输出别当成通过：
> - **跑测试前先确认 4400-4799 没有别的 Atlas 在跑**（比如自己开着的调试实例）。
>   隔离实例在这个区间随机取端口，撞上了 `server.js` 会自动切到别的端口，
>   而 helper 探原端口就探到了那个别人的实例 —— 它是健康的，于是 spec 会对着
>   几百篇真实文档跑只有几篇 fixture 的断言，失败信息极具误导性
>   （`空查询时列出全部文档 期望 4 实际 50`）。
>   helper 现在会先探端口是否空闲、再用 `/api/config` 的 `scanRoots` 验明身份，
>   撞上时直接报「端口 N 上应答的不是本实例」而不是让 spec 跑错。
>   调试实例建议监听这个区间之外的端口。
> - `e2e-install.spec.js` 打印 `没有 tgz，先运行 npm pack` 就退出（**exit code 仍是 0**，循环里看不出来）。它需要项目根有 `atlas-dashboard-*.tgz`。跑法：
>   ```bash
>   npm pack >/dev/null && node tests/e2e-install.spec.js | tail -5 && rm -f atlas-dashboard-*.tgz
>   ```
>   期望末行 `总计 10 项，失败 0 项`。**记得删掉 tgz**，否则会被 `git add -A` 带进 commit。
> - `scroll-after-toggle.spec.js` 在 iframe 还没加载出内容时打印 `!! HTML 不够长，没法测试` 并跳过（也是 exit 0）。这是它长期的既有行为，不是本次改动引入的；判断是否回归的办法是 `git stash` 后对比同一行输出。

当前 spec 清单（34 个）。除 `landing-demo`（`file://`）与 `diff-algorithm`（纯函数单测）
外，其余都通过
`tests/helpers/isolated-atlas.js` 的 `startAtlas()` 起独立实例：临时 `ATLAS_HOME`
（自带 config/store）+ 临时扫描根 + 临时 fixture + 随机端口，结束即删。
需要"有规模的文档树"的用例（帧率 / 滚动 / 拖拽）用 `makeTreeFixtures()` 现造，
不再依赖你本机那几百篇真实文档。

> - `preview-live-edit.spec.js` — 预览区轻量编辑：edit-doc 标注 / 进入编辑 / 文案改+保存 / 列表重排 / 取消恢复 / 冲突 / 安全（32 项）
> - `favorites-and-tags.spec.js` — 收藏与标签：星标点击不误触"打开文档"、不被 SortableJS 当拖拽把手；收藏夹跨文件夹聚合、按收藏时间倒序、可取消、折叠态持久化；顶栏收藏按钮联动；标签去重与大小写合并、超量截断、行上最多 2 个 +N、"取消"不会清标签、清空即删 key；标签筛选条按用量倒序、多选为 AND、与搜索/仅未读正确叠加；重命名后收藏与标签跟随新路径（72 项）
> - `md-render-and-roundtrip.spec.js` — Markdown 渲染与往返保真：`<base href>`（相对图片能加载）/ front matter / 锚点链接不新开标签页 / 任务列表复选框 / 代码块语言标签+复制 / 标题锚点 / 表格横向滚动 / 深色模式；以及所见即所得改一处后源码逐字节保真（表格对齐、段落软换行、块间距都不被顺手改掉）（28 项）
> - `md-editor-ux.spec.js` — Markdown 编辑器交互：`/` 键不再被全局快捷键抢走（设置里能手输绝对路径）/ ⌘B ⌘I ⌘E ⌘K ⌘S / 回车续列表（无序·有序·任务）/ Tab 多行缩进与反缩进 / 格式工具条 / 分栏拖拽与持久化 / 大纲 / 未保存草稿恢复（41 项）
> - `quickopen-a11y-rename.spec.js` — ⌘K 快速打开（模糊匹配 + 键盘导航）/ 弹窗可访问性（Esc 关闭 · role=dialog · 焦点陷阱 · 焦点归还 · 嵌套只关最上层）/ 重命名磁盘文件与 store 状态迁移 + 输入校验（30 项）
> - `md-pdf-export.spec.js` — Markdown 导出 PDF：打印版形态（无目录侧栏 / 无复制按钮 / 配色钉回浅色 / `@page` 页边距）+ 端到端产出非空 PDF + 临时目录清理（21 项，本机没有 Chromium 系浏览器时自动跳过端到端部分）
> - `index-perf-and-search.spec.js` — 文件索引与搜索：索引与磁盘一致 / watcher 增量维护（增·改·删·改名）/ 配置变更重建 / `/api/state` 不再每次重写 store.json / 切换文档类型不重扫 / 多关键词 AND 与引号短语 / 耗时门槛（25 项）
> - `share-security.spec.js` — 局域网分享的安全边界：默认只放行文档引用到的资源、同目录未引用文件 403、显式 `scope=dir` 逃生口、路径穿越、有效期到期 410 与过期条目清理（42 项）
> - `diff-algorithm.spec.js` — 行级 diff 算法单测：上限必须卡在编辑距离而非 N+M、trace 切片边界、大文件性能（33 项，纯函数，不起服务）
> - `diff-view.spec.js` — 和上次已读版本对比：底本生命周期（打开即记录·内容相同去重·数量上限·删文件即清理）/ hunk 与统计 / 上下文行数 / 标记为已看过 / 改名后底本迁移 / 前端面板与编辑态互斥（41 项）
> - `md-sync-highlight.spec.js` — 源码 ↔ 预览的对应区域高亮：行号映射（含 front matter 偏移）、光标所在块标 active、跨块选区把覆盖到的块全标 selected、预览侧点/选时源码画出对齐到行的色带（含软换行折行）、色带随滚动移动、内容变化后映射更新、退出编辑清干净（24 项）
> - `shortcuts-panel.spec.js` — 快捷键速查表：三个入口（? 键 / 侧栏底部按钮 / 首页「全部快捷键」）、打开文档后仍可查、焦点在预览 iframe 内按 ? 也能唤出（经快捷键桥转发）、清单覆盖 7 个场景分组且抽查的键位与代码里注册的一致、输入框里 ? 是输入字符不开面板、Esc 关闭并把焦点还给触发按钮（33 项）
> - `quickopen-content-search.spec.js` — ⌘K 正文搜索：名称命中在前 / 正文命中作为第二组追加且不与名称组重复 / 摘要保留原始大小写并标出关键词 / 命中处数 / 打开后在预览里高亮并滚到第一处、顶栏 n/m 可继续跳 / 换文档后高亮自动失效 / 全程不写侧栏搜索框（不误过滤目录树）/ 单个 ASCII 字符不发请求、中文单字照搜（24 项）
> - `preview-shortcut-bridge.spec.js` — 预览 iframe 内的 app 级快捷键：焦点在文档正文时 ⌘K / ⌘B 仍生效（键盘事件不跨 iframe 冒泡，靠注入桥转发）、编辑态 ⌘S 被拦下并真的触发保存、文档内打字时不抢 ⌘K/⌘B、非编辑态不抢 ⌘S、单键 `/` 一律不转发、iframe 换文档后桥自动重建（18 项）
> - `modal-close.spec.js` — 每个弹窗的每条关闭路径：✕ 按钮（含精确点在图标 span 上）、遮罩、Esc、关闭后焦点归还、以及"点弹窗内部不会误关"（22 项）
> - `misc-hardening.spec.js` — 杂项加固：编辑备份扩展名跟随源文件 / 请求体上限与可读错误 / `/raw` 路由不依赖 `app._router.stack`（扫描根运行时增删后序号重排仍正确）（26 项）
> - `toast.spec.js` — 扫描根增删与反馈 toast（12 项，含隔离性断言）
> - `inline-edit.spec.js` — 编辑文件名 / 备注（18 项，含隔离性断言）
> - `v0.2-features.spec.js` — 键盘导航 / 最近打开 / 全文搜索（17 项，含隔离性断言）
> - `sse-leak-and-retry.spec.js` — SSE 连接不泄漏（含反向验证）+ `/api/state` 挂起时超时中止并自动重试恢复（13 项）
> - `search-cn-and-highlight.spec.js` — 中文单字搜索 + iframe 内高亮跳转（13 项，fixture 自带含"灯"的长文档）
> - `click-with-jitter.spec.js` — file 点击带抖动仍能打开（5 项）
> - `folder-toggle-with-jitter.spec.js` — folder 头点击带抖动仍能折叠/展开（4 项）
> - `no-sortable-leak.spec.js` — Sortable 实例不累积（5 项）
> - `drag-hover-expand.spec.js` — 拖到折叠 folder 头上 600ms 自动展开（6 项）
> - `drag-stress.spec.js` — 连续随机拖拽不死循环
> - `drag-to-root.spec.js` — 文件拖到根目录不卡
> - `sidebar.spec.js` — 侧边栏开关、宽度、动画（5 项）
> - `scroll-stuck.spec.js` — 拖 resizer 不卡死（8 项，fixture 用长文档）
> - `scroll-after-toggle.spec.js` — 滚动到中间后切侧栏不卡（fixture 用长文档）
> - `sidebar-perf.spec.js` — 帧率门槛（p95 ≤ 25ms / max ≤ 50ms，fixture 造 250 篇。CI 上共享 runner 帧率波动大，设为非阻塞观测）
> - `dir-picker.spec.js` — 浏览器内目录选择器（15 项。`/api/browse` 本身就是列真实文件系统目录的接口，用例会只读地浏览 home 与 `~/Documents`；因 CI runner 的 home 结构不保证，不放进 CI）
> - `landing-demo.spec.js` — landing page demo 交互（28 项，`file://`，连服务都不需要）
> - `e2e-install.spec.js` — npm pack + 模拟陌生用户安装（10 项，自建临时 home 与端口）

> ⚠️ **新写 spec 一律用 `startAtlas()`，不要直连 `:4321`。** 哪怕自认为"只读"也不要——
> 点开一篇文档就会写 store 的 recent 与已读状态，折叠一个分组就会写 tree。
>
> 历史教训：`toast.spec.js` 原先直接改真实 `~/.atlas/config.json`，中断时残留临时扫描根，
> 堆积后让服务重挂 watcher 越来越慢，进而让测试更容易超时失败 —— 恶性循环，
> 最终它长期红着没人当真，而它本该守护的功能（扫描根增删反馈）悄悄退化到 0.7.3 才被发现。
> 另一个例子：`landing-demo` 的拖拽用例曾间歇性失败，真因是 demo 区域在长页面靠下位置
> （y≈1650）而视口只有 900 高，拖拽目标不在视口内、鼠标事件打不到元素，
> 偶尔能过是因为前面的用例碰巧把页面滚到了合适位置 —— 现在拖拽前强制
> `scrollIntoViewIfNeeded()` 并加了"源与目标都在视口内"的前置断言。

### 步骤 1：更新 PUBLISHING.md

在本文档底部 [已发布版本](#已发布版本) 列表**最上方**加一条新版本描述。格式严格匹配：

```markdown
- **<版本号>** (<YYYY-MM-DD>) — <一段 fix/feat 类描述，可含①②③ 编号。具体到改了什么文件、为什么、对用户的影响>。
```

**重要**：必须用 `- **<X.Y.Z>**` 这种格式（前面短横线、版本号用双星号包裹），因为 GitHub Release workflow 用 awk 按这个 pattern 抽取本版变更日志。

### 步骤 1.5：同步 landing page（`docs/index.html`）

**这是约束，不是建议**。任何用户可见的功能改动都必须更新 landing page，否则就是"网页和实际功能不一致"——用户会困惑、抱怨。

按本版改动逐项检查：

- [ ] **加了新功能** → 在 `docs/index.html` 的 `#features` grid 加一张 `.feat` 卡片，或扩充已有卡片的描述
- [ ] **改了 UI 交互**（如新键盘快捷键、新按钮、新视觉态）→ 改对应卡片的 `<p>` 描述
- [ ] **加了新 CLI 子命令** → 改 `#commands` 表格里的命令清单
- [ ] **改了截图相关的 mockup**（`.demo` 区）→ 同步 `docs/index.html` 里 demo 的 mock 数据 / 交互
- [ ] **改了 README 用户视角部分** → 多半 landing page 也要同步

改完 push 即可（不需要发 npm 新版），GitHub Pages 自动重新部署到 https://damonamber.github.io/atlas-dashboard/

> 这一步**不是事后补**。发版前就要做完。如果发完版才发现网页落后于功能，立即 commit + push 修，并在下次发版的 PUBLISHING.md 描述里说明（"② 同步遗漏的 landing page 文档"）。

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
- `total files:` 应在 20~26 之间（当前为 23；bin/lib/public/server/README/LICENSE，包含 vendored 前端依赖）
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
| `git push` 到 main | `.github/workflows/test.yml` | CLI smoke + landing demo + e2e install + 16 个隔离 spec（各自起实例，无需预置 fixture 与共享服务）+ 帧率非阻塞观测 |
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
| `npm publish` → **E404 `PUT https://registry.npmjs.org/atlas-dashboard - Not found`** | **同样是 token 失效**，不是包不存在。npm 对无效凭据的 publish 会返回 404 而不是 401（避免泄漏包是否存在）。先跑 `npm whoami` 确认：401 就是 token 问题，按上一行重新生成。注意 `npm publish --dry-run` **不校验凭据**，dry-run 通过不代表能发。<br>快速判定（不打印 token）：<br>`TOKEN=$(node -e "process.stdout.write(require('fs').readFileSync(process.env.HOME+'/.npmrc','utf8').match(/_authToken=(.+)/)[1].trim())")`<br>`curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" https://registry.npmjs.org/-/whoami`<br>200 = token 有效，401 = 该换了。<br>**此时不要 push tag**：Release 说明里会带 npm 链接，npm 上没有对应版本就是坏链。先修 token → publish 成功 → 再 commit/push/tag。 |
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
   - 如果加了新的 spec 文件 → 加到 [步骤 0](#步骤-0跑全套测试) 的 spec 清单（会写状态的必须走 `startAtlas()` 隔离实例，归到 A 类）
   - 如果改了 token / 凭据机制 → 改 [一次性环境配置](#一次性环境配置)
7. **流程出错的话留痕**：在故障排查章节加一行"现象 → 修复"，让下次少踩坑。
8. **不要主动用破坏性命令**（unpublish 24h 外、git tag -d、git push --force 之类）—— 必须先和用户确认。

---

## 已发布版本

> ⚠️ 每次发版**必须**在此列表最上方加一行。GitHub Release workflow 依赖此格式抽取变更日志。
> 格式：`- **X.Y.Z** (YYYY-MM-DD) — <描述>`

- **0.12.0** (2026-08-21) — 界面系统性升级 + 三个可发现性缺口的修复。**① 设计令牌层重写**（`public/styles.css`）：所有配色改用 `light-dark(浅, 深)` 单次声明，深浅两套色板不再各维护一份，随之删掉全部 `@media (prefers-color-scheme)` 重复块（`.preview` / `.md-preview-pane` / 源码↔预览同步高亮 / 两处 pulse 动画）。新增 `--border-strong`（控件轮廓，原来 `--border` 在深色下几乎看不出这是个按钮）、`--hairline`、`--accent-hover/-press/-ring`、`--on-accent`（深色主题的蓝配白字只有 2.6:1，实心按钮上必须换近黑）、`--warn`、`--shadow-1~3`、`--sp-*` 4px 栅格、`--r-*` 圆角、`--h-ctl*`、`--ring`。顺带修掉一个一直没人注意的问题：从未声明 `color-scheme`，于是深色模式下原生 checkbox 与滚动条仍是刺眼的浅色。**② 图标系统统一**：`public/index.html` 顶部内嵌 35 个 symbol 的 sprite（viewBox 24×24、stroke 1.75），`app.js` 新增 `ic()` / `docTypeIcon()`，把散落各处的 emoji（📁 📂 📋 🏷 ✎ ✕ 📝 🌐 Aa ⌕ ▾ 🕰️ ✅ ⚠️）全部换成线性图标。emoji 在 mac / Windows / Linux 是三套完全不同的字形、颜色不受 `currentColor` 控制、和线性图标的视觉重量也对不上——这是界面观感不统一的主因。`.file.content-match` 那个放大镜改用 CSS mask 画。**③ 顶栏工具条**：10 个同权重带边框的图标按钮改成 ghost 风格并按语义分三组（文档操作 / 标记分发 / 跳到外部），组间加 1px 分隔线；`#btn-share.shared` 与编辑态的 `#btn-edit` 原来靠 `border-color` 表态，ghost 化后改用 `accent-soft` 填充。**④ 侧栏**：头部收成单行并与主顶栏对齐到同一水平线；统计从 `brand-sub` 挪到底栏——320px 宽度下它长期被截成「804 个文档 · 377 未…」，新增 `updateStats()` 统一渲染并在「全部文档」区块标题上给出当前筛选命中数；收藏 / 最近的区块头从「只有右侧 16px 小箭头是热区」改成整行可点（`.section-head`，带 chevron + 图标 + 计数）；缩进引导线常显；`.file.active` 加 2px accent 左竖线。**⑤ 首页**：没打开文档时右侧原本只有一个占位图标加两行提示，整块空着。现在直接回答这个工具存在的理由——「AI 又改了哪些文档」：四个数字（文档 / 未读 / 项目 / 收藏）加上按 mtime 倒序的**待看队列**、最近打开、收藏三张卡片，点一行进文档，不必再去目录树里找红点。**⑥ 设置弹窗**：6 段长滚动改成左导航四分区（扫描 / 外观与通知 / 分享 / 归档），面板自身不滚动、标题栏与导航固定。**⑦ 深浅色可固定**：设置里新增「跟随系统 / 浅色 / 深色」，`<head>` 内联脚本先设 `data-theme` 防首帧闪白。这里踩到一个不明显的坑：**iframe 里的 `prefers-color-scheme` 不继承父文档的 `color-scheme`**，只在根节点切换会出现「外壳浅色、正文深色」的割裂。修法是把主题带进预览 URL——`markdown.js` 把两套配色变量提取成 `mdVarsLight/Dark` 与 `tocVarsLight/Dark` 并新增 `forcedThemeCss(theme)`，`renderPage` 接受 `opts.theme` 把覆盖样式追加在 `@media` 之后，`server.js` 的 `/api/render-md` 读 `?theme=`，`app.js` 的 `previewUrlFor()` 带上该参数；导出 PDF 仍钉浅色不受影响。**⑧ 对比度校准到 WCAG AA**：`--text-faint` 承载的是日期 / 计数 / 提示这类 10~11px 小字，原值在浅色下只有 2.79:1、深色下 3.25:1，现分别提到 4.39 / 4.89；`--unread`（底栏「N 未读」是文字）、`--ok`、`--fav`、`--border-strong` 一并上调。**⑨ 修掉三个长期存在的 CSS 优先级 bug**：`.modal button`（0,1,1）一直压过 `.modal-close` / `.quickopen-item` / `.share-btn-danger` / `.share-stop-all-btn` / `.root-list li button`（都是 0,1,0）——表现是 ⌘K 结果列表**每一行都被画成一个带边框的按钮**、「停止分享」这个破坏性操作显示成普通灰按钮、弹窗 ✕ 被画成方块。改法是给 `.modal button` 加 `:not(:where(...))` 排除三类非控件按钮（用 `:where` 保持优先级不变），其余加 `.modal` 前缀提级。**⑩ 修掉「焦点在预览文档正文里时快捷键全失效」**（既有缺陷，在 0.10.1 上同样复现）：预览是独立文档，键盘事件不跨 iframe 边界冒泡，外壳那个 keydown 总处理器收不到——点进正文读一会儿再按 ⌘K 想跳下一篇没反应，得先点侧栏把焦点拿回来，而这恰好是最常见的动线。新增 `bindPreviewShortcutBridge()` 往同源预览文档注入 keydown 桥（挂在 `load` 上，每次导航重建，`doc.__atlasKeyBridge` 防重复，`capture: true` 以防文档自己 `stopPropagation`）：命中 app 级和弦时**先在 iframe 侧 `preventDefault`**（合成事件只影响外壳，管不到原始事件的默认行为，不拦住的话 ⌘S 仍会弹浏览器「存储网页」、Windows/Linux 上 Ctrl+K 仍会跳地址栏），再构造等价事件派发给外壳，因此「哪个键干什么」仍只存在一处。让位规则：⌘S 仅编辑态接管（非编辑态留给浏览器，与外壳焦点时行为一致）、⌘K/⌘B 在文档内打字时不抢、单键 `/` 一律不转发（不少 HTML 报告自己用 `/` 做站内搜索）。**⑪ ⌘K 快速打开接入正文搜索**：AI 生成的报告文件名往往很泛（一堆 `README.md`、`20260529-xxx.md`），你记得的是「某篇里提过转化率」而不是文件叫什么；侧栏搜索虽然能搜正文，但它同时过滤整棵目录树，是「收窄视野」而非「跳过去」。现在名称命中在前（不破坏「敲两个字母 Enter 就走」的肌肉记忆），文件名没命中但正文里有的另成一组「正文命中」，每条带上下文摘要（关键词已 mark 标出）与这篇里出现了几处；选中回车后预览**滚到第一处并高亮**，顶栏出现 `n / m` 可用 ▲▼ 继续跳，全程不写侧栏搜索框（新增独立的 `qoContent` 状态与 `pendingPreviewHighlight`，后者只在路径匹配时兑现、兑现即失效，且因为「同一篇再打开不触发 iframe load」，`setActiveFile` 里 URL 未变的分支也要兑现一次）。服务端配套：`getFileText` 改为同时缓存原文与小写索引，**snippet 因此保留原始大小写**（原来只存小写，`README` 会显示成 `readme`；并防 `toLowerCase()` 改变长度导致切歪），`/api/search` 新增 `limit`（⌘K 传 25）、每条 `count`、响应 `truncated`，且**扫描前按 mtime 倒序**——带 limit 时循环会提前 break，按原扫描顺序返回的等于「随机 25 篇」，按 mtime 倒序才是「最近改过的里含这个词的」。**⑫ 新增快捷键速查表**：功能此前全藏在按钮 title 与 README 里，首页那行提示还只在没打开文档时可见，Markdown 编辑器那一整套键（⌘B/⌘I/⌘E/⌘K、Tab 缩进、回车续列表）在应用内完全没有出口。现在按 `?` 唤出（侧栏底部键盘图标、首页「全部快捷键」按钮同效），7 个场景分组共 31 条，`⌘`/`Ctrl` 按平台自动切；`SHORTCUTS` 数据刻意放在全局 keydown 处理器正上方，改快捷键的人在同一屏里就能看到清单也要改。`?` 也加进了快捷键桥的转发白名单（目前唯一不带修饰键就转发的键，因为它正服务于「读文档时想知道还能怎么用」）。**⑬ 加固测试 harness**（`tests/helpers/isolated-atlas.js`）：隔离实例在 4400-4799 随机取端口，撞上别的进程时 `server.js` 会自动切到别的端口，而 helper 仍探原端口——若那里恰好是另一个 Atlas（比如开发时留的调试实例），它是健康的，于是 `startAtlas` 认为「起好了」，整个 spec 拿着几百篇真实文档去跑只有几篇 fixture 的断言，失败信息还极具误导性（`空查询时列出全部文档 期望 4 实际 50`）。这次发版前就真踩到了，也追认了此前几次被当成「偶发」的失败。现在先用 `net` 探端口是否真空闲再 spawn，健康检查改用 `/api/config` 的 `scanRoots` 验明身份，撞上时直接报「端口 N 上应答的不是本实例」；PUBLISHING.md 步骤 0 也补了这条排查说明。**⑭ 测试**：新增 `preview-shortcut-bridge.spec.js`（18 项）、`quickopen-content-search.spec.js`（24 项）、`shortcuts-panel.spec.js`（33 项），三者都做过反向验证（临时停用被测逻辑确认断言真会红）；因文案与 DOM 调整同步更新 4 个既有 spec 的断言（`modal-close` 的 `.modal-close span` → `.ico`、`favorites-and-tags` 的 title 前缀、`sse-leak-and-retry` 与 `landing-demo` 的「个文档」→「篇文档」）。全套 34 个 spec 全绿，`npm test` 582 项断言。README 新增 `## 快捷键` 完整表格，landing page 同步 mockup 图标、demo 数据、统计文案，并新增「首页概览」「深浅色主题可固定」两张特性卡与键盘流卡的改写。

- **0.10.1** (2026-08-21) — Bug 修复：**筛选时命中结果落在折叠的分组里就看不见了**，表现为"筛选了但什么都没出来"、"清除筛选后文档也没回来"。日常使用中分组大多是折叠着的（`state.collapsed` 持久化在 `atlas:collapsed`），而 `renderFolder` 一直无条件按折叠状态渲染：筛选把不含命中项的分组整棵剪掉之后，剩下那些确实含命中项的分组仍然是折叠的 —— 命中的文件行进了 DOM 却被 `.folder.collapsed > .folder-children { display: none }` 藏住，屏幕上一个结果都没有。实测 766 个文档 / 30 个分组、其中 29 个折叠时，点标签 chip 筛选后**屏幕上可见文档数是 0**。修法：`renderFolder` 里 `const isCollapsed = hasActiveFilter() ? false : state.collapsed.has(folder.id)` —— 筛选生效时忽略折叠状态（能活到渲染这一步的分组本身就是"含命中项"的，再让用户一个个点开是反直觉的），且**只在渲染时忽略、不写 `state.collapsed`**，所以清除筛选后每个分组的折叠状态原样恢复、localStorage 里的折叠偏好也不被改写。这个毛病不是 0.10.0 引入的：搜索（0.1.0）与「仅未读」（0.2.0）一直有，0.10.0 新加的标签筛选继承了它，现在三者一起修好。`favorites-and-tags.spec.js` 加了 12 项断言把这条钉住（折叠状态下标签筛选 / 搜索 / 仅未读三种筛选的命中结果都必须可见、命中分组自动展开、清除后折叠状态与 localStorage 偏好都原样恢复），共 84 项。全套 31 个 spec 全绿。

- **0.10.0** (2026-08-20) — 新功能：**收藏夹**与**文档标签 + 按标签筛选**。目录树是"一个文件只能待在一个地方"，但常看的那几篇往往散在不同项目里（每次都要展开好几个分组去翻），而"周报""待评审""要归档"这些维度本身是交叉的、跟目录结构对不上。这两个功能各自解决其中一半。① **收藏**：文件行左侧加常驻星标 `.fav-btn`（未收藏时半透明、hover 该行浮出，已收藏则常亮金色 `--fav`），顶栏也加了同步状态的收藏按钮；侧栏新增「收藏」区（结构照 `.recent-bar`，跨文件夹平铺、按收藏时间倒序、条目上 ✕ 取消、可折叠且折叠态持久化到 `atlas:favCollapsed`）。刻意不把星标塞进 hover 才出现的 `.file-actions` —— 收藏是高频二元操作，藏在第 6 个按钮后面不合理；代价是它落在 SortableJS 的拖拽把手区里，必须同时加进 `initSortables` 的 `filter` 和文件行 `pointerdown/pointerup` 的守卫，否则按下星标会开始拖这一行（拖完 `onEnd` 还会把排序模式强行切到「自定义」）、或者顺带把文档打开。② **标签**：hover 文件 → 🏷 → 逗号分隔输入（`周报, 待评审, AI`），中英文逗号都认，服务端 `normalizeTags()` 做唯一一次规范化（trim、内部空白压成单空格、单个 ≤24 字、最多 12 个、**按小写去重但保留用户第一次输入的写法**，所以输 `AI` 之后再输 `ai` 不会多出一个看起来重复的标签）。文件行上显示前两个 + `+N`（完整列表进 `title`），`hover` 时标签让位给操作按钮——320px 侧栏放不下「chip + 展开后的 5 个按钮」，不让位文件名会被压成「留…」。③ **按标签筛选**：侧栏 `#tag-bar` 列出全部标签（按用量倒序、带计数），点一下只看该标签的文档，**多选是「同时具备」**（AND，与搜索多关键词语义一致，逐步收窄），且与搜索、「仅未读」正确叠加而非互相覆盖——新增 `matchesTagFilter()` 接进 `fileMatches()`，并抽出 `hasActiveFilter()` 统一 `render()` / `renderFolder()` 两处过滤守卫（原来是散在两地的 `state.search || state.onlyUnread`，加一种筛选就要改两处、漏一处就是"筛选只在顶层生效"）。标签筛选故意不持久化（同 `onlyUnread`）：否则刷新后"文档凭空少了一半"很难自查；服务端标签被清空后前端也会撤掉已失效的筛选，避免树里一片空白而筛选条上已无 chip 可取消。④ **数据与迁移**：`store.favorites`（path → 收藏时间戳，存时间而非 `true` 才能按"最近收藏"排序）与 `store.tags`（path → string[]），沿用 `alias` 那套端点约定新增 `POST /api/favorite`（省略 `favorite` 即切换；已收藏时重复收藏不刷新时间戳，避免误触打乱收藏夹顺序）与 `POST /api/tags`（整组覆盖，空即删 key）；`/api/state` 的 fileMap 加 `favorite`/`favoritedAt`/`tags`，顶层加 `favorites`/`allTags`；`/api/rename` 的迁移块补上这两个字段（漏一个用户就会觉得"改个名字东西就丢了"）。删文件后的清理走 `/api/state` 惰性剪枝而不是 chokidar 的 unlink 回调（那里每个事件都要 `loadStore+saveStore`，批量删除会连着打很多次盘），并用 `fs.existsSync` 兜底：条目不在扫描结果里可能只是用户在设置里取消勾选了 Markdown，不该因此丢掉 md 文件的收藏。顺手修掉 `migrateStore` 旧版 `folders` 分支返回手写字面量、缺 `shares`/`seenVersions` 的问题（改成递归自身补齐）。⑤ **修掉一个共享组件的缺陷**：`showDialog` 对「取消」和「清空输入后确定」都返回 `null`，调用方无法区分——第一版标签编辑因此点「取消」会把标签清光。新增 `allowEmpty` 选项（确定返回 trim 后字符串、可以是空串；取消仍返回 `null`），"可清空的字段"从此有正确语义。⑥ **修掉三个既有 spec 的假通过**：`drag-hover-expand` / `drag-stress` / `drag-to-root` 都从文件行左侧硬编码 `+30px` 起拖，而那个位置现在正是被 Sortable `filter` 排除的星标，拖拽根本不启动；前者断言严格所以直接红了，后两者只断言"页面仍响应"会静默变绿。全部改成按 `.file-name` 定位。新增 spec `favorites-and-tags.spec.js`（72 项，含"在星标上拖 70px 不产生 ghost / 不把排序切成自定义 / 不打开文档"这组回归），已挂进 `npm test` 与 CI。全套 31 个 spec 全绿。

- **0.9.1** (2026-08-20) — Bug 修复：**Markdown 文档点过目录 / 标题锚点后，右上角刷新按钮报 `Cannot GET /raw/<n>/<目录>/`**（0.8.0 引入的隐性回归）。根因是 `<base href>` 同时改变了「相对 URL」的解析基准：0.8.0 为了让 md 里 `![](./assets/x.png)` 这类相对图片能加载，给 `/api/render-md` 渲染出的预览页注入了 `<base href="/raw/<n>/<md 所在目录>/">`；但这个 base 也是 `history.replaceState()` 和 `href="#锚点"` 的解析基准 —— 点一下 TOC 项，`replaceState(null,"","#第二节")` 会被解析成 `/raw/<n>/<目录>/#第二节`，iframe 里文档的 URL 就悄悄从 `/api/render-md?path=…` 漂移成了那个**目录**；随后刷新按钮的 `contentWindow.location.reload()` 去 GET 一个目录，`express.static` 找不到 index 就落到 404。① `public/vendor/markdown.js` 的 tocScript 把 `replaceState` 的相对 hash 改成带真实路径（`location.pathname + location.search + "#id"`），不再经 base 解析。② 同一个坑还有更直接的一条路：标题 hover 锚点 `.md-anchor` 与 md 正文里手写的 `[x](#y)`，`href="#id"` 同样按 base 解析，**点一下就整页跳到 `/raw/…/` 404，根本不用按刷新**（0.8.0 只修掉了这类链接被加 `target="_blank"` 的问题，没意识到 base 会让它们跳出本页）。现在 enhanceScript 统一接管：凡 `href` 原始值以 `#` 开头的链接都 `preventDefault` + 自行 `scrollIntoView` + 只安全改 hash，TOC 链接（带 `data-target`）交回 tocScript 处理不重复。③ `public/app.js` 新增 `reloadPreviewDoc(canonicalUrl)`：刷新前先比对 iframe 实际 `pathname/search` 与 canonical 地址（md → `/api/render-md`，html → `/raw/`），一致才 `reload()`（保留 hash / search），跑偏了就重新赋 `src` 并带上原 hash 以便仍定位到原章节；刷新按钮与退出编辑恢复只读预览（`exitEditMode`）两处都收敛到它 —— 即使将来再有别的原因让内层文档 URL 漂移，刷新也不会 404。顺带修掉 `exitEditMode` 里用 `els.preview.src`（DOM 属性，内层文档导航后不会变）判断"是否同一份文档"这个失效判据。全套 30 个 spec 全绿。

- **0.9.0** (2026-08-17) — 新功能：**Markdown 编辑器的源码 ↔ 预览对应区域高亮**。此前左右两栏只有百分比滚动同步，光标落在源码某一段时，右边预览里对应哪块内容全靠自己数——文档一长就完全对不上。现在光标 / 选区落在任一侧，另一侧会同步标出对应内容：光标所在块用细高亮（左侧竖条 + 淡背景），跨块选区把覆盖到的块全部标成更明显的选中态，两个方向都生效。① 映射复用 0.8.0 为保真往返而建的块级锚点：`withRaw()` 除 `data-md-raw` / `data-md-gap` 外再写入 `data-md-line` / `data-md-endline`（1 基闭区间）；`render()` 新增 `opts.lineOffset`，`renderBody()` 把 front matter 占掉的行数作为偏移传下去，否则带 front matter 的文档整篇行号都会偏。② 源码侧的高亮不能靠 textarea 本身——它承载不了任何装饰，而且不聚焦时原生选区根本不绘制。所以在 textarea 下面垫一层色带（`.md-source-hl`，textarea 背景改透明），位置由一个与 textarea 同盒模型的隐藏镜像元素量出来，因此**软换行折出的多个视觉行也能完整覆盖**。踩到的坑：`getClientRects()` 返回的是「内联盒」（13px 字体约 15px 高）而不是「行盒」（line-height 21.45px），内联盒在行盒里垂直居中，直接拿来画会整体偏下约 3px 且高度只有半行；现在按行高把半行距还原回去，实测对齐偏差 ≤1px。③ 预览 → 源码的选区解析用 `range.intersectsNode()` 而不是只看首尾容器——全选、跨块鼠标拖选、`setStartBefore/setEndAfter` 产生的 Range，边界容器往往是预览面板本身（带 offset 指向子块）或空白文本节点，只看首尾容器会漏判；`topLevelBlockOf()` 也加了"节点必须在面板内"的前置判断，避免一路 `parentElement` 爬出面板返回无关祖先。④ 粒度是块而非字符：Markdown → HTML 之后字符级对应关系并不成立（源码里选中 `**粗` 这半截，HTML 里没有任何东西与之对应），块级才是稳定且有意义的单位。⑤ 色带随源码滚动只改 `transform`、不重新测量；分栏宽度变化会重新测量（软换行位置变了）。⑥ 顺带把源码区结构从「textarea 直接做 flex 子项」改成「`.md-source-wrap` 三层叠放（色带 / textarea / 测量镜像）」。新增 spec `md-sync-highlight.spec.js`（24 项），已挂进 `npm test`。全套 30 个 spec 全绿。

- **0.8.1** (2026-08-17) — Bug 修复：**分享弹窗与设置弹窗右上角的 ✕ 关闭按钮点击无效**（0.8.0 引入的回归）。成因是 0.8.0 为可访问性把 ✕ 的图标包进了 `<span aria-hidden="true">`（避免屏幕阅读器去读符号本身），但关闭判断仍写作 `e.target.dataset.close !== undefined` —— 点在图标上时 `e.target` 是那个 span，它没有 `data-close` 属性，于是判断失效、按钮完全没反应，用户只能靠点遮罩或按 Esc 退出。现在抽出 `isCloseTarget()` 统一用 `closest('[data-close]')` 往上找，四处调用点（设置弹窗 / 分享弹窗 / ⌘K 面板 / 应用内确认框）全部改用它，未来再嵌套图标也不会重犯。② 顺带修掉一个相邻问题：`openShareModal()` 结尾调的是全量 `render()`，会把用户刚点的那个分享按钮连同整行 DOM 一起销毁重建，导致弹窗关闭时焦点无处可还（记下的 `prevFocus` 已成游离节点），几百篇文档时还白白重排一遍侧栏。新增 `updateSharedDecorations()` 只切换受影响文件行的 `.shared` 标记与角标，替换掉 6 处为了刷分享角标而做的全量 `render()`。③ 新增回归 spec `modal-close.spec.js`（22 项），把每个弹窗的每条关闭路径都钉住——✕ 按钮（含精确点在图标 span 上）、遮罩、Esc、关闭后焦点归还，以及"点弹窗内部标题不会误关"；已挂进 `npm test`。全套 29 个 spec 全绿。

- **0.8.0** (2026-08-17) — 一轮系统性评审后的集中修复与增强。**① 修掉三个实测确认的交互 bug**：全局单键快捷键只排除了 `isContentEditable`，而 `<input>`/`<textarea>` 的该属性是 `false`，于是每敲一个 `/` 焦点就被弹到搜索框——设置里的「扫描根路径」输入框实测输入 `/Users/x` 得到空字符串，绝对路径根本打不进去；现在统一用 `isTypingTarget()` 排除 INPUT/TEXTAREA/SELECT。⌘B 在 Markdown 编辑器里会去收侧边栏而不是加粗、⌘S 完全没被接管（触发浏览器"保存网页"），两者都已按上下文分流。**② 修掉 Markdown 渲染的四处硬伤**：`renderPage` 不注入 `<base href>`，预览页 URL 是 `/api/render-md?path=...`，导致 `![](./assets/x.png)` 被解析成 `/api/assets/x.png` → md 里的本地图片全部 404（修法就在隔壁：HTML 编辑文档早已注入 base）；YAML front matter 被当成「分割线+段落+分割线」渲染成乱码；正文里手写的 `#锚点` 链接被加 `target="_blank"` 每点一次开一个新标签页；表格 `display:block` 脱离正常流让宽表格的滚动条很难发现。**③ 修掉所见即所得编辑的信息丢失**：过去在预览里改一个字会重新序列化整篇文档，表格对齐 `:---:` 退化成 `---`、软换行段落被压成一行——对 git 版本化的文档就是满屏无意义 diff。现在 `render()` 给每个顶层块记下原始源码（`data-md-raw`）与块间距（`data-md-gap`），只有真正被碰过的块（`data-md-dirty`）才重新序列化，实测改一个标题后全文逐字节不变（唯一规范化是文件末尾补一个换行符）。**④ Markdown 呈现增强**：深色模式（配色全面改为 CSS 变量驱动，此前预览页硬编码白底，深色壳子里嵌一块刺眼白板，编辑器更是左半深色右半纯白）、代码块语言标签 + 一键复制、GFM 任务列表渲染成真复选框、标题 hover 锚点、宽表格横向滚动层。**⑤ Markdown 编辑器**：分栏可拖拽（此前 50/50 写死）+ 双击复位 + 方向键微调、回车自动续列表（无序/有序序号自增/任务）、Tab 多行缩进与反缩进、格式工具条、可折叠大纲、⌘B/⌘I/⌘K/⌘E、崩溃后可恢复的本地草稿（此前只有 `beforeunload`，进程崩了就没了）、支持导出 PDF（此前按钮直接 disabled）。**⑥ 可访问性**：弹窗支持 Esc 关闭、`role=dialog`/`aria-modal`、Tab 焦点陷阱、关闭后焦点归还（此前一个都没有，Tab 会跑到弹窗背后）；全部 6 处 `confirm()` 与 2 处 `prompt()` 换成应用内对话框；emoji 图标按钮补 `aria-label`（此前屏幕阅读器只会读出 emoji 名字）。**⑦ 新功能**：⌘K 快速打开（模糊子序列匹配文件名/备注/项目）、重命名磁盘文件（此前只能改显示用的备注名）、**和上次已读版本对比**——未读红点只回答了"AI 动过这个文件"，这个功能补上"动了什么"：用户每次打开文档时把内容存一份底本到 `~/.atlas/versions/`，之后可逐行 diff（新增 `lib/diff.js`，Myers O((N+M)·D)）。**⑧ 性能**：`/api/state` 与 `/api/search` 原来每次请求都全盘递归 walk，而前者每 60s + 每次切回前台 + 每个文件事件都会被调用；改为 chokidar 增量维护的内存索引后，603 篇文档下 `/api/state` 从 18~28ms 降到 4.7ms、搜索冷启动从 528ms 降到 22ms，且不再每分钟无意义重写 `store.json`。搜索支持多关键词 AND 与引号短语，内容缓存从"按 mtime 淘汰"改成真正的 LRU。**⑨ 安全**：局域网分享此前服务的是被分享文件所在目录的整棵子树——分享 `~/Documents/report.html` 等于把整个 `~/Documents/` 开放给拿到 token 的人；现在默认只放行文档真正引用到的资源（HTML 属性 + srcset + CSS `url()` + md 图片，跟一层引用），并保留 `scope=dir` 逃生口给在 JS 里动态拼路径的页面。token 也不再永久有效（默认 2 小时，可选 30 分钟 / 24 小时 / 不过期），过期返回 410 并自动从 store 清理。**⑩ 杂项**：编辑备份的扩展名跟随源文件（此前 `.md` 被备份成 `.html`，且 pruneOld 只筛 `.html` 导致 md 备份永不淘汰）；请求体上限提到 8MB 使路由自己的 5MB 提示可达，并把 body parser 错误翻译成 JSON；`/raw` 路由不再 splice `app._router.stack`（依赖 Express 内部结构，Express 5 已移除该字段）。**新增 9 个 spec 共 287 项断言**：`md-render-and-roundtrip` / `md-editor-ux` / `quickopen-a11y-rename` / `md-pdf-export` / `index-perf-and-search` / `share-security` / `diff-algorithm` / `diff-view` / `misc-hardening`，全部挂进 `npm test`；同时修了 `toast.spec.js` 与 `preview-live-edit.spec.js`——它们靠 `page.on('dialog')` 应答原生 confirm，弹窗改成应用内后失效，新增 `autoAcceptDialogs()` helper 顶上。全套 28 个 spec 全绿。

- **0.7.3** (2026-08-04) — Bug 修复：解决「文档点开没反应 / 刷新按钮一直转」的页面假死，以及「改扫描根后界面毫无反馈」。① `public/app.js` 修掉 SSE 连接泄漏——`connectSSE` 的 `onerror` 原本每次都排一个 3s 后的重连 timer，多个 timer 各建一条 `EventSource`，而函数只 `close()` 得到 `evtSrc` 这一个引用，其余实例丢引用却仍占着连接；浏览器对同源 HTTP/1.1 只给 6 个连接，泄漏满 6 条后整页所有请求（预览 iframe、`/api/state`）永久排队，表现为点文档打不开、刷新按钮无限转圈。现在重连排程唯一化，`onerror` 先判断实例是否已被取代（僵尸连接直接关闭不参与重连），并主动 `close()` 后再统一排程，避免浏览器自动重连与手动重连叠加。② `public/app.js` 给 `/api/state` 加 15s `AbortController` 超时 + 指数退避自动重试（1s→30s 上限）：此前该 fetch 无超时，连接池被占满时永久 pending 导致 `finally` 不执行、刷新按钮永远停在 scanning 且页面再也不会自愈；同时进入失败态后重试不再点亮转圈动画（只留统计栏文字提示），并让新请求取代仍在飞的旧请求，消除并发 `fetchState`（手动刷新 + SSE 推送 + 重试）各占一个 scanning 计数导致按钮长期转圈、旧响应后到覆盖新数据的问题。③ `server.js` 修掉改扫描根时的数十秒假死：`PUT /api/config` 原本先同步 `startWatchers()` 重建**全部** chokidar watcher 再返回响应，大目录（含 `node_modules` 等）遍历建监听要几十秒，浏览器侧实测 8.3s 才收到响应头，前端等不到结果 → 既不弹 toast 也不刷新列表，看起来就是「点了没反应」。现在配置写盘后立即响应，watcher 同步挪到响应之后异步执行；并把 watcher 改为按扫描根增量增删（`watchers` 从数组改为 `Map<root, watcher>`，新增根只建新 watcher、移除根只关对应的、不变的根保持不动），仅 `ignore` / `maxDepth` 变化时才全量重建。浏览器侧添加扫描根耗时从 8271ms 降到 8ms。④ 新增回归 spec `sse-leak-and-retry.spec.js`（13 项，含反向验证：故意用旧的泄漏写法建 4 条连接，确认断言真的会判失败而非空断言），已挂进 `npm test`。⑤ 修 `inline-edit.spec.js` 过时断言：测试算「原文件名」时只剥 `.html`，0.6.0 起支持 Markdown 后对 `.md` 目标文件永远算出带后缀的值，与产品 `stripDocExt` 不一致导致该项恒失败；改为与产品一致的 `/\.(html?|md|markdown)$/i`。⑥ 同步 landing page 版本号与 `package-lock.json`。

- **0.7.2** (2026-07-16) — Bug 修复：解决一键自升级重启后，部分 Chromium 浏览器可能把 `localhost` 标签保留为空文档、而 `127.0.0.1` 仍正常的问题。① `server.js` 为 Dashboard 的 HTML、脚本和样式等静态资源统一发送 `Cache-Control: no-store`，避免升级期间替换全局包文件后继续复用旧 shell、旧脚本或异常空文档缓存。② `public/app.js` 在确认新服务上线后不再调用普通 `location.reload()`，改为携带目标版本号与时间戳执行 `location.replace()`，强制建立一次全新导航；`localhost` 继续通过 Node 默认 IPv4/IPv6 双栈监听正常访问，无需改用 `127.0.0.1`。③ 同步更新 landing page 与 package lock 版本。

- **0.7.1** (2026-07-16) — Bug 修复 + UX 优化：① `server.js` 的局域网分享路由现在会读取 `.md` / `.markdown` 文件并通过共用 Markdown 渲染器返回完整 HTML 页面，同事通过分享链接看到的是渲染后的文档预览，不再是 Markdown 原文；HTML 与其他静态资源继续按原方式发送。② `public/styles.css` 隐藏目录树中与文件类型 icon 重复的 `HTML` / `MD` 彩色角标，仅保留紧凑的类型 icon，同时缩小元素间距和 icon 宽度，并为标题补上 `min-width: 0`，让长标题优先获得空间且继续正确省略。③ `public/vendor/markdown.js` 为链接与图片 URL 增加安全协议白名单，阻断 `javascript:` 等主动内容协议，避免分享页访问者点击恶意链接时执行脚本。④ 同步更新 landing page 文案与 `package-lock.json` 根包版本。⑤ 根据当前 21 个合法发布文件校正 `npm publish --dry-run` 的清单数量范围。

- **0.7.0** (2026-07-13) — 新功能 + UX 修复：**Markdown 只读预览的可折叠侧边目录（TOC）**，以及退出编辑保持浏览位置。① `public/vendor/markdown.js` 的 `renderPage`（服务端 `/api/render-md` 渲染 iframe 只读预览用）重写：新增 `extractHeadings`（给渲染后的 h1–h6 注入去重的锚点 id，中文/连字符保留）、`buildTocTree`/`tocTreeHtml`（按标题 level 组织成嵌套树）、`tocCss`/`tocScript`；页面结构改为「固定侧栏目录 + 居中正文 `.md-inner`」。目录支持：按层级三角折叠展开、点击平滑滚动跳转、`IntersectionObserver` 滚动高亮当前章节并自动展开其父级、左上角独立收起按钮（`localStorage` 记忆 `atlas:mdTocCollapsed`）、窄屏（≤900px）浮层化并点后自动收起。标题少于 2 个的文档不显示目录（正文照旧居中），编辑器分栏预览（用 `render`/`htmlToMarkdown`）完全不受影响。② 修复正文滚到底后靠后标题的锚点跳不动：正文末尾加 70vh 占位留白 + 标题 `scroll-margin-top`。③ `public/app.js`：退出 Markdown 编辑（保存 / 取消都走 `exitEditMode`）时记录编辑器预览面板的滚动**百分比**，iframe 重载后按同比例恢复浏览位置（新增 `pendingPreviewScrollPct` + `applyPendingScrollPct`，换算时从可滚动高度里扣除 `.md-tail-space` 留白，强制 `scroll-behavior:auto` 避免回顶动画），不再跳回顶部。同步更新 `README`（Markdown 段）与 `docs/index.html`（「HTML + Markdown 双模」特性卡）。

- **0.6.0** (2026-07-13) — 新功能：**Markdown 文档支持**（HTML 与 Markdown 可共存）。① 配置从单一 `docType` 升级为多选 `docTypes`（数组，默认 `["html","md"]`，兼容旧 `docType` 字段），设置面板新增「文档类型」复选框，HTML（`.html`/`.htm`）与 Markdown（`.md`/`.markdown`）可同时启用；仅 `docTypes` 变化时不重启 chokidar / 不重挂静态路由（事件回调按类型实时过滤），切换更顺不卡。② 新增零依赖 UMD Markdown 渲染器 `public/vendor/markdown.js`（服务端与浏览器共用，全文转义防 XSS，支持标题/粗斜体/删除线/行内与围栏代码/链接/图片/嵌套有序无序列表/引用/分割线/GFM 表格），并含反向序列化器 `htmlToMarkdown`。③ 后端新增 `GET /api/render-md`（渲染只读预览页）、`GET /api/md-source`（原始源码 + 哈希）、`POST /api/save-md`（baseHash 冲突检测 409 + 备份 + 原子写 + 自我写入抑制）；`/api/state` 与 `/api/config` 携带 docTypes，逐文件带 `docType`；全文搜索对 md 直接按纯文本匹配。④ 前端：md 文件预览走 `/api/render-md`；**源码 / 预览分栏编辑器**——左侧 textarea 每帧实时渲染右侧预览、两侧按百分比滚动同步、进入编辑保持进入前的浏览位置（不再跳到末尾）；**预览区 contentEditable 所见即所得直接编辑**，编辑即反解析回源码。⑤ 目录树按类型区分：HTML 🌐 蓝 `HTML` 角标、Markdown 📝 绿 `MD` 角标 + `data-doctype`，面包屑同步标识；md 文件禁用 PDF 导出（暂仅支持 HTML）。同步更新 `README`、`docs/index.html`（新增「HTML + Markdown 双模」特性卡、hero 文案）与 `package.json`（描述 / 关键词加 markdown）。

- **0.5.1** (2026-07-01) — Bug 修复：`localhost` 打不开的问题。服务器原先 `app.listen(PORT, '0.0.0.0')` 显式绑定只监听 IPv4，而在 `localhost` 优先解析到 IPv6 `::1` 的机器上（尤其叠加本地代理时），浏览器连 `http://localhost:<port>` 会先撞 `::1`（服务器没监听）→ 卡住 / 报错，表现为「能扫描到目录但点开文件白屏/报错」。改为不指定 host（Node 默认绑定 `::` 双栈，同时接受 IPv6 `::1`、IPv4 `127.0.0.1` 与局域网）。安全中间件的本机判定（`LOCAL_ADDRS`）本就包含 `::1`/`::ffff:127.0.0.1`，故本机/局域网权限模型不变。临时绕过：用 `http://127.0.0.1:<port>` 访问。

- **0.5.0** (2026-06-30) — 新功能：**预览区轻量所见即所得编辑**。进入编辑模式后可在预览里直接改文案、拖动列表项 / 表格行 / 同类卡片组排序、以及编辑超链接地址，保存写回磁盘原文件。① 架构「源码锚点」：新增 `lib/editable.js`（parse5 解析源文件、确定性遍历分配 eid、判定可编辑角色 text/list/list-item + 排除 script/style/svg/canvas/pre/code 等风险标签）、`lib/edit-apply.js`（按 eid 精确区间替换文本节点 / 子树重写重排容器，只动改过的字节、其余原样，不序列化运行时 DOM → 图表不被烤坏）、`lib/edit-backup.js`（写盘前备份到 `~/.atlas/backups/`，每文件留 20 份）。新增依赖 `parse5`。② 后端新增 `GET /api/edit-doc`（返回带 `data-atlas-eid`/`role` 标注 + 包裹 span 的编辑文档，注入 base href 与 baseHash）与 `POST /api/save-edits`（baseHash 冲突检测 409、路径/扩展名/体积校验、原子写、自我写入抑制避免误标未读）。③ 前端：工具栏「编辑/保存/取消」按钮 + 编辑态视觉标识；文本节点 contentEditable（混排 `<p>前<b>中</b>后</p>` 的每段独立可编辑）；列表用注入到 iframe 内的 Sortable 拖动重排（`forceFallback`，从文字上按下不误触）；链接内文字聚焦浮出 href 编辑条；编辑态拦截 `<a>` 跳转 / 表单提交避免误导航；进入编辑与保存都瞬间保持滚动锚点（强制 `scroll-behavior:auto` 避免平滑滚动动画）。④ 卡片重排保守识别：仅「同标签+同 class、≥3 个、连续」的同构卡片组可拖，异质子元素（标题/底部）排除。新增 spec `preview-live-edit.spec.js`（32 项，自起隔离实例），已加入 npm test / CI / 本文档 spec 清单，并同步 `docs/index.html` 特性卡与 README。

- **0.4.6** (2026-05-26) — UX 修复：用户 `npm i -g` 升级 atlas 但忘了 `atlas restart` 时，跑着的 daemon 还是旧版本 server.js（无 `/api/share/*` 路由）→ 点分享按钮报 `HTTP 404` 让人摸不着头脑。① 启动时探测 `/api/shares`（0.4.4+ 新加端点），404 就弹 info toast 提示"Atlas 服务是旧版本——在终端运行 atlas restart 重启即可"。② 点 share 按钮命中 404 时改文案："分享功能不可用 / Atlas 服务还在跑旧版本——请在终端运行 atlas restart 重启"。

- **0.4.5** (2026-05-26) — ① 新功能：**Atlas favicon**——蓝紫渐变圆角方块 + 白色 line 风 A 字母，沿用 sidebar brand mark 视觉，SVG 矢量，128/48/32/16 全尺寸清晰。同时挂到 dashboard 和 landing page。② UX：顶栏右上角加**分享按钮** `#btn-share`——点击 = 对当前预览文件 openShareModal（已有 token 复用）。当前文件正在分享时按钮变 accent 蓝边框 + 蓝色 icon，一眼看出状态（不用 hover 文件行才看到角标）。③ UX：「在浏览器新标签打开」按钮 ⤴ emoji 容易和分享 icon 混淆，换成 lucide 风的 external-link line icon（方框 + 右上斜出箭头 + 内部小开口），和分享按钮的"三圆点连线"完全区分。

- **0.4.4** (2026-05-26) — ① 新功能：**局域网分享 + 二维码**。文件 hover 出 🔗 按钮，弹 modal 含大二维码 + 三种 URL（多网卡 + 本机）+ 复制按钮 + 停止按钮。token 16 字符不可猜，store 持久化（atlas 重启不失效）。**安全**：Express 中间件按来源 IP 分流——localhost 全开 dashboard，LAN 访问 403，仅放行 `/share/<token>/*`，path traversal 严格防御（resolve 后必须仍在原 HTML 同目录子树）。② 新功能：归档项目分组——删除文件夹不再"删完自动回来"，而是进入归档列表，下次扫描跳过。磁盘文件不动，设置面板可恢复。③ 安全开关：设置面板加"停止全部分享"红色按钮（评审完一键关）。④ UX：设置 icon 从 ⚙ emoji（在 light 主题下渲染像眼睛）换成 SVG 齿轮 line icon，识别度高。⑤ 启动 banner 多打印一行 LAN IP 让用户知道"分享时同事会看到的 URL 是什么"。

- **0.4.3** (2026-05-26) — ① 新功能：**导出 PDF**。顶栏新加按钮，后端调本机 Chrome / Edge / Brave / Arc / Vivaldi / Chromium 任一（macOS / Linux / Windows 候选路径全覆盖）的 `--headless=old --print-to-pdf` 渲染，布局 100% 保真。SSE 推阶段进度（launching / rendering / writing），前端 toast 升级支持 progress 模式（不自动消失 + 旋转图标 + 底部 indeterminate accent 流动条 + 阶段文字）。同名自动加 `(2)`/`(3)` 后缀，文件名清洗中文 / 特殊字符。串行队列避免快速连点冲突，自动重试一次应对 Chrome `allocator` 间歇 bug。找不到 chromium 时降级到 `iframe.contentWindow.print()` 弹原生打印对话框。② 新功能：**三档排序** segmented control（按名称 / 按时间 / 自定义），默认按名称——系列文档（v1/v2/v3）自然聚合。直接拖动文件自动切到"自定义"。`localStorage` 持久化。③ 新功能：**单文档刷新**按钮——刷当前 iframe，不刷整个 Dashboard，树展开 / 滚动 / 最近列表全保留；刷完顺便标已读清红点。④ 排序 UI 改 IDE 工具栏 inline 风（无外框、accent 文字色 + 短下划线 active 标识），"仅未读" checkbox 合并到同一行；右下角 toast 反馈 → 按钮自身高亮反馈。

- **0.4.2** (2026-05-25) — ① 新功能：发版第一时间通知用户。server 端 npm 检查频率从 24h 改 1h，发现新版本立即通过 SSE 推到所有打开的 tab；新连接进来也立即推已知更新。② 新功能：醒目的更新 banner（顶栏下方一条 36px 的 IDE 风格通知条）—— 红点脉动 + accent stripe + "立即更新"主按钮 + 命令块兜底（点击复制 `npm i -g atlas-dashboard@latest`） + ✕ 关闭。dismiss 过的版本 localStorage 记忆，新版本到来时自动重新弹。③ **一键自升级**：banner "立即更新"按钮触发 `/api/self-upgrade` SSE 流——后端 spawn `npm i -g atlas-dashboard@latest`，stdout/stderr 实时回推，banner 切到 busy 模式（流动进度条 + 阶段文字 + 可折叠"查看日志"）；安装完成 spawn 独立 helper 脚本（`lib/restart-helper-template.js`）等老 server 退、启动新版；前端轮询 `/api/state` 等新 server 上线，自动 reload 页面。失败切换到 error 态显示原因 + [重试] 按钮 + 命令兜底。④ 桌面通知：发现新版本时（已授权 Notification）每个版本会话发一次。

- **0.4.1** (2026-05-25) — ① 新功能：增/删扫描根、保存失败时给右下角 toast 反馈（success / info / error 三类，~2.8s 自动消失，可手动关闭）。② 重要稳定性修复：当扫描根下存在 unix socket / 锁文件（如 `axon.sock`）时，chokidar 抛 UNKNOWN error 直接打挂 server。给 watcher 注册 error handler 并把 `.sock/.lock/.pid` 加入忽略列表。③ 命名优化：散落在扫描根直接根目录下的 HTML 之前会被归到一个叫 `_root` 的兜底虚拟文件夹，开发味儿太重；现在 fallback 改成 `path.basename(scanRoot)`（如 `OtherHTML`），并提供一次性自动迁移把已有 `_root` 改名。④ 0 个 HTML 后代的空虚拟文件夹自动从树里剔除，避免删 HTML 后留一堆空壳 noise。新加 spec `toast.spec.js`（11 项），并加入 npm test 与 CI workflow。

- **0.4.0** (2026-05-25) — 新功能：Dashboard 设置面板加"浏览…"目录选择器，**不用再手输扫描根的绝对路径**。后端新增 `GET /api/browse` 端点（按 OS 权限列出目录、`~` 自动展开 home），前端在 root-add 区下方展开 picker UI（面包屑路径 + ↑ 上级 + ⌂ 主目录 + 子目录列表 + 「选择此目录」），同步 `docs/index.html` 的"多扫描根"卡。新加 spec `dir-picker.spec.js`（14 项）。

- **0.3.2** (2026-05-22) — 修复 folder header 点击有时不响应（要点 2-3 次才能折叠/展开）。和 0.3.0 file 那个 click bug 同源——SortableJS forceFallback 模式吞掉 click 事件。folder header 也改用 `pointerdown` 记位置 + `pointerup` 检查偏移触发 toggleFolder，绕开 click 事件链。新加 spec `folder-toggle-with-jitter.spec.js`（4 项）。

- **0.3.1** (2026-05-22) — ① 修复全文搜索：中文单字（如"灯"）原本被 `q.length < 2` 拦截不发请求。后端区分 ASCII / 非 ASCII，中文/日文/韩文等单字符放行，ASCII 仍要求 ≥ 2 字符避免 'a' 这种太宽的查询。② 新功能：打开文件后 iframe 内自动高亮命中文字（同源直接操作 contentDocument，TreeWalker 注入 `<mark>`），首个匹配自动滚到中间标橙色，顶栏出现 `1 / N` 跳转徽章 + ▲▼ 按钮，搜索框 Enter / Shift+Enter 也能跳。

- **0.3.0** (2026-05-22) — ① 修复：鼠标点击文件时若有 1-3px 抖动会被 SortableJS 当成拖拽吞掉 click，表现为"点 3-4 次才打开"。改用 pointerdown 记位置 + pointerup 检查偏移触发 openFile，绕开 click 事件链。② 升级提示：CLI 启动时显示新版本可用（每天最多查一次，缓存到 `~/.atlas/update-check.json`）；Dashboard 顶栏右侧出现脉动小标签，点击复制升级命令。③ GitHub Releases 自动化：push tag `v*` 时 workflow 抽取 PUBLISHING.md 当版本描述自动创建 Release。
- **0.2.1** (2026-05-22) — 修复：键盘导航留下的 `.kbd-focus` 视觉态没自动清除，与 `.active` 同时出现造成"多个文件被选中"的视觉异常。`setActiveFile` 切换 active 时统一清掉 kbd-focus，CSS 上 kbd-focus 改为 outline-only（不再争夺背景色）。
- **0.2.0** (2026-05-22) — 三个功能改进：① 键盘导航（搜索框 `↓` 进列表、`↑↓` 切换、`Enter` 打开、`Esc` 回搜索）；② 最近打开快捷栏（侧栏顶部 LRU 队列，最多 10 项，跨项目秒回）；③ HTML 全文搜索（后端 contains 匹配 + mtime 缓存，仅内容命中的文件标 🔍）。GitHub Actions CI 落地（push/PR 自动跑测试）。
- **0.1.2** (2026-05-21) — 加拖拽 hover-to-expand：拖文件悬停在折叠 folder 头上 600ms 自动展开。`forceFallback: true` 让 SortableJS 走统一 mouse 事件路径；`document.mousemove + elementFromPoint` 检测鼠标下方真实元素（onMove 不可靠，只在 sibling 切换时触发）。同步 `state.collapsed` + localStorage 持久化。
- **0.1.1** (2026-05-21) — 加 `atlas start / stop / restart / status / log` 守护进程子命令。PID 文件升级为 JSON（含端口 + 启动时间），status 准确显示真实端口。不再依赖用户本地 `~/.zshrc` alias。
- **0.1.0** (2026-05-21) — 首次发布。CLI、首次引导、嵌套分组、桌面通知、备注名等全部功能就位。
