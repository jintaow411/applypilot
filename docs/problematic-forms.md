# 招聘表单问题模式库

> 持续维护：每踩到一个新坑，就按文末模板追加一节。目标是把“这类页面会让插件出什么问题”沉淀下来，而不是散在聊天记录里。

维护约定：

- 只记**模式**（一类页面/一类控件），不记单个 URL；复现特征写“长什么样”，方便以后对号入座。
- 每节五段：现象 → 根因 → 当前处理（精确到文件/函数）→ 状态 → 还缺什么。
- 状态只有三种：已处理 / 观察中 / 待处理。修完就改状态，不要留“好像修了”。

---

## A. 抽取识别类（字段找不准、分不清）

### A1. 标签不关联

- 现象：老页面 `<div class="lbl">毕业院校</div><input>`，`label[for]` 拿不到名，字段变“未命名字段”。
- 根因： label 和控件是兄弟关系，没有语义关联。
- 当前处理：`apps/extension/lib/extract.ts` 的 `labelOf` 回退链（label[for] → 包裹 label → aria → 左侧标签格 → 同行表头 → 前兄弟 → 容器文本）。
- 状态：已处理。
- 还缺：遇到回退链全空的新版式再补一环。

### A2. 裸 label 无上下文（如“活动描述”）

- 现象：侧边栏和发 AI 的都是一个光秃秃的词，AI 不知道它属于哪一块。
- 根因：控件所在容器没有可识别的区块标题，`section` 为空，`wrapperText` 也可能就是 label 本身。
- 当前处理：抽取侧空 section 用就近容器回退；payload 每字段带 `context`（周边文字 120 字）；提示词规则要求泛 label 看 context 判归属（`lib/ai.ts` 规则 7）。
- 状态：已处理。
- 还缺：回退也拿不到时，只能靠 AI 猜，猜不准进人工确认是符合预期的。

### A3. 同名不同义（如两个“开始时间”）

- 现象：实习经历和项目经验各有一个开始时间，侧边栏分不清，跳转可能落错。
- 根因：label 相同，section 不同，但列表只渲染裸 label。
- 当前处理：`features/schema/helpers.ts` 的 `buildRows` 统计重名，有 section 的显示为 `section-裸label`（如项目经验-开始时间），只出现一次的不加噪。
- 状态：已处理。
- 还缺：无。

### A4. 多段重复块（“增加更多项目经验/教育经历”）

- 现象：第 1 段已填，第 2 段空块标签一模一样；AI 可能把第 1 段内容重复填进第 2 段。注意 AI 删不掉旧值（`runPlan` 只写 pending 步骤），风险是重复填。
- 根因：有现值的字段不发给 AI，AI 看不到“第 1 段已有人了”，也不知道空块是第几段。
- 当前处理：抽取按同 `(section,label)` 的 DOM 顺序编 `occurrence`（第几段/共几段）；payload 加 `occurrenceText` + `filledSiblings`（同区块已填拼串）；提示词规则 6/7（无第 N 段经历就 skip+人工确认、不许填两遍）。AI 请求因此改发全量字段，回填仍只写 pending。
- 状态：已处理。
- 还缺：三段以上的页面还没实测命中过，遇到先看日志确认编号对不对。

### A5. 蜜罐 / 隐藏字段

- 现象：页面藏着给爬虫准备的假输入框，误填会触发反作弊。
- 根因：`tabindex=-1`、name 含 honeypot 等标记的陷阱字段。
- 当前处理：`extract.ts` 的 `isHoneypot` 直接过滤。
- 状态：已处理。
- 还缺：无。

### A6. 弹窗、下拉搜索框里的输入框

- 现象：把选项弹窗里的搜索框当成表单字段抽出来。
- 根因：它们也是 input，但不在表单语义里。
- 当前处理：抽取时过滤弹窗/搜索框上下文（与 `src/extract.js` 行为对齐）。
- 状态：已处理。
- 还缺：无。

### A7. 必填星号污染 label

- 现象：`*姓名` 里的星号进 label，导致 AI 匹配和显示都脏。
- 根因：星号是样式（.wt-strt 等），不是名字。
- 当前处理：`stripStars` 去首尾星号，`required` 单独存布尔。
- 状态：已处理。
- 还缺：无。

### A8. 登录/注册/找回密码弹窗控件混入

- 现象：html 里数出 email/phone/password/imgcode/msgcode 一堆“字段”，但页面上是登录弹窗，不是网申表。
- 根因：Angular 单页把登录/注册/找回密码三个弹窗和简历表放同一个 DOM，name 全是通用词（email/phone/imgcode），无表单语义区分。
- 当前处理：抽取侧按弹窗上下文过滤（同 A6）；password/file/captcha 类按政策本来就不碰（B6/E3 同策略），上报前 scrub 也会清值。数控件做补漏时这类先划掉，不当漏网。
- 状态：已处理。
- 还缺：弹窗样式换壳后过滤串了再补。

### A9. 技术 hidden 字段（xx_status/valid_status/f_id）

- 现象：xx_status、xx_valid_status、xx_f_id（ng-if recordId 条件下才渲染）这种 hidden input，看着像漏网。
- 根因：框架的状态位，不是给人填的；`type=hidden` 且无 label/无选项。
- 当前处理：补漏时 `input[type=hidden]` 整类忽略，不进 adapter、不进 schema。
- 状态：已处理。
- 还缺：无。

### A10. Portal 延迟下拉与内部搜索框混入

- 现象：招聘表单使用自定义下拉组件，初始抽取时性别、学历、来源等字段没有 options；多选下拉内部的搜索 input 还会被误抽成一个空字段。
- 根因：选项通过 portal 在点击下拉后才挂到 body，且搜索框与真实 combobox 共存于同一个控件内部，不能按所有 input 一视同仁。
- 当前处理：`extract.ts` 过滤 `select-search` 内部搜索框，并优先从 `[data-form-field-id]` 字段容器回退标签；`content.ts` 对 `poizon.jobs.feishu.cn` 登记式打开自定义下拉、采集可见选项后关闭；`fill.ts` / `runner.ts` 回填时先打开下拉，再从全局 portal 读取选项并点击原文选项。
- 状态：已处理（得物 App 校园招聘页面）。
- 还缺：其他使用不同 portal 结构的招聘站点仍需按真实页面样本验证，不扩展为全页面盲点规则。

## B. 回填写入类（值写不进去）

### B1. 受控组件（React/Vue 把 `el.value = x` 吞掉）

- 现象：赋值了但页面没反应，提交时还是空。
- 根因：框架劫持了 value，绕过 setter 的赋值不会触发更新。
- 当前处理：`lib/fill.ts` 的 `pageSetText` 用原型链原生 setter + 派发 input/change。
- 状态：已处理。
- 还缺：无。

### B2. 自定义控件（日期、级联城市、带头像下拉）

- 现象：直接设值无效或格式被吞，必须人一样点开再点选项。
- 根因：值只在控件自己的状态机里，不在 input value 里。
- 当前处理：`runPlan` 的 custom-select 分支（点开 → 读选项 → 点中）+ `pageClickTextOption`；bootstrap-select（`button.dropdown-toggle` + 藏起来的原生 `select`）走 `select` 分支：抽取时 button 配对 select（`data-id` 或同容器就近）、`data-ai-id` 双标、`label` 取 `msg` 优先、options 去空请选择，二级联动（后级只有占位项且同容器）合并为一个字段，`runner` 按同 `id` 双 select 走“选省→重读市→选市”，填充/回读函数优先解析到原生 `select`。
- 状态：已处理（通用链路），奇形下拉逐站适配。
- 还缺：遇到点不开的新样式下拉，按这个模式加分支。

### B3. 异步选项 / 级联（省选完市才加载）

- 现象：提取时选项是空的，填完省后市还是空。
- 根因：选项是请求回来后渲染的，提取快照里没有。
- 当前处理：填充时重读一次选项（`pageReadOptions`），每次 select 后 `settle` 等待（`lib/runner.ts`）。
- 状态：已处理。
- 还缺：无。

### B4. 单选 / 复选组

- 现象：同组多个 input 共用一个字段 id，按文本匹配容易错位。
- 根因：组内靠序号区分，不靠文本。
- 当前处理：`pageChooseOption` 按 `data-ai-opt` 序号优先、文本兜底；侧边栏显示映射回选项文本（如 0/4500/4502 显示“否”）。
- 状态：已处理。
- 还缺：无。

### B5. 富文本（contenteditable 简历/描述框）

- 现象：普通设值写不进多段富文本编辑器。
- 根因：内容是子节点不是 value，且编辑器监听 inputType。
- 当前处理：`pageSetRichText` 清空后按行插 `<p>` + 派发 InputEvent。
- 状态：已处理。
- 还缺：无。

### B6. 附件（简历 PDF）

- 现象：AI 给不出文件，程序也变不出文件。
- 根因：by design 就不自动传文件。
- 当前处理：file 控件直接进未填，reason 写“附件需人工选择”，不进回填步骤。
- 状态：已处理（策略如此，不是 bug）。
- 还缺：无。

### B7. 特殊模板控件（dy-form-special，如学校/专业）

- 现象：最高学历专业这种字段，原生 select 藏着（displayNone），真入口是 `dy-form-special` 定制模板，普通 select 分支填不动。
- 根因：值只活在定制组件状态机里（customDataSource=subject），不在原生控件 value 里。
- 当前处理：先当特殊控件识别、不硬填；碰到按 B2 模式逐站加分支（点开→读选项→点中）。report-7 里先记为待确认，不阻塞通用链路。
- 状态：观察中。
- 还缺：真机点一遍该模板，确认选项读取与写入路径。

## C. AI 决策类（填错、编造、乱填）

### C1. 开放题 / 主观题硬填

- 现象：自我评价这类题 AI 自由发挥，写出一眼假的内容。
- 根因：信息库没有对应素材，模型倾向于编。
- 当前处理：提示词规则 3（没有可用信息就 skip/进 requiresReview）+ 置信度 < 0.6 强制人工确认。
- 状态：已处理。
- 还缺：无。

### C2. 选择题编造选项

- 现象：value 写了个选项里没有的值，点选失败。
- 根因：模型按语义造词，不按原文。
- 当前处理：提示词规则 2（value 必须是 options 原文）+ 本地校验对不上就转 requiresReview。
- 状态：已处理。
- 还缺：无。

## D. 扩展工程类（定位、高亮、版本）

### D1. SPA 路由切换 / 条件显隐导致误重抽

- 现象：填完/切个 tab 就触发重抽，甚至把 AI 决策清空了。
- 根因：现值变化、条件显隐都会改 DOM，和“换了一张表”难以区分。
- 当前处理：路由签名只认字段增删/可用性（现值不参与）；填入/清空后等 700ms 再静默重抽；撞上过渡态（数量暴跌）900ms 后确认一次；现值变化不算结构实变、不清空 plan。
- 追加（102→64 事件，真凶已用 headless 复现台实锤）：抽取打标不清旧账——`data-ai-id` 留在 DOM 里，第二次抽取时 bootstrap 第二遍因 select 已带标记而整批跳过（104→64，40 个 select 正好等于被标记数，且 preExpand 明明 0 点击），重抽后永不恢复；政治面貌/籍贯两边列表消失是同一病因。62.7% 越过旧 0.6 阈值只是帮凶（让坏采样一次过），二次确认也救不了（确认采样同样是 64）。修法：① `extractSchema` 开头先清掉上次的 `data-ai-id`/`data-ai-opt` 旧标记，抽取幂等（复现台验证 T0=T1=T2=104，40 select 稳定）；② 保留静默重抽形状变化 900ms 二次确认（防 Angular 两拍过渡态）；③ scopeFolded 收紧为确定折叠才点（aria-expanded 直判 + 藏起控件须共享块内折叠容器）；plan 清空只在接受样本后比 shape。
- 状态：已处理。
- 还缺：无。

### D2. 旧版 content 脚本（扩展改了但页面跑的还是旧的）

- 现象：点击定位 toast“页面脚本还是旧版”，刷新也没用，用户懵。
- 根因：扩展代码更新后，已打开页面的 content 还是旧注入；以前所有空回包都报同一句话。
- 当前处理：`PING` + `GET_SCHEMA` 带 `bridgeVersion` 探活，三种报错文案区分（未注入 / 旧版去重载扩展 / 找不到字段）。
- 状态：已处理。
- 还缺：无。

### D3. 定位只亮第一个选项 / 高亮看不见

- 现象：单选组定位落在第一个小圆点上，几乎看不见；早期高亮渐显太慢，峰值没到就回收了。
- 根因：只高亮了单个 input；transition 时机不对。
- 当前处理：整组最小公共祖先容器打描边 + 每个成员轻描边（token 蓝 `#0284c7` 系）；先关过渡瞬间上色、保持 1.2s 再 0.8s 渐隐。
- 状态：已处理。
- 还缺：无。

### D4. 特殊页面无法注入（chrome:// 等）

- 现象：sendMessage 不通。
- 根因：浏览器禁区，content 根本进不去。
- 当前处理：友好报错“刷新页面后重试”，不抛异常。
- 状态：已处理（策略如此）。
- 还缺：无。

### D5. 折叠手风琴（ng-repeat 块根 #subGroup_* + .mdf-tit + .tableDiv）

- 现象：收起状态下点侧边栏行，只能滚到一个 label，正文点不开，很怪。
- 根因：收起时正文容器被 `display:none` 或限高 + `overflow:hidden` 压住，目标控件 rect 为 0 或被裁掉，滚动/focus 落不到实处。
- 当前处理（纯登记制，无启发式）：折叠展开只认 `lib/expand-rules.ts` 的 `EXPAND_RULES` 登记表（{id, hostSuffix, toggles, scope}，host 长后缀优先命中，无命中回 null）。首条 `chinatelecom-job`（hostSuffix `job.chinatelecom.com.cn`，toggles `['img.up-down-img', '.mdf-tit']`，scope `div[id^=subGroup_]`，凭据见仓库根 `test.html`）。
- 单点 `lib/fill.ts` 的 `pageFocusField`：先判可见（有尺寸 + 祖先无 `display:none` + 不被限高祖先裁掉）；看不见且命中规则才点规则 scope 内登记的开关（总预算 1.5s，点后 450ms 复查）；无命中 / 点后仍不可见 / 超时一律降级直跳——滚到目标最近可见祖先并高亮该祖先，`ok:true`（不 toast 打断用户），`ok:false` 只留给真正找不到控件。
- 状态：已处理。
- 预展开：`GET_SCHEMA`/`FILL` 前 `content.ts` 先查表，有规则才跑 `lib/fill.ts` 的 `pageExpandAll`（只遍历规则 scope，只点藏着控件的 scope 内登记的选择器，单轮 ≤20、最多 3 轮×500ms）；无规则直接跳过，连扫描都不扫。登记选择器点击前保留安全排除（外链 href / submit / delete 类不点，防规则写错）。通用 toggle 猜测与全页启发式扫描已整坨删除（删掉的函数见 fill.ts 历史：两处 `findToggle`、`blockRootOf`、`collectToggles`、误关恢复循环）。
- 加站三步：存档 html（放仓库根 test-*.html 作回归凭据）→ 在存档里找块根 + 开关选择器（只认展开开关，外链/submit/删除排除）→ 在 `EXPAND_RULES` 追加一条，toggles 按点击优先级排。
- 还缺：真机手风琴页实测（收起/嵌套/懒加载各一遍）；Shadow DOM / iframe 内的折叠还不在覆盖范围。

### D6. 非招聘页门禁（白名单制）

- 现象：任意页面都抽取，非招聘页误触发、打扰用户。
- 根因：content 的 `matches` 全网注入，没有运行时门禁。
- 当前处理：`lib/recruiting.ts` 的 `isRecruitingPage` 三条规则（招聘首段子域 / 平台域名表 / 招聘路径关键字），`content.ts` 的 `GET_SCHEMA`（及 `FILL`/`CLEAR`/`FOCUS_FIELD`）不命中直接回 `nonRecruiting`，侧边栏展示专用空态；`manifest.matches` 不动，`PING` 不拦截。
- 状态：已处理。
- 还缺：白名单以后由设置页接管（用户可增删平台域名/子域/关键字）。

### D7. 切 Tab 后 AI 决策丢失

- 现象：一键生成后切个 Tab 再切回，AI 结果没了，得重新花钱生成。
- 根因：plan 只放 React state；`onActivated` 静默重抽切到新表 shape，旧 plan 被清空，且没留存。
- 当前处理：`features/server/hooks.ts` 单槽缓存（`window.localStorage` 的 `autoInfo.aiPlan`，新生成直接覆盖）：生成成功落缓存并记 url+tab 归属；shape 实变时 url 一致才恢复，否则丢缓存用现抽；tab 关掉清槽；一键清除也清槽。
- 状态：已处理。
- 还缺：无。

## E. 待验证（疑似风险，还没实测撞上）

| # | 风险 | 说明 |
|---|------|------|
| E1 | Shadow DOM 里的表单 | `querySelector` 进不去影子根，抽取会漏整块；撞上再做穿透抽取。 |
| E2 | iframe 嵌套的网申表 | content 脚本默认是否进 iframe 取决于注册的 allFrames，撞上再确认。 |
| E3 | 滑块 / 验证码 | by design 不碰，遇到直接进未填 + 人工处理，和附件同策略。 |

---

## 追加模板（复制 rewrite 改）

```md
### Xn. 一句话标题

- 现象：用户看到了什么。
- 根因：为什么会这样（一句话机理）。
- 当前处理：哪个文件的哪个函数/哪条规则。
- 状态：已处理 / 观察中 / 待处理。
- 还缺：下次再来时要看什么。
```
