# 发布流程

`atlas-dashboard` 发布到 npm 的标准流程。**只有维护者用得上**，最终用户看 README.md。

---

## 准备一次性的环境

只在第一次发布做：

1. **登录 npm**
   ```bash
   npm whoami            # 已登录会显示用户名（如 d4monwang）
   # 没登录：
   npm login --auth-type=web
   ```

2. **配置 Granular Access Token**（推荐做法，长期免 OTP）
   - 在 https://www.npmjs.com/settings/<user>/tokens 创建 Granular Access Token
   - Scope 限定为 `atlas-dashboard`，权限 `Read and write`
   - **勾选 `Bypass two-factor authentication when publishing packages`**
   - 复制 token，直接在终端跑（**不要粘贴到任何聊天/笔记/git**）：
     ```bash
     npm config set //registry.npmjs.org/:_authToken <粘贴 token>
     ```
   - 验证：`grep -c "_authToken" ~/.npmrc` 输出 `1` 即成功
   - 备选：账号 2FA 用 passkey/Authenticator，每次 publish 加 `--otp=<6位>`

3. **本地必须有一个 Atlas 服务在跑**（部分回归 spec 需要）
   ```bash
   atlas-start      # ~/.zshrc 里的别名，启动到 :4321
   ```

---

## 发布流程（每次新版本）

```bash
cd ~/Documents/AIProjects/Atlas

# 1. 跑回归测试，确保所有 spec 通过
node tests/inline-edit.spec.js
node tests/sidebar.spec.js
node tests/scroll-stuck.spec.js
node tests/no-sortable-leak.spec.js
node tests/sidebar-perf.spec.js   # 性能门槛
# 期望：全部输出 "✓ 全部通过" 或 "失败 0 项"

# 2. 决定版本号（语义化版本）
#    - patch (0.1.0 → 0.1.1)：bug 修复 / 文档调整
#    - minor (0.1.0 → 0.2.0)：新功能、向后兼容
#    - major (0.1.0 → 1.0.0)：破坏性变更（配置格式、CLI 参数等）
npm version patch         # 手动改 package.json 的 version 字段也行

# 3. dry-run 看清单（不会真发）
npm publish --dry-run
# 检查：name 是 atlas-dashboard、version 对、文件清单是 10 个左右、
#       没有意外的文件（比如 tests/、data/、config.json、tgz）

# 4. 真实发布
npm publish                       # 配了 bypass-2FA token 时一句话搞定
# 如果用 Authenticator 而非 token：
# npm publish --otp=<6位TOTP>

# 5. 验证发布成功
npm view atlas-dashboard          # 看 latest 版本
npm view atlas-dashboard versions # 看所有历史版本

# 6. 升级本机的全局安装
npm i -g atlas-dashboard@latest
atlas --version                   # 应显示新版本号
```

---

## 端到端冒烟测试（强烈建议每次都做）

模拟"陌生人首次安装"，确保新版可用：

```bash
TMP=$(mktemp -d)
cd "$TMP"
npm init -y > /dev/null
npm install atlas-dashboard@<新版本> --silent

# 用临时配置不污染 ~/.atlas
mkdir -p "$TMP/atlas-home" "$TMP/docs/proj"
echo '<html><body>SMOKE</body></html>' > "$TMP/docs/proj/test.html"

cat > init.js <<EOF
const prompts = require('prompts');
prompts.inject(['$TMP/docs', 4399, 'node_modules,.git', 4]);
require('atlas-dashboard/lib/init').runInit().then(()=>process.exit(0));
EOF
ATLAS_HOME="$TMP/atlas-home" node init.js

ATLAS_HOME="$TMP/atlas-home" node_modules/.bin/atlas > /tmp/smoke.log 2>&1 &
sleep 2
curl -s http://localhost:4399/api/state | head -c 200
echo ""
lsof -ti :4399 | xargs kill
rm -rf "$TMP"
```

期望：能打印出 `{"tree":[...],"files":{...}}` 即说明发布成功且能跑。

---

## 出错怎么办

| 现象 | 原因 / 修复 |
|---|---|
| `401 Unauthorized` | token 过期或被 revoke，重新生成 + `npm config set //registry.npmjs.org/:_authToken <new>` |
| `403 Two-factor authentication required` | token 没勾 bypass-2FA，或没用 token；重新生成时勾上那一项 |
| `You cannot publish over the previously published versions` | 同一版本号重复发，必须 `npm version patch` |
| `EPUBLISHCONFLICT` | 同上 |
| 发完发现 bug | 24 小时内可 `npm unpublish atlas-dashboard@<version>`；超过只能 `npm deprecate` 标记弃用，再发新版本 |
| 发完别人装不到 | 等 1-2 分钟 CDN 同步；用 `npm view atlas-dashboard` 二次确认 |
| token 不慎泄漏 | 立刻去 https://www.npmjs.com/settings/<user>/tokens 点 Revoke，生成新 token |

---

## 附录：配置 Authenticator App

第一次启用 2FA 时如果没看到二维码（直接给了 recovery codes），按以下流程**重新启用**：

1. 浏览器打开 https://www.npmjs.com/settings/d4monwang/profile
2. 滚到 **Two-Factor Authentication** 区块
3. 点 **Disable 2FA** → 输入密码 → 输入一个 recovery code（消耗一个）确认
4. 现在 2FA 已禁用，重新点 **Enable 2FA**
5. 选择 **Auth and writes**（每次写都要 OTP，最严，推荐）
6. 重要：选择 **Authenticator app** 而不是 Security key / Passkey
7. 这步会显示 **新的 10 个 recovery codes**，复制保存（旧的全部作废）
8. 点 **I have saved my recovery codes**（按钮文案可能略不同）
9. **下一步：显示二维码** + 一个输入 OTP 的框
10. 打开 Authenticator app → 加号 → 扫描二维码 → 出现 npm 那一项
11. 把 Authenticator 显示的 6 位 OTP 输入网页验证
12. 看到 "2FA is enabled" 就完成

之后 publish 直接 `npm publish --otp=<6位>` 即可，OTP 30 秒一刷新。

---

## 版本历史维护

每次发布后更新本文件底部"已发布版本"列表（手动维护，便于以后查回滚点）。

### 已发布版本

- **0.1.1** (2026-05-21) — 加 `atlas start / stop / restart / status / log` 守护进程子命令。PID 文件升级为 JSON（含端口 + 启动时间），status 准确显示真实端口。不再依赖用户本地 `~/.zshrc` alias。
- **0.1.0** (2026-05-21) — 首次发布。CLI、首次引导、嵌套分组、桌面通知、备注名等全部功能就位。
