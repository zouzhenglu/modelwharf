# Changelog

本文件记录面向用户的显著变更。版本与 git tag 一一对应；日期为 tag 创建日期。

## [0.12.0] - 2026-10-25

### Added
- **WorkBuddy 国际版独立通道 `workbuddyintl`**：与国内版同一套协议（聊天/模型/续期），网关 `www.workbuddy.ai`；支持本机扫描（按客户端 `auth.domain` 自动分流，国际版文件 `workbuddy-desktop-ai.info`）、设备码网页授权登录、账号体检。实测差异（2026-10-25）：国际版积分/签到接口对插件 token 返回 401，故国际版账号体检用最小聊天请求探活，且无签到
- 面板「网页授权登录」按钮改由服务端声明（`/admin/api/providers` 新增 `supports_oauth`），新通道自动获得按钮，不再硬编码平台名单
- 本地扫描遇到 `$wbEncrypted` 加密信封时**始终**给出提示（此前同目录还有旧明文文件时静默，用户会误把过期历史文件当当前登录态）；并识别对象形态的加密信封（新版客户端格式）
- **免费模型优先展示**：`/v1/models`（含 Anthropic 协议与 `/docs/api.md`）与管理面板模型列表中，免费模型（`is_free=1`，如 workbuddy hy3 系列、千问全系列）始终排在计费模型前面，工具的模型选择器里一眼可见；模型管理「能力标签」列的 `free` 标签着绿色（与「免费」徽章同色系）
- **模型列表带费率标签**：`/v1/models`（OpenAI 与 Anthropic 协议）返回的模型 id 直接带费率后缀——免费模型 `·免费`、倍率≠1 的计费模型 `·x<倍率>`（如同一 DeepSeek V4.1 Flash 的 `deepseek-v4.1-flash-intl ·免费` 与 `deepseek-v4.1-flash-sg ·x0.03` 在工具的模型选择器里一眼可分）；同时附带 `x_free` / `x_multiplier` 字段供程序消费。标签只是展示别名：客户端原样回传时，网关在路由与 key 白名单校验前剥掉（`engine.runChat` / `runEmbeddings` / 三个协议的 allowed 检查），带不带标签、已配置的旧模型名均不受影响
- **`AGENTS.md`**：给 AI 助手的安装与接入手册（安装 → 常驻 → 导账号决策树 → 建 key → 配工具 → 端到端验证），复制一句提示词即可让 agent 全程代办；README「快速开始」提供该提示词
- README 顶部痛点→解法引导文案与标语；「使用方式一览」升级为按读者分类的「文档地图」（新人 / agent / 技术人员 / 已部署）；「部署到服务器 / Docker」从自动化一节独立成节并加对外暴露安全前提；新增「升级与排障」一节

### Fixed
- **逆向平台的工具调用回环（DSML 文本协议）**：qoder/qodercn/trae 上游没有原生 tools 通道，DeepSeek V4 系模型在「工具只出现在提示词文本」时会把工具调用写成正文里的 DSML 标记（`<｜｜DSML｜｜ calls>…`），此前直接透传就是客户端无法执行的乱码文本（`deepseek-v4.1-flash` 在 workbuddy 被风控落到 qodercn 兜底时必现）。现统一走文本工具协议：请求侧注入工具清单、历史 tool_calls/tool 消息转文本，响应侧流式把 DSML 块解析回 OpenAI `tool_calls`（`finish_reason: tool_calls`，流式/非流式/多轮循环均已验证）；trae 顺带修复带工具历史必报上游校验错误（4027/2001）的问题。协议解析器独立成 `src/utils/dsml.js`（带单元测试）。同日 DeepSeek harness 端到端再抓到四类退化输出（`<invoke>` 开标签整缺失、闭标签裸化成 `</｜｜DSML｜｜>`、冗余闭标记连发、全块挤一行），块内解析改为宽容 token 流就近归属，缺失的 invoke 名字按请求 tools 的参数 schema 唯一最优推断（推断不出则丢弃调用但标签照样剥掉），并兼容关键字前无空格的 `<｜｜DSML｜｜calls>` 形态；流式过滤改为无条件启用（首轮流式不带 tools 也会自发输出 DSML）
- **面板平台筛选缺失新平台**：平台分组下拉（模型管理/账号页）用硬编码名单且丢弃未分组平台，`workbuddyintl` 因此从不出现——已补进「逆向平台（账号池）」分组（紧跟 workbuddy）
- **Key 表单模型选择器重做**：候选增加「类型」（统一模型/原始模型）与「平台」双下拉（平台沿用分组名单，含国际版）+ 保留搜索；统一模型此前不过滤启用状态，禁用的统一模型会混进候选——现在统一/原始模型都只列启用中的；新增「全选筛选结果 / 清空已选」批量操作（如筛选「统一模型」后一键全选）
- `/docs/api.md` 生成的示例 URL 此前写死 `http://localhost`，远程/Docker 部署时文档地址全错——现按请求的 Host（及 `X-Forwarded-Proto`）动态生成，用什么地址打开示例就用什么地址
- README 接入示例统一用 `$GW` 表示网关地址（本机默认 `http://localhost:8317`），服务器部署只改一处；「三种协议」措辞修正为「三种 API 协议 + MCP 网关」；安全说明中的旧变量名 `DSH_*` 更正为 `WH_*`

## [0.11.0] - 2026-10-15

### Added
- **控制台图表引擎（纯 SVG，无外部依赖）**：趋势图支持 折线 / 面积 / 柱状 三种形态，请求量 / 失败数 / Token / 积分 / 耗时 五种指标切换；带 Y 轴刻度、时间轴、线端最新值、图例合计，悬浮十字线贴在旁显示该时刻全部指标明细（请求数/失败率/输入输出 tok/积分/耗时）且不遮挡图表
- 趋势图窗口汇总条：总请求 / 失败 / 失败率 / 峰值（含时刻）/ 输入输出 tok / 积分 / 平均耗时
- 仪表盘统计卡：24h 迷你趋势线（sparkline）+ 较昨日涨跌对比（失败数下降计为改善）；新增「今日失败」卡（含失败率）
- 用量日志：结果分布环形图（成功/失败占比 + 中心总量）；模型 / 平台 / 账号 Top 榜两行两列（名称/请求数·占比、入出两值/耗时）+ 名次着色通栏份额条，输入输出拆分常显（悬停看完整文字），单位自动换算（tok/积分/请求数 k→M→B，耗时 ms→s→min）

### Changed
- `/admin/api/usage/chart`：分桶新增 `lat`（平均耗时）/ `latMax`（最大耗时），模型/平台/账号 Top 榜带平均耗时，`byStatus` 带积分
- `/admin/api/stats`：新增 `yesterday` 日聚合（仪表盘「较昨日」对比数据源）
- 用量明细表耗时按 >10s 黄 / >30s 红 标色；CI 自动化（GitHub Actions 测试矩阵 Linux/Windows × Node 22/24、tag 自动发 GitHub Release、Docker 镜像推 GHCR）；测试扩至 55 个端到端用例

### Fixed
- 最低 Node 版本修正为 **≥ 22.19**：`better-sqlite3@13` / `better-sqlite3-multiple-ciphers@13` / `undici@8` 硬性要求 Node 22+，Node 20 下启动即段错误（此前 engines 与 README 宣称的 ≥ 20 不成立）；CI 矩阵改为 Node 22/24
- e2e 启动服务失败时报出子进程启动输出，便于定位（此前只报 "server failed to start"）

## [0.10.0] - 2026-10-15

### Added
- **`POST /v1/embeddings`**：OpenAI 兼容上游（openai-compat / 官方厂商 / ollama）透传 embeddings；虚拟模型同样支持故障转移；逆向平台无 embeddings 能力时明确报 501
- **Anthropic `POST /v1/messages/count_tokens`**：本地 token 估算（CJK≈1 token/字，拉丁≈0.25 token/字符），Claude Code 等客户端不再 404
- **Anthropic `thinking: {budget_tokens}`**：按预算映射思考档位（≥16384 high / ≥4096 medium / 其余 low，`disabled` 关思考）；模型名后缀 `-think` 系列优先级更高
- **OpenAI 采样参数透传**：`stop` / `seed` / `presence_penalty` / `frequency_penalty` / `logprobs` / `top_logprobs` / `n` 透传给 OpenAI 兼容上游；`n>1` 多选完整往返（非流式返回多 choices，流式带每选 index）
- **MCP 网关 resources/prompts**：`resources/list`、`resources/templates/list`、`resources/read`（URI 带 `mcpres://服务id/` 前缀路由）、`prompts/list`、`prompts/get`（名称按 `服务id__提示词名` 聚合）
- **统一模型负载均衡策略**：`priority`（顺序故障转移，默认）/ `weighted`（按权重随机）/ `least_conn`（最少连接优先）；管理面板可配策略与每目标权重，列表页非默认策略带徽标
- legacy `/v1/completions` 多选 `n` 完整支持（非流式返回多条 choices；流式 `n>1` 明确报 400）

### Fixed
- MCP 资源 URI 模板前缀化时 `{placeholder}` 被 percent-encode 导致客户端无法替换（保留原样）
- 统一模型不认 `-think` 系列后缀（`uni-test-think` 404）——剥后缀回查虚拟表
- MCP `tools/call` / `prompts/get` 名称不含 `__` 时切出垃圾标识（如 `echo`→服务 `ech`）——明确报 `-32602`
- 清理死代码：`models.js` 重复定义的 `listPublicModels`、三处永远走不到的 `[DONE]` 分支

### Changed
- **`/mcp` 端点鉴权**：与 `/v1` 网关同语义——配置了 API key 后必须携带 key，未配置任何 key 时保持开放模式
- 测试扩容：34 → 54 个端到端用例（embeddings / count_tokens / thinking 映射 / 采样参数 / MCP 鉴权与聚合 / 负载均衡 / 多选与 legacy completions）

## [0.9.0] - 2026-10-15

### Changed
- **项目更名**：dsh-free-api → **modelwharf（模型码头）**
- 环境变量前缀 `DSH_*` → `WH_*`（旧 `DSH_*` 仍作别名兼容）
- API key 前缀 `sk-dsh-` → `wh-`（旧 key 继续有效）；数据库文件名 `dsh.db` → `wharf.db`（旧库自动沿用，无需迁移）
- ZCode 集成脚本改写 provider id 为 `modelwharf`，重跑会自动清理旧条目 `new-provider-dsh`

## [0.8.0] - 2026-10-15

### Added
- 自动签到调度器 + 签到管理页（UMID 设备指纹）
- 统一模型能力标签：从目标链真实模型自动推导，与模型管理同款 tags 语义

### Changed
- 管理面板全面改版：深空蓝灰设计系统；账号页操作收纳、统一模型目标链垂直排版、平台健康点、搜索筛选、能力标签美化

### Fixed
- 签到状态语义：上游 ok=2（无内容/已禁用）不再误判为已签到

## [0.7.0] - 2026-10-15

### Added
- 千问办公(QwenWork)接入：本机登录态导入 / 设备码网页授权 / 官方 wasm 签名 / 三池积分

### Changed
- qoder 拆分为国际版(qoder)/中国版(qodercn)两个平台，模型族归一化统一聚合

## [0.6.0] - 2026-10-14

### Added
- ZCode 一键集成脚本（`scripts/zcode-integrate.js`，写入前自动备份配置）
- 面板「文档教程」页 + `/docs/api.md` 实时生成的机器可读对接文档
- 扫描本机登录支持排除目录；统一模型一键 create-all

## [0.5.0] - 2026-10-14

### Added
- Qoder 国际版 PAT 支持（双网关 jobToken），PAT 即身份、每 PAT 独立账号
- trae/qoder 速率与标签、workbuddy 账号描述

### Fixed
- qoder 国际版 chat 请求体补齐 model/messages/agent_id 字段
- 无 PAT 的 qoder 账号硬跳过并暴露 intl 路由错误，不再静默

## [0.4.0] - 2026-10-13

### Added
- Responses API（`/v1/responses`，Codex 形态）：流式事件 + reasoning 后缀 `-think` 路由
- 视觉透传、积分/身份展示、预设参数

## [0.3.0] - 2026-10-13

### Added
- 虚拟模型（多账号故障转移）、批量操作、批量检查/积分、用量图表、去重修复

## [0.2.0] - 2026-10-13

### Added
- 24 个官方厂商插件（OpenAI/Anthropic/Gemini/xAI/Mistral/OpenRouter/Groq/Together/Perplexity/Cerebras/GitHub Models/百炼/智谱/Kimi/MiniMax/火山方舟/混元/百川/阶跃/硅基流动/书生/魔搭 等）+ openai-compat/ollama 通用插件

## [0.1.0] - 2026-10-13

### Added
- 首个可用版本：逆向平台账号池网关（workbuddy/trae/qwen/qoder），OpenAI + Anthropic + MCP 三协议，网页管理面板，账号/模型/Key/用量管理，本地登录态扫描导入
