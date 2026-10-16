# AGENTS.md — 给 AI 助手的安装与接入手册

> **你是正在执行安装任务的 AI 助手**（Claude Code / ZCode / Codex CLI / Cursor Agent 等，有本机命令执行能力）。
> 用户的要求大致是：「把这个网关装到我电脑上，把我手头的 AI 积分用起来，配进我在用的工具」。
> 本文档是**可执行步骤**：全程用命令行 + 管理 API 完成，不需要用户打开浏览器（网页授权登录除外）。
> 人类向的完整文档见 [README.md](README.md)；本文只保留你干活需要的部分。

## 0. 完成标准

按顺序做到全部打勾才算完成：

1. 网关在后台运行，且重启电脑后自动拉起（不是临时前台进程）
2. `GET /health` 返回 `{"ok":true,...}`
3. 至少导入 1 个上游账号，模型已同步（`GET /admin/api/models` 非空）
4. 生成 API key，接进用户的目标工具（或由用户指定）
5. 用真实请求端到端验证：`POST /v1/chat/completions` 出字

## 1. 前置检查

```bash
node -v    # 必须 ≥ 22.19
```

版本不够先装（任选其一）：

```bash
# Windows
winget install OpenJS.NodeJS.LTS
# macOS
brew install node
# Linux (Debian/Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
```

⚠️ Node 22.19 是**硬性要求**（better-sqlite3@13 / undici@8），Node 20 下启动即段错误，不要试图绕过。

## 2. 获取代码并安装

```bash
git clone https://github.com/zouzhenglu/modelwharf.git
cd modelwharf
npm install
```

## 3. 启动并常驻

先前台试跑一次，确认能起：

```bash
node src/server.js        # 默认 http://localhost:8317
```

确认 `GET /health` 正常后，改成常驻（**这步不能省**，服务不能随你的会话结束而死）：

```bash
# Linux — systemd 用户服务
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/modelwharf.service <<'EOF'
[Unit]
Description=modelwharf gateway
After=network.target
[Service]
WorkingDirectory=%h/modelwharf
ExecStart=/usr/bin/env node src/server.js
Restart=on-failure
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now modelwharf

# macOS — launchd
# 也可用 pm2：npm i -g pm2 && pm2 start src/server.js --name modelwharf && pm2 save && pm2 startup

# Windows — 计划任务（开机自启）
schtasks /create /tn "modelwharf" /tr "\"C:\Program Files\nodejs\node.exe\" \"$(pwd -W 2>/dev/null || pwd)\src\server.js\"" /sc onlogon /f
# 或把 start.bat 的快捷方式放进 shell:startup 文件夹（Win+R → shell:startup）
```

> 以上命令为 bash 语法（Windows 上在 Git Bash / WSL 里执行；PowerShell 里 `$()` 与引号规则不同，注意转义）。

可选环境变量（在启动命令前设置）：

| 变量 | 默认 | 什么时候改 |
|---|---|---|
| `WH_PORT` | `8317` | 端口被占 |
| `WH_HOST` | `0.0.0.0` | **仅本机用时建议改 `127.0.0.1`**；对局域网/公网开放前必须先设好下面两项 |
| `WH_ADMIN_PASSWORD` | `admin` | 任何时候都建议改掉 |
| `WH_API_KEYS` | 空 | 对外开放时必设，逗号分隔 |

## 4. 验活

```bash
curl -s http://localhost:8317/health
# {"ok":true,"version":"...","providers":["trae","workbuddy","qwen","qoder",...]}
```

## 5. 管理 API：登录与调用序列

> 下文按**网关跑在本机**写（`http://localhost:8317`）。若部署在远程服务器/Docker，把所有 `localhost:8317` 换成实际地址；给工具配 base_url 时同理（客户端可能不在网关同一台机器）。

管理 API 全部在 `/admin/api` 下，先登录拿 token，之后每个请求带 `Authorization: Bearer <token>`：

```bash
# 登录（默认密码 admin；用户改过则用用户告诉你的密码）
WH_TOKEN=$(curl -s -X POST http://localhost:8317/admin/api/login \
  -H 'Content-Type: application/json' -d '{"password":"admin"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 之后的调用都在 curl 头里加：-H "Authorization: Bearer $WH_TOKEN"
```

标准序列（每步的细节见 §6 / §7）：

| 步骤 | 调用 | 说明 |
|---|---|---|
| 导入账号 | `POST /import-local-all` 或 `POST /accounts` 或 OAuth | 见 §6 决策树，按顺序尝试 |
| 同步模型 | `POST /refresh-models-all` | 返回各平台 added/errors |
| 建 key | `POST /apikeys` `{"name":"claude-code"}` | **key 全文仅此一次返回，立刻交给用户存好** |
| 账号体检 | `POST /accounts/check-all` | 积分/余额 + 真实链路探测，验证账号可用 |
| 端到端验证 | `POST /v1/chat/completions`（带 key） | 见 §0 第 5 条 |

改面板密码（建议做完后顺手执行）：

```bash
curl -s -X PUT http://localhost:8317/admin/api/settings \
  -H "Authorization: Bearer $WH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"adminPassword":"<用户设定的新密码>"}'
```

## 6. 导入账号：决策树（按顺序尝试）

### A. 扫描本机登录态（最省事，优先）

```bash
curl -s -X POST http://localhost:8317/admin/api/import-local-all -H "Authorization: Bearer $WH_TOKEN"
```

覆盖 trae / workbuddy / qoder / qodercn / qwenwork 五个平台的本地客户端凭证，按凭证指纹去重，可重复调用。单平台导入：`POST /providers/<id>/import-local`。
前提是用户本机装过对应客户端**且登录过**。若用户没装，引导用户装好并登录后再扫，或走 B/C。

### B. 网页授权登录（无需客户端、无需抓 token）

workbuddy、qwenwork 支持 OAuth 设备码流程：

```bash
# 1. 创建登录会话
curl -s -X POST http://localhost:8317/admin/api/providers/qwenwork/oauth/start -H "Authorization: Bearer $WH_TOKEN"
# 返回 {"state":"...","authUrl":"https://..."} —— 把 authUrl 发给用户，让他浏览器打开完成登录
# （qwenwork 登录后页面跳到打不开的 qwenwork-cn:// 属正常现象）

# 2. 轮询直到拿到凭证（每 2 秒一次，通常 <1 分钟）
curl -s -X POST http://localhost:8317/admin/api/providers/qwenwork/oauth/poll \
  -H "Authorization: Bearer $WH_TOKEN" -H 'Content-Type: application/json' -d '{"state":"<上一步的state>"}'
# {"pending":true} 继续等；{"pending":false,"account_id":...} 成功，账号已自动入库
```

workbuddy 同理，把路径里的 `qwenwork` 换成 `workbuddy`。

### C. 手动凭证（POST /accounts）

```bash
curl -s -X POST http://localhost:8317/admin/api/accounts \
  -H "Authorization: Bearer $WH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"provider_id":"trae","name":"主号","credentials":{"token":"eyJ...","region":"cn"}}'
```

各平台 `credentials` 字段与获取方式：

| provider_id | 关键字段 | 凭证来源（按推荐顺序） |
|---|---|---|
| `trae` | `token`（JWT）、`refreshToken`?、`region`? | ① 扫描（A）② 读 `%APPDATA%/Trae CN/User/globalStorage/storage.json` 里 `"iCubeAuthInfo://icube.cloudide"` 的值 ③ 抓 IDE 请求头 `Authorization` |
| `workbuddy` | `token`、`refreshToken`?、`userId`?、`region`? | ① 授权登录（B）② 扫描（A）③ 读 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` ④ 抓包 `copilot.tencent.com` 的 `Authorization` |
| `qoder` / `qodercn` | `pat`（`pt-`开头）、`region`? | ① **PAT 最稳**：Qoder 客户端 → 设置 → Integrations 创建 ② 扫描（A）。国内版账号挂 `qodercn`，国际版挂 `qoder` |
| `qwen` | `token` 或 `email`+`password` | ① 填邮箱+密码，网关自动登录续期（最省心）② 浏览器登录 chat.qwen.ai → Cookie 里 `token` 字段 |
| `qwenwork` | `token`、`refreshToken`?、`uid`（**必需**） | ① 授权登录（B）② 扫描（A，会自动带 uid）③ 手动：token+uid（uid 在 `~/.qoderworkcn` 或客户端数据目录） |
| 官方 24 家（`zhipu`/`moonshot`/`siliconflow`/`deepseek`/…） | `apiKey` | 用户到对应官网注册拿 key，即用。`GET /admin/api/providers` 查全部 id 与字段定义（`credFields`） |

**你有 shell 权限时**：可以直接替用户读 A/C 表格里的本地文件路径、提取 token、再 `POST /accounts`——效果等同扫描，且能处理扫描之外的路径。加密信封（新版 Trae / CodeBuddy 的 `$wbEncrypted`）读不出明文，改走 B 或让用户手动粘贴。

### D. 官方 API 兜底

上面全走不通时（用户没有任何逆向平台账号），引导用户注册 1-2 家官方 API（智谱 GLM、Kimi、硅基流动等，注册即送额度），只粘一个 `apiKey` 就能用，链路也最稳。

## 7. 接进用户的工具

按用户在用的工具选择；不确定就问。所有协议共用同一个 key。

```bash
# ZCode —— 一键脚本（自动取/建 key、写配置前备份原文件）
node scripts/zcode-integrate.js

# Claude Code / Anthropic 协议
export ANTHROPIC_BASE_URL=http://localhost:8317
export ANTHROPIC_AUTH_TOKEN=wh-...        # §5 生成的 key

# Cursor / Cline / 任意 OpenAI 兼容工具
# Base URL: http://localhost:8317/v1      API Key: wh-...

# Codex CLI —— Responses 协议
# base_url = http://localhost:8317/v1（Wire API 选 Responses）
```

不知道用户工具的配置格式时，读网关自带的接入文档（实时生成，含模型清单）：

```
http://localhost:8317/docs/api.md
```

## 8. 端到端验证（完成前必做）

```bash
curl -s http://localhost:8317/v1/chat/completions \
  -H "Authorization: Bearer wh-..." -H 'Content-Type: application/json' \
  -d '{"model":"<从 /v1/models 选一个>","messages":[{"role":"user","content":"你好"}],"stream":false}'
# 出正常回复 → 全部完成
```

- 模型清单：`GET /v1/models`（key 限定 allowed_models 时只返回可用的）
- 账号异常时：`GET /admin/api/accounts` 看 status（`invalid` = 失效，重新导入；`cooling` = 冷却，稍等）
- 逆向平台失败率高：`POST /admin/api/accounts/check-all` 做链路探测定位是账号问题还是上游改版

## 9. 常见故障

| 现象 | 原因与处理 |
|---|---|
| 启动即段错误 / native module 报错 | Node < 22.19，回 §1 升级 |
| `EADDRINUSE` | 端口占用，设 `WH_PORT` 换端口 |
| 扫描导入 0 条 | 用户本机没装客户端或没登录；加密凭证扫不出，走 B/C |
| qwenwork 聊天报错 | 聊天需本机装千问办公客户端（wasm 签名，运行时读安装目录）；积分/账号检查不受影响 |
| 上游 401/403 | 凭证过期或风控。trae/workbuddy 可给账号补 `refreshToken` 自动续期；qwen 用邮箱+密码模式 |
| 上游 5xx / 连不上 | 逆向平台随时可能改版（README「已知限制」），检查仓库有无新版本，或暂用官方 API 平台 |

## 10. 安全红线

- 用户的上游凭证只存本机 SQLite（`data/` 目录，已 gitignore）——**不要**把 `data/`、`.env` 复制到别处、贴进对话或提交进仓库
- key（`wh-` 开头）生成后直接交给用户本人，不要写进会公开的地方
- 对外暴露网关前必须：改掉默认密码 + 设 `WH_API_KEYS`；默认开放模式只适合本机使用
- 如发现安全问题，提醒用户按 README「安全说明」私下联系仓库所有者，不要公开提 issue
