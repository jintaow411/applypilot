# AGENTS.md · 给后续 agent 的仓库公约

> 文档里写的必须能在代码里找到依据，找不到就改文档，不许编。

## 目录一句话

- apps/extension/：浏览器扩展（MV3 + WXT）。entrypoints/background.ts（SW：查适配/供 token/统一调 AI）、entrypoints/content.ts（页面内：抽取/回填/路由监听）、entrypoints/sidepanel/（UI：App.tsx + components/ + features/{ai-profiles,candidate,schema,server}/）、lib/（extract/fill/runner/ai/match/candidate/recruiting/expand-rules/api/schema）、styles/tokens.css（语义令牌唯一真源）。
- server/：本地 Go 服务（Gin + SQLite，main.go/api.go/store.go，三表 sites/reports/fills），只做站点适配、上报、回填审计，监听 127.0.0.1:17880。
- docs/：architecture.html（架构图，现状有效）、problematic-forms.md（问题模式库，持续维护）、plan-extension-server.md / ui-refresh-spec.md（已归档，只追溯不跟进）。
- test.html / test-*.html：页面存档，新站点先存档再加规则（回归凭据，勿删）。
- src/data/shared 已删：shared/*.schema.json 契约不复存在，别再引用。

## 常用命令

扩展类型检查：cd apps/extension && npx tsc --noEmit
扩展构建：cd apps/extension && npx wxt build（不要用 pnpm build，会触发 lockfile 策略检查失败）
服务端：cd server && go build ./... && go test ./...
pnpm 被供应链策略拦时一律用 npx。

## 消息契约

content（tab 与侧边栏之间，双向）：GET_SCHEMA（抽取字段结构，先过招聘页门禁）、FILL（按 Step[] 真实写入 DOM）、CLEAR（按 id 列表清空页面控件值）、FOCUS_FIELD（定位滚动到指定字段）、PING（存活/桥版本探测）。

background（侧边栏经 chrome.runtime.sendMessage 调 SW，依据 entrypoints/background.ts）：AI_CALL（发全量 schema，返回 AI 决策；信息库由 SW 从 storage 供给，调用方传 profileSubset: null）、AI_PARSE（简历文本整理成信息库纯文本）、AI_MERGE（手动补值新增行合并进信息库文本）。

Banned：别加新消息类型，先商量。（顺带：SW 还有 GET_SCHEMA/GET_TOKEN/SET_TOKEN/GET_SETTINGS 内部调用，已存在，动之前先读代码。）

## 存储形状

- 候选人信息库：chrome.storage.local 的 autoInfo.candidateProfile 存 { text }（包一层对象，不裸存字符串）；更新时间另存 autoInfo.candidateProfileMeta（{ updatedAt }）。旧 JSON（含 fields 数组）读到时转文本存回。
- AI Profile：chrome.storage.local 的 autoInfo.aiProfiles（多 Profile，Key 只在这里，不在环境变量）。
- 服务端 token：SW 经 chrome.storage.local 的 autoInfo.token 供给侧边栏；服务端落盘 server/.token。

## 铁律

1. 页面注入函数必须自包含：进 page.evaluate 的函数（如 lib/fill.ts 的 page*）只用参数 + document，不闭包、不引 chrome、不调外部函数——会被序列化进页面，引用外部直接炸。
2. hook 依赖数组立即求值：useCallback/useMemo 引用的变量必须在声明之后，已踩过坑（声明顺序错了白屏，tsc 拦不住）。挪顺序后通读引用链。
3. 新站点先存档 html 再加 expand-rules：在仓库根另存为 test-*.html，再在 lib/expand-rules.ts 加 {id, hostSuffix, toggles, scope}；不写通用启发式（点错一次可能是跳页/提交且无法撤销）。
4. 改完跑对应构建：扩展 npx tsc --noEmit + npx wxt build；服务端 go build ./... + go test ./...。
5. docs/problematic-forms.md 有新坑就地追加：只记模式不记单个 URL，按文末模板（现象→根因→处理→状态→还缺）写；修完改状态。
6. 新站先用现成抽取再补漏：先跑扩展 GET_SCHEMA / extractSchema（上报里已有 schema_json 就直接用它），拿它跟 html 里的 input/select/textarea 对数找漏网，再写按域名的 adapter；不许跳过抽取直接手编全量 schema——插件本来就能跑出来，手编只会重复造轮子。补漏时发现易漏模式（弹窗控件/技术 hidden/级联空选项/特殊模板等）就地记入 docs/problematic-forms.md，只记模式不记 URL，这条长期有效、持续更新。
