# 小红书与 LinkedIn 建联工作台

## 业务问题

商务/招聘人员需要在小红书、LinkedIn 上逐个打开陌生人主页、读资料、写私信，重复操作多、易触发平台风控。本工具把这条链路收敛为本地可控的自动化：输入账号主页 URL，系统通过 CDP 直连已登录的 Chromium 完成打开主页、读取会话、AI 生成建议、发送私信；任何不确定的情况（登录墙、验证码、风控、页面结构变化）一律停下来交还人工，不硬闯。

**交付边界**：小红书链路完整可用；LinkedIn 已完成适配层与发送，会话读取仍是占位实现，发送前须人工确认。

## 架构

```
server.mjs            HTTP 路由 + 错误映射（业务逻辑为零）
  └─ lib/actions.mjs  业务编排：状态机、trace、幂等、降级（可注入 mock 适配器做离线评测）
       ├─ lib/state-machine.mjs  会话状态机（显式合法迁移表，非法迁移拒绝并落事件）
       ├─ lib/trace.mjs          trace_id + spans，落 traces 表
       ├─ lib/ai.mjs             AI 建议工具契约（输入/输出校验、超时、错误分类、模板兜底）
       ├─ lib/db.mjs             SQLite 数据层（node:sqlite，六张表）
       └─ lib/cdp.mjs            CDP 协议客户端（/json 发现 + 原生 WebSocket 命令通道，类型化错误码）
            ├─ lib/xhs-adapter.mjs      小红书自动化（多候选选择器 + hover 探测 + 几何启发式 + 发送闭环校验）
            └─ lib/linkedin-adapter.mjs LinkedIn 自动化
public/               原生 JS 三栏前端（会话列表 / 聊天详情 / 风格面板）
scripts/eval.mjs      离线评测套件（不依赖浏览器，29 条用例）
```

零 npm 依赖，仅使用 Node.js >= 22 内置能力（`node:http`、`node:sqlite`、原生 `WebSocket`、`fetch`）。

## 会话状态机

所有状态变更必须经过合法迁移表校验（`GET /api/state-machine` 可查看完整定义）：

```
created → opening → opened → synced → ai_ready → sent
                                 ↘ send_failed（可重试）
任意活跃状态 → paused / need_human（记录 prev_status）
paused / need_human → prev_status（恢复回到暂停前状态，而非固定状态）
```

- 未打开就 sync、未同步就 send 等越级操作返回 409 `STATE_VIOLATION`，并写入 `TRANSITION_REJECTED` 事件
- `resume` 恢复到 `prev_status` 记录的状态，自迁移（重复 sync）幂等放行

## 核心机制

**幂等发送**：`POST /api/sessions/:id/send` 可携带 `idempotencyKey`。同键已发送 → 直接返回 `duplicate:true` 不再触发浏览器；同键发送中 → 409 `SEND_IN_PROGRESS`；同键失败 → 复用原消息行重试。数据库层有 `(session_id, idempotency_key)` 唯一索引兜底。

**trace 可观测性**：每个动作（open/sync/suggest/send）贯通一个 `trace_id`，spans 记录各阶段耗时与异常，事件表同步携带 trace_id。查询：`GET /api/sessions/:id/traces`。trace 状态：`ok` / `degraded`（完成但降级，如风控接管、AI 降级）/ `error`。

**AI 工具契约**（`lib/ai.mjs`）：
- 输入校验：字段类型与长度上限，违规抛 `AI_INPUT_INVALID`
- 输出校验：`reply` 非空字符串、`risk` ∈ low|medium|high，违规抛 `AI_OUTPUT_INVALID`
- 超时：AbortController，默认 15s（`AI_TIMEOUT_MS` 可调）
- 失败处理：AI 超时/HTTP/输出非法时降级为本地模板，落 `AI_DEGRADED` 事件，流程不中断
- 上下文预算：仅注入最近 12 条消息

**风控与人工接管**：服务端与页面脚本双层检测验证码/登录墙/风控文案（`detectNeedHuman`），触发后会话收敛为 `need_human`，工作台人工确认后续操作；暂停状态下 open/sync/suggest/send 全部拒绝（409）。

**发送闭环校验**（适配层）：填入文本后回读编辑器内容，发送后以"编辑器是否清空 + 页面文本 diff"双重确认，避免静默失败。

## 启动

1. 启动 Chromium 并开启 CDP：

```powershell
chrome.exe --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=D:\tmp\xhs-cdp https://www.xiaohongshu.com
```

2. 启动服务并打开 `http://127.0.0.1:5188`：

```powershell
cd xhs_outreach
npm run dev
```

## 评测

```powershell
node scripts/eval.mjs
```

离线评测不依赖浏览器与真实账号（临时 SQLite + mock 适配器 + mock AI 服务），覆盖 8 个套件 29 条用例：状态机迁移、主流程、幂等发送、暂停守卫、AI 契约（超时/HTTP/输出非法/输入非法）、降级链路、风控检测、trace 落库。报告写入 `../logs/xhs-outreach/eval-report-latest.json`，有失败时退出码为 1。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 5188 | 本地服务端口 |
| `CDP_PORT` | 9222 | 浏览器 CDP 端口 |
| `AI_API_URL` | 空 | AI 生成接口地址；未配置时使用本地模板 |
| `AI_API_KEY` | 空 | AI 接口密钥 |
| `AI_TIMEOUT_MS` | 15000 | AI 接口超时 |
| `OUTREACH_DB` | `../logs/xhs-outreach/outreach.db` | SQLite 路径（评测脚本用临时库） |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话（body: `profileUrl`） |
| GET | `/api/sessions/:id` | 会话详情（含消息与事件） |
| DELETE | `/api/sessions/:id` | 删除会话（traces 保留作审计） |
| POST | `/api/sessions/:id/open` | 打开并读取主页 |
| POST | `/api/sessions/:id/sync` | 同步聊天（需先 open） |
| POST | `/api/sessions/:id/suggest` | 生成 AI 建议 |
| POST | `/api/sessions/:id/send` | 发送私信（body: `content`, 可选 `idempotencyKey`） |
| POST | `/api/sessions/:id/pause` / `resume` / `handoff` | 暂停 / 恢复 / 人工接管 |
| GET | `/api/sessions/:id/traces` | 该会话的 trace 记录（含 spans） |
| GET/POST | `/api/styles`、`POST /api/styles/:id/use` | 风格管理与切换 |
| GET | `/api/health`、`/api/state-machine` | 健康检查、状态机定义 |

错误响应统一结构：`{ "error": "信息", "code": "错误码", "trace_id": "关联轨迹" }`。错误码：`VALIDATION`(400)、`NOT_FOUND`(404)、`STATE_VIOLATION`/`SESSION_PAUSED`/`SEND_IN_PROGRESS`(409)、`ADAPTER_ERROR`/`CDP_*`/`AI_*`(502)。

## 失败边界与已知限制

- **LinkedIn 会话读取未实现**（`readConversation` 为占位），仅完成适配层与发送；发送前必须人工确认页面与文案
- 小红书 DOM 频繁变动，选择器采用多候选兜底策略，仍可能失效；失效时收敛为 `need_human` 而非报错崩溃
- `node:sqlite` 在 Node 22 为实验特性（启动时有 ExperimentalWarning，不影响功能）
- 发送成功的判定基于 DOM 变化推断，极端情况下可能误判，重要消息建议人工核对
- 会话内消息按"角色+内容"去重，同内容重复消息会被合并
- 本服务只监听 127.0.0.1，不暴露公网；请勿在未授权场景对他人账号做自动化操作
