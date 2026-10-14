# dsh-free-api

多平台 AI 代理网关：把 **workbuddy(腾讯 CodeBuddy)、Trae(字节)、通义千问(chat.qwen.ai)、千问办公(QwenWork)、Qoder(阿里，国内/国际)、以及任意 OpenAI 兼容 API / 本地模型(Ollama)** 统一代理成标准 API，供各类 harness 工具（Claude Code、Cline、OpenClaw、Cursor 等）接入。自带网页管理面板。

```
harness 工具 ──►  本网关 (OpenAI /v1  +  Anthropic /v1/messages  +  MCP /mcp)
                        │
                        ├─ 逆向平台（账号池，多账号轮询）
                        │   ├─ workbuddy / CodeBuddy (腾讯) → copilot.tencent.com
                        │   ├─ trae (字节)                  → trae-api-cn.mchost.guru
                        │   ├─ qwen (chat.qwen.ai)          → 千问网页版
                        │   ├─ qwenwork (千问办公)          → gateway.qwenwork.cn
                        │   ├─ qoder · Qoder 国际版          → api1.qoder.sh
                        │   └─ qodercn · Qoder 中国版        → gateway.qoder.com.cn
                        ├─ 国际官方 API（key 即用）
                        │   ├─ OpenAI · Anthropic · Google Gemini · xAI(Grok) · Mistral
                        │   ├─ OpenRouter · Groq · Together · Perplexity · Cerebras · GitHub Models
                        ├─ 国内官方 API（key 即用）
                        │   ├─ 阿里百炼(Qwen) · 智谱GLM · 月之暗面Kimi · MiniMax · 火山方舟(豆包)
                        │   ├─ 腾讯混元 · 百川 · 阶跃星辰 · 硅基流动 · 书生 · 魔搭 ModelScope
                        └─ 本地 / 自定义
                            ├─ ollama（本地模型）
                            └─ openai-compat（任意 OpenAI 协议服务）
```

## 快速开始

```bash
npm install
npm start                 # 默认 http://localhost:8317
```

- 管理面板：http://localhost:8317/admin （默认密码 `admin`，请立即在设置页修改）
- 接入 harness：
  - OpenAI 协议：`base_url = http://localhost:8317/v1`，`model` 见 `/v1/models`
  - Anthropic 协议（Claude Code）：`ANTHROPIC_BASE_URL=http://localhost:8317`，`ANTHROPIC_AUTH_TOKEN=<你的key>`
  - MCP 客户端：端点 `http://localhost:8317/mcp`（JSON-RPC over HTTP）
- 接入 ZCode：`node scripts/zcode-integrate.js` 一键把网关写成 ZCode 自定义提供商（OpenAI 兼容，模型优先取统一模型；写入前自动备份 `~/.zcode/v2/` 两个配置文件，重启 ZCode 后选择提供商「dsh-free-api」）
- 文档教程：面板「文档教程」页（给人看的接入指南 + 给 AI 看的对接说明，可一键复制）；AI 也可直接读 `http://localhost:8317/docs/api.md`（无需登录，实时生成）

环境变量：`DSH_PORT`(8317)、`DSH_ADMIN_PASSWORD`、`DSH_API_KEYS`(逗号分隔，和面板生成的 key 二选一或共存)、`DSH_DATA_DIR`。

## 使用流程

1. **添加账号**（面板 → 平台账号 → 添加 / 或点「扫描本机登录」按钮导入本机已有登录态）
   - **手动扫描导入**：面板 → 平台账号 → 「扫描本机登录」，会扫描本机 Trae / TRAE SOLO / CodeBuddy(WorkBuddy) / Qoder CLI / 千问办公客户端 的已登录凭证并导入（按凭证指纹去重，可重复点击）。加密格式的凭证（新版 Trae / CodeBuddy `$wbEncrypted`）无法直接读出，面板会提示改为手动粘贴 token。
   - **手动添加**：面板 → 平台账号 → 「+ 添加账号」，选平台后按表单填凭证。各平台凭证来源：
     - Trae：本机 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide` 值（或抓 IDE 请求头 `Authorization` 里的 JWT）
     - WorkBuddy/CodeBuddy：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`，或抓包 `copilot.tencent.com` 请求头 `Authorization`
     - Qoder（国内版 / 国际版同一步骤）：客户端 设置 → Integrations 创建 PAT（`pt-` 开头，最稳）。两个版本是两套独立账号体系，账号分别挂在「Qoder 国际版」「Qoder 中国版」两个平台下；「扫描本机登录」会各扫各的。
     - 千问：chat.qwen.ai 登录后 Cookie 里的 `token`；也可直接填邮箱+密码由网关自动登录续期
     - 千问办公(QwenWork)：推荐「扫描本机登录」自动读取客户端登录态（`%APPDATA%\QwenWorkCN\auth-v2.dat`）；或添加账号弹窗点「网页授权登录」（设备码流程，无需客户端）；聊天需本机装有千问办公客户端（wasm 签名）
2. **同步模型**（仪表盘 → 平台「同步模型」；之后可逐个模型 启用/停用/改名/设倍率/打标签）
3. **生成 API Key**（可限定该 key 能用的模型、限速）
4. 在 harness 工具里配上面三个端点即可

## 功能对照需求

| 需求 | 实现 |
|---|---|
| 保留平台倍率/免费信息 | models 表 `multiplier`/`is_free` 字段；插件同步时带入；Qoder 错峰倍率、workbuddy hy3 免费、千问全免费等 |
| 多账号登录与切换 | accounts 表按平台任意多账号；优先级+轮询+并发上限；401/403 自动标记失效，5xx 指数退避冷却 |
| 网页后端管理 | `/admin` 单页面板：账号/模型/Key/用量/MCP/测试台/设置 |
| 网页测试 | 测试台：选模型 → 流式/非流式 → 实时输出+token+积分耗时 |
| 剩余积分 | 账号「检查」按钮调用各平台积分接口（trae 签到状态、qoder 官方 quota、codebuddy billing、qwen 档案、qwenwork 三池积分：每日免费/订阅/长期） |
| 用量/禁用启用/搜索筛选 | usage 全量日志（时间/平台/账号/模型/token/积分/耗时/状态），各列表页均带搜索+筛选 |
| 扩展接口 | provider 插件协议（见 `src/core/registry.js` 注释）；新增平台=一个文件；已内置 24 个官方厂商 + openai-compat/ollama 通用插件 |
| 账号-模型绑定管理 | 模型层面启停 + API key 级 `allowed_models` 白名单 |
| 本地集成 | 「导入本机登录」扫描 Trae/CodeBuddy/Qoder（国内版+国际版分别扫）/千问办公客户端 的本地凭证文件 |
| 主流协议 | OpenAI `/v1/chat/completions`、`/v1/completions`、`/v1/models`；Anthropic `/v1/messages`（含 thinking/tool_use）；MCP 网关 |

## 已知限制（如实说明）

- **逆向平台随时可能变化**：端点/加密/风控来自开源社区逆向成果（见下），上游改版后需要跟着更新对应插件。Trae 本地存储若为加密格式，需手动粘贴 token；WorkBuddy 新版客户端的 `$wbEncrypted` 信封同理。
- **Qoder COSY 签名**未完整实现（签名+AES+RSA 链路复杂），当前用 PAT 模式（官方支持创建，最稳）。
- **千问办公（qwenwork）**聊天请求体必须由官方客户端自带的 `qoder_auth_wasm_bg.wasm` 签名（本机需安装千问办公客户端；运行时从安装目录读取，不随本仓库分发）。积分与账号检查无需客户端。上游 1.2.x 已验证，客户端大版本更新后可能需要适配。
- MCP 网关目前支持 tools 的 list/call（stdio + http 传输），resources/prompts 未实现。
- 单机 SQLite，无分布式；面向个人/小团队本地使用。

## 参考的开源项目

本项目为原创代码，但上游平台协议细节参考了这些项目的公开逆向成果：
- Trae: `JeffHu0912/trae2api`、`Trae2api-cn`、`A-23187/trae-api`
- WorkBuddy/CodeBuddy: `linguo2625469/workbuddy2api-panel`、`xiaofan6ya/workbuddy2api`
- Qoder: `shuishuipingan/qoder2api-hub`、`fengyinxia/qoder2api`、`Zhengyuuuui/qoder2api`
- QwenWork (千问办公): `wearetheone777/dumate2api`、`wpy030414/xrl-router-plugin-qwenwork`；wasm 签名封装基于 `wicm84266964/Buddy2api`（MIT，`src/providers/_qwenwork_wasm_helper.mjs`）
- Qwen: `LLM-Red-Team/qwen-free-api` 系

⚠️ 使用逆向接口请自行评估各平台服务条款与账号风险。

## Git 管理

- `main` 稳定发布分支（tag：`v0.1.0` 逆向平台版、`v0.2.0` +24 官方厂商）
- `dev` 开发分支，功能验证后合入 main 并打 tag
- `data/`（数据库）、`logs/`、`.env` 均已 gitignore，凭证不会入库

## 测试

```bash
npm start &        # 先起服务（全新 data）
npm test           # 19 个端到端用例
```
