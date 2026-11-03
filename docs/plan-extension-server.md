> **DEPRECATED（已归档，不再跟随实现更新）**：这是立项时的方案文档。分批（25 一批）、`shared/*.schema.json`、环境变量读 Key 等写法均已过期——以 [README.md](../README.md)（扩展+服务端现状）、[server/README.md](../server/README.md)（接口与三表现状）和代码本身为准。保留仅供追溯决策过程。

# 插件 + 本地服务端：具体方案

## 0. 结论

可行。**Go 合适**：单二进制、本地服务零运行时依赖、Gin 路由中间件成熟、SQLite 单文件免运维。
两个注意点：sqlite 驱动用 `modernc.org/sqlite`（纯 Go，不用装 CGO 工具链）；Gin 的默认日志中间件关掉，本地服务别刷屏。

字段匹配不再放在本地做：插件把「精简 schema + 信息库」一次性发给 AI，AI 按 `shared/fill-plan.schema.json` 直接返回每个字段的填写决策；本地只保留抽取、机械回填和人工复核。

## 1. 总架构

```
招聘页
 ├─ content script：抽取结构 / 执行回填（extract + fill，不做本地字段匹配）
 ├─ sidepanel：字段→AI 建议值→置信→是否需复核，一键填，低置信置顶待确认，永不自动提交
 ├─ background SW：按域名查适配 → 本地 Go 服务 (:17880, SQLite)
 │     有 adapter → 站点模式；无 → 内置通用抽取（现在这套逻辑就是默认结构）
 ├─ AI（用户自带 key，存扩展本地）：只吃精简 schema + 信息库，一次输出 fill-plan JSON
 └─ 上报按钮：陌生页 → 服务端存 blob → 本地 agent 轮询开发适配 → 写回 adapter
```

信息库只放扩展本地，**不上服务端**；服务端只存页面结构。

## 2. 目录

```
auto-info/
  apps/extension/          # wxt + react + tailwind v4 + shadcn
    entrypoints/{background.ts, content.ts, sidepanel/}
    lib/{extract.ts, fill.ts, api.ts, ai.ts, plan.ts}   # 抽取 / 回填 / 契约 / AI 决策
  server/                  # go + gin + sqlite
    main.go api/ store/
  shared/fill-plan.schema.json   # 前后端同一份 JSON 契约
  out/                   # 产物目录：report.json / report.md / ai-request.json / screenshots/
```

## 3. 四份契约（shared，冻结后前后端都按它走）

- **SchemaJSON**：就是现在 `extractSchema()` 的输出
  `{url, title, fields:[{id, kind, type, name, label, section, placeholder, required, options, value}]}`。
- **AdapterJSON**：`{domain, version, aliases:{profileKey:[...]}, sections:{...}, widgets:{...}}`。
  `aliases` 只用于服务端站点适配，不参与字段决策。
- **AIRequestJSON**：一次请求发一批（最多 25 个）字段：
  `{fields:[{fieldId,label,section,kind,required,options:[text...]}],
    profile:{name,fields:{label:value},facts,answers:{label:template}},
    alreadyAnswered:[fieldId...]}`。
  不传整页 HTML，也不传无关 DOM；`alreadyAnswered` 是前面批次已写入 `decisions` 的 fieldId，首批为空。
- **FillPlanJSON**（AI 唯一允许输出）：`{decisions:[{fieldId, action, value, confidence, reason}], requiresReview:[...]}`，
  `action` 只能是 `set | click | check | skip`；选择题 `value` 必须是 `options` 原文；
  用 `response_format=json_object`（或对应协议的 JSON 模式）+ shared schema 校验，
  `confidence<0.6`、选项对不上、缺事实的字段强制进 `requiresReview`，映射为 `needs-ai`，不执行回填。

三种 AI 协议由 `AI_PROTOCOL` 选择（默认 `chat-completions`）：
`chat-completions` 走 `{base}/chat/completions` + `response_format`；
`response` 走 `{base}/responses` + `text.format`；
`anthropic` 走 `{base}/v1/messages` + `x-api-key` / system 单拎。
三者默认关闭思考，输出都做同一套 FillPlanJSON 校验。

## 4. 服务端 API（Gin，`127.0.0.1:17880`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 存活 |
| GET | `/api/schema?domain=` | 插件拉本站适配；无则 `found:false` 走通用抽取 |
| PUT | `/api/sites/:domain/schema` | agent/人工写回 adapter（需 token） |
| POST | `/api/reports` | 上报陌生页 `{domain,url,title,html,css,jsMeta,schema}` → `{reportId}` |
| GET | `/api/reports?status=new` | agent 轮询待处理 |
| GET | `/api/reports/:id` | 拉 blob（含 html 全文） |
| PATCH | `/api/reports/:id` | agent 标注状态（done/wip） |
| POST | `/api/fills` | 回填审计日志，供覆盖率看板 |

token：服务端首次启动生成随机串，存 server 目录 `.token` 并打印控制台，插件 sidepanel 配对页粘贴一次。
CORS 只放行 `chrome-extension://` 和空 Origin。

## 5. 上报收什么（回答“html 还是全量”）

默认：**HTML 全量**（`documentElement.outerHTML`，先 scrub：清空 input/textarea 已填值、去掉 password/file，
保证不把个人隐私带上服务端）＋ **CSS 全量**（内联 `<style>` 与同源外链文本，影响可见性判断，agent 复现需要）
＋ **JS 只收清单**（src 列表＋内联脚本 hash/长度，不收全文；全文动辄 MB 且 agent 主要需要 DOM 结构）。
要全量 JS 留一个开关。

## 6. DB（SQLite，3 张表，TEXT 存 JSON 即可）

```sql
sites(domain TEXT PRIMARY KEY, adapter_json TEXT, version INT, updated_at TEXT);
reports(id INTEGER PRIMARY KEY, domain TEXT, url TEXT, title TEXT,
        html TEXT, css TEXT, js_meta TEXT, schema_json TEXT,
        status TEXT DEFAULT 'new', created_at TEXT);
fills(id INTEGER PRIMARY KEY, domain TEXT, url TEXT, summary_json TEXT, created_at TEXT);
```

## 7. Agent 闭环

`GET /api/reports?status=new` → 拉 blob → 本地用现有 playwright 链路复现+开发 adapter
→ `PUT` 写回 → `PATCH` 关单。陌生页→适配器→回归集，全在本地转。

## 8. 里程碑

- M0 契约冻结：`shared/*.schema.json`＋示例（0.5 天）
- M1 服务端：Gin＋3 表＋接口＋token（1–2 天）
- M2 移植 extract/fill 到 TS + AI 决策映射，用 `scripts/test-ai-plan.mjs` + 扩展侧类型检查做回归（2–3 天）
- M3 sidepanel（shadcn）＋一键填＋上报按钮（2 天）
- M4 AI 接入（三协议）＋ needs-ai 复核流程＋agent 轮询脚本（2 天）
- M5 真站联调（电信页＋1 个 SPA 站）＋覆盖率看板

## 9. 风险清单

CSP（content script 跑 isolated world，一般不受影响）、iframe 表单、站点反爬/ToS（限频、验证码处停手）、
附件与验证码必须人工、AI 编造（confidence 门＋requiresReview 强制人工兜底）、
AI key 泄露（只从环境变量读取，不写日志/不落请求文件）、协议差异（三种响应解析分别校验）。
