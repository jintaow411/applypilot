<p align="center"><img src="apps/extension/public/icon/logo.svg" width="76" alt="ApplyPilot logo" /></p>

# ApplyPilot · AI 求职表单助手（浏览器扩展 + 本地服务端）

> 开源项目名：**ApplyPilot**。源码不内置候选人简历、API Key 或服务端 token。

结论先说：**不再在本地做字段匹配，改成纯 AI 模式**——扩展把精简 schema + 信息库一次性发给 AI，由 AI 直接给出每个字段的填写值，扩展只负责回填；服务端只存页面结构做站点适配和上报，信息库不出本机。

链路：

```
招聘页(已渲染) → 门禁(isRecruitingPage) → 扩展抽字段结构 → 组装 schema + 信息库 → AI one-shot 决策 → 按控件机械回填 → 回读核对
                                                              │
                                                     全量一次发完，不分批
````

AI 调用发**全量字段**（`lib/ai.ts buildUserPayload` 对全字段组装，`features/server/hooks.ts runAI` 发 `schema: full`），不分 25 一批；已填字段只用来算 `filledSiblings`，AI 不再给它们出决策。

## 架构图

7 张图讲清页面 / 本机 / 外网三方边界和两条链路：[docs/architecture.html](docs/architecture.html)。

> GitHub 上点这个链接只会看到源码（README 不能嵌 HTML 页面），克隆后浏览器直接打开该文件即可正常看图。

## 扩展安装 / 使用

```bash
cd apps/extension
npx wxt           # 开发模式（WXT 0.19 没有 dev 子命令，直接 npx wxt）
npx wxt build     # 正式版构建
npx tsc --noEmit  # 类型检查
```

日常使用：在招聘页点开扩展侧边栏，手动点“一键生成”跑 AI（默认不自动跑，不自动花钱）；列表按页面现值分“已填 / 未填”两组展示（填完不消失，总数稳定），勾选后一键填，**不自动提交**。content script 监听 DOM 变化（SPA 路由切换会重渲染表单，签名只认字段增删不认现值，填入不会触发重抽）。

已知限制：非招聘页直接门禁（仅招聘站点工作）；iframe 内嵌表单、验证码、附件上传（简历 PDF 留给人点）、站点风控；不要自动化提交——账号风险不值当。

## AI 配置（Key 只存在扩展本地多 Profile，不写进仓库、不打印）

设置页 → AI 配置，多 Profile（`chrome.storage.local` 的 `autoInfo.aiProfiles`），每个 Profile 含 baseUrl / protocol / model / apiKey。三个协议（`chat-completions` / `responses` / `anthropic`，默认 `chat-completions`，默认地址 `https://opencode.ai/zen/go/v1`，默认模型 `deepseek-flash`）的思考默认都关闭。选择题的 `value` 必须是 `options` 原文；对不上、`confidence < 0.6`、或没有事实依据的字段一律进人工复核，不执行回填。

## 信息库（纯文本，只存扩展本地）

开源使用者请在扩展侧边栏的“候选人信息库”中上传自己的 `.txt`、`.md` 或 `.docx` 资料；不要把真实简历直接放进仓库。AI 配置、候选人资料和服务端 token 的配置方式见 [docs/open-source-setup.md](docs/open-source-setup.md)。

上传的简历经 AI 整理成纯文本，存 `chrome.storage.local` 的 `autoInfo.candidateProfile`（形状 `{ text }`，更新时间另存 `autoInfo.candidateProfileMeta`）；background 的 `handleAICall` 只认这份用户上传文本，没有就不调 AI，绝不用示例数据冒充。旧版 JSON（含 `fields` 数组）读到时自动转文本存回。

一键导入信息库四步链路（`App.tsx handleImportManual`）：手动补值组 Step → FILL 成功 → 清草稿 → 静默重抽（只刷新已填/未填）→ 合并进信息库；合并失败只 toast，已填入的页面值不受影响；无 Key 时降级为只填页。

## 服务端上报

本地 Go 服务（Gin + SQLite），给扩展提供站点适配、未知页面上报和回填审计，监听 `127.0.0.1:17880`：

```bash
cd server
go build ./... && AUTO_INFO_EXTENSION_ORIGIN=chrome-extension://<extension-id> ./auto-info-server
go test ./...
```

首次启动生成配对 token（打印到 stdout，同时写 `server/.token`），填到扩展侧边栏配对页一次即可。启动前还要从 `chrome://extensions` 复制本扩展的 ID，作为 `AUTO_INFO_EXTENSION_ORIGIN=chrome-extension://<extension-id>` 传入；服务端只接受该精确 Origin。详见 [server/README.md](server/README.md)。除 `GET /healthz` 外的所有 `/api` 路由都需要 token。三表：`sites` / `reports` / `fills`。同 URL 重复上报只更新 blob（title/html/css/js_meta/schema_json），`status` 与 `created_at` 不回退。

上报轮询（供 agent 认领 `status=new` 的报告）：

```bash
node scripts/agent-poll.mjs --once
node scripts/agent-poll.mjs --base http://127.0.0.1:17880 --token <token>
```

## 目录

```
apps/extension      浏览器扩展（MV3：抽取 / AI 决策 / 回填 / 侧边栏）
  entrypoints/background.ts   SW：查适配 / 供 token / AI_CALL·AI_PARSE·AI_MERGE（三者走 SW 统一调模型）
  entrypoints/content.ts      注入页：抽取 / FILL·CLEAR·FOCUS_FIELD·GET_SCHEMA·PING / 路由监听
  entrypoints/sidepanel/      侧边栏 UI（App + components + features/{ai-profiles,candidate,schema,server}）
  lib/                        extract·fill·runner·ai·match·candidate·recruiting·expand-rules·api·schema
  styles/tokens.css           语义令牌唯一真源
server/              本地 Go 服务（main.go / api.go / store.go，三表 SQLite，上报 / 适配 / 审计）
scripts/agent-poll.mjs  上报轮询脚本，供 agent 认领
test.html / test-*.html  页面存档：新站点先存档 html 再加 expand-rules（回归凭据，勿删）
docs/                architecture.html（架构图）/ plan-extension-server.md（立项方案，已归档）/
                     ui-refresh-spec.md（UI 重构记录，已归档）/ problematic-forms.md（问题模式库，持续维护）
out/                 本地产物目录（已忽略，不进仓库）
````
