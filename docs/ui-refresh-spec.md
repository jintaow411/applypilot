> **DEPRECATED（已归档，工作已完成）**：这是一次性 UI 重构的施工单，根因修复与 Agent A–D 分工均已落地。令牌现状以 `apps/extension/styles/tokens.css` 为准。保留仅供追溯。

# UI 可读性重构 Spec（侧边栏 · 亮/暗双主题）

## 0. 结论 / 根因
- 根因已修：`styles/tokens.css` 第 9 行注释里出现了 `*/`，把注释提前截断，导致整块 `@theme` 变成非法 CSS 被丢弃。
- 结果：`bg-panel / bg-card / text-ink / text-dim / border-line` 等全部没有生成，界面等于裸奔 + 全透明弹窗。现已修复，构建后必须能在产出的 CSS 里 grep 到 `.bg-panel`。
- 禁止在注释里写 `*/`（例如 `bg-*/text-*`）。改完 tokens 必须跑构建验证。

## 1. 目标
1. 亮色 / 暗色都达到：正文对比度 ≥ 7:1，次级 ≥ 6:1，三级/占位 ≥ 4.5:1；边框、输入框、卡片在两种主题下都能一眼分辨层级。
2. 去掉所有“硬编码暗色专用”的颜色（`bg-white/[0.02]`、`border-white/10`、`bg-black/60`、`text-[10px]`），全部改用语义令牌。
3. 组件布局恢复正常：卡片不再有多余上下留白，弹窗不透明、居中、可滚动、Esc 关闭，设置页分区清晰。
4. 默认暗色保持深色观感，但不再是“一片糊”；亮色不能出现浅灰字配白底。

## 2. 令牌契约（唯一真源：styles/tokens.css）
保留现有全部令牌名与 `bg-bg / border-line / text-ink / text-sub / text-dim` 等兼容别名。新增：
`--color-brand-hover`, `--color-brand-foreground`, `--color-primary-hover`, `--color-overlay`。
`--color-accent` 统一等于品牌色（`var(--color-brand)`），不要再当浅底色用；浅底请用 `surface / selected`。

### 2.1 亮色（`:root`）
背景 #f8f8f8 · panel #ffffff · card #ffffff · background-alt #eef1f5
surface rgba(15,23,42,.04) · surface-hover rgba(15,23,42,.07)
border rgba(15,23,42,.14) · border-hover rgba(15,23,42,.26)
input #ffffff · input-border rgba(15,23,42,.22) · input-border-hover rgba(15,23,42,.34)
foreground #0f172a · subtle #475569 · subtlest #5b6b80
brand #0369a1 · brand-hover #075985 · brand-fg #ffffff
primary #0f172a · primary-hover #1e293b · primary-fg #f8fafc
success #166534 · warning #92400e · destructive #b91c1c（前景均 #ffffff）
popover #ffffff · popover-header #f8fafc · menu #ffffff · menu-hover #f1f5f9
tag #e2e8f0 · overlay rgba(15,23,42,.45) · ring #0284c7
tooltip #0f172a / 前景 #f8fafc

### 2.2 暗色（`.dark`）
背景 #0f1115 · panel #15181e · card #1a1e25 · background-alt #161a20
surface rgba(255,255,255,.05) · surface-hover rgba(255,255,255,.09)
border rgba(255,255,255,.12) · border-hover rgba(255,255,255,.24)
input #1d222a · input-border rgba(255,255,255,.16) · input-border-hover rgba(255,255,255,.28)
foreground #e6eaf0 · subtle #a8b3c2 · subtlest #8592a3
brand #4cc2ff · brand-hover #7ad3ff · brand-fg #052a3d
primary #e6eaf0 · primary-hover #ffffff · primary-fg #10141a
success #4ade80 / fg #052e16 · warning #fbbf24 / fg #241500 · destructive #f87171 / fg #2b0a0a
popover #1a1e25 · popover-header #20252d · menu #1a1e25 · menu-hover #262c35
tag #2a313b · overlay rgba(0,0,0,.62) · ring #4cc2ff
tooltip #f8fafc / 前景 #0f1115

### 2.3 主题取舍
只留正在用的两套：亮色（`:root`）/ 暗色（`.dark`），闲置的 `.theme-zai-*` 已删除。
亮色字色加深：fg #000000 · subtle #1e293b · subtlest #3f4c5e；暗色字色提亮：fg #ffffff · subtle #c2cbd7 · subtlest #9aa6b8。
两套主题的 text 令牌必须写成不透明 6 位 hex，方便脚本校验。

### 2.4 字号
`--ui-font-size` 保持 14px；调整派生档让最小字号不小于 10px：
xl 18 / lg 16 / base 14 / caption 13 / sm 12 / xs 11 / 2xs 10。
组件里正文用 base/caption，辅助说明用 sm，微标签最低 xs；删除 `text-[9px]/[10px]/[11px]/[12.5px]` 这类硬编码，改用 `text-ui-*`。

## 3. 组件与布局要求
### 3.1 基础件（components/ui + ThemeToggle）
- Button：default h-8、sm h-7、xs h-6、lg h-9；全部加 `focus-visible:ring-2 ring-ring/60 ring-offset-1 ring-offset-background`；default 用 `bg-primary hover:bg-primary-hover`，outline 用 `bg-input hover:bg-surface-hover`，ghost 用 `text-foreground-subtle hover:bg-surface-hover hover:text-foreground`；disabled 保持可读（opacity 约 60%，不要 50% 以下）。
- Input / Select：默认 h-8，边框用 input-border，hover 加深，focus 用 brand 描边 + ring，placeholder 用 subtlest；select 的 option 底色用 menu。
- Badge：11px、h-5、圆角全、带描边；`tone` API 不变，但 success/warning/danger/violet/accent 都输出「10% 同色底 + 25% 同色边 + 同色文字」，neutral 用 surface + subtle，不要再全部灰色。
- Card：只保留 `rounded-xl border border-card-border bg-card text-foreground`，去掉默认 `py-4 gap-4`（否则卡片头被撑高）；需要内边距由调用方加。
- ThemeToggle：保持无 props；图标 14px，按钮 28px，aria 不变。

### 3.2 主界面（App.tsx / FieldList.tsx / FooterBar.tsx）
- Header 56px：品牌图标 20px **纯黑无底色**（`text-foreground`，不再用 `bg-brand/12 text-brand` 方块）；标题 14px 600；域名 12px subtle 截断；右侧 `x/y` 和覆盖率做成 12px 的紧凑信息，操作按钮 28px。
- 覆盖率条 3px：轨道 `bg-surface`，进度 `bg-brand` 到 `bg-idle-task` 渐变。
- 常驻提示条（规则说明 / 模式回落）：`rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption text-foreground-subtle`；warning 用 `border-warning/30 bg-warning/10`，但长文本仍用 foreground，只有图标/短词用 warning 色。**成功 / 失败 / 一次性反馈一律走 Toast，不再塞进常驻提示条。**
- SectionCard：头部 40px 高，标题 13px 600，右侧「n 项」11px subtle；badge 与文字不挤；行内 label 13px medium、值 12px、reason 11px subtlest；分隔线 `border-border/70`；hover 用 `bg-surface-hover`。
- 空态/错误态：标题 14px medium、说明 12px subtle、按钮 h-8；错误底色 `bg-destructive/8 border-destructive/25`，长文用 foreground，图标用 destructive。
- FooterBar：`border-t bg-background/95 backdrop-blur`，上内边距 10px、下内边距含 safe-area；主按钮 h-8 flex-1，次按钮 h-8；只保留 12px 的静态安全说明「永不自动提交…」，不再渲染内联提示行（反馈走 Toast）。主按钮禁用时也要能读清。

### 3.3 设置页 + 弹窗（SettingsPanel/Modal/SettingField/ServerSection/CandidateSection/ProfilesSection/ProfileModals）
- SettingsPanel：整页而非浮层；header 56px sticky（标题 15px 600，副标题 12px subtle，关闭 28px）；内容 `px-4 py-4 space-y-4`；每个分区做成 `rounded-xl border border-border bg-card p-4`，去掉裸分割线；保存反馈统一用全局 Toast，不再自带小胶囊。
- 分区标题：图标 16px **纯黑无底色**（`text-foreground`），不使用 `bg-brand/10 text-brand` 方块；标题 12px 600 tracking-wide，右侧操作按钮 h-7。
- ServerSection / ProfilesSection / CandidateSection：label 12px medium；hint 11px subtle；配置行 40px，高亮行 `border-brand/50 bg-brand/8`，圆点品牌色；空态 dashed 边框；拖拽区 min-h 96px，hover 品牌色边框 + 浅底，错误用 destructive。
- Modal：用 `createPortal(..., document.body)`；backdrop `bg-overlay backdrop-blur-[2px]` z-50；面板不透明 `bg-popover` + `border-popover-border` + `shadow-2xl`，宽 `calc(100%-2rem)` max-w-[420px]，max-h 85vh，内部滚动；header/body/footer 分别 px-4 py-3，footer 顶部边框 + sticky；标题 15px 600；Esc、点 backdrop、关闭按钮都能关；`role="dialog" aria-modal="true"`。
- 表单 label 与输入框间距 6px；校验 / 保存错误统一走 Toast（带「重试」或直接关闭），不再在表单底部插小号红字；按钮区两个 h-8 等宽。

### 3.4 Toast（全局提示，`components/ui/toast.tsx`）
- 所有成功 / 失败 / 信息反馈统一调用 `toast.success()` / `toast.error()` / `toast.info()`；`Toaster` 在 App 根部渲染一次（portal 到 body，z-index 80）。
- 卡片：宽 `calc(100%-24px)` max-w 440、`rounded-2xl`、1px 边框、`shadow-xl`、`px-3.5 py-3`；左侧 18px 状态图标，标题 14px/500 可换行（不许截断），说明 12px subtle。
- 颜色：success 用白底 + 绿色对勾；error 用 `bg-destructive/8 border-destructive/35` + 红色图标 + 红色标题（说明文字仍用 subtle）；info 用白底 + 黑色图标。图标不再使用品牌蓝。
- 行为：success 3.5s、info 4.5s 自动消失；error 默认常驻并提供关闭；有 `action` 时在右侧显示按钮（如「重试」）+ 关闭按钮；同文案重复触发时替换旧条，最多同时 3 条。
- 位置：主界面底部留出 FooterBar 高度（offset 92px + safe-area），设置页 16px；错误 / 成功都不得再以 11–12px 内联小字出现。

## 4. 文件归属（严格，不许越界）
- Agent A：`styles/tokens.css`、`app.css`、`styles/README.md`、新增 `scripts/check-theme-contrast.mjs`
- Agent B：`entrypoints/sidepanel/App.tsx`、`entrypoints/sidepanel/components/FieldList.tsx`、`entrypoints/sidepanel/components/FooterBar.tsx`
- Agent C：`entrypoints/sidepanel/components/SettingsPanel.tsx`、`Modal.tsx`、`SettingField.tsx`、`features/server/ServerSection.tsx`、`features/candidate/CandidateSection.tsx`、`features/ai-profiles/ProfilesSection.tsx`、`features/ai-profiles/ProfileModals.tsx`
- Agent D：`components/ui/button.tsx`、`input.tsx`、`select.tsx`、`badge.tsx`、`card.tsx`、`components/theme/ThemeToggle.tsx`

## 5. 约束与自检
- 不新增依赖、不改业务逻辑/hooks/lib、不改 `entrypoints/content.ts`。
- 不使用浏览器截图；用构建结果与 grep 自检。
- 构建：`cd apps/extension && ./node_modules/.bin/wxt build`（不要用 `pnpm build`，会触发 lockfile 策略检查失败）。
- 构建后：`CSS=$(ls .output/chrome-mv3/assets/*.css | head -1); grep -c '\.bg-panel' "$CSS"` 必须 ≥1。
- 自检禁用样式：`grep -rn 'bg-white/\[\|border-white/\|bg-black/\|text-\[1[0-2]px\]' entrypoints components`，除 radix 遮罩外应为 0。
- 四套主题的正文/次级/三级对比度：≥7 / ≥6 / ≥4.5（用脚本或手算记录）。