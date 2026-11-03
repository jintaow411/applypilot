/**
 * 页面内的「表单结构化」提取器（TS 版）。
 *
 * 对应关系：移植自 src/extract.js 的 extractSchema()，行为逐条对齐：
 *   - clean / stripStars 文本清洗
 *   - label 回退链：label[for] → 包裹 label → aria-label → aria-labelledby → attrLabel(msg/data-label/data-title/label/aria-label/title)
 *     → labelCellOf（左侧标签格）→ 同行表头 → 前兄弟节点 → 容器文本（labelOf）
 *   - sectionOf 区块判定（SECTION / FIELDSET / nav_ 开头 id / class 含 section|block|group|panel|part|chapter）
 *   - optionTextOf / groupLabel 选项与分组标签
 *   - data-ai-id / data-ai-opt 标记注入
 *   - 弹窗与下拉搜索框过滤、isVisible / isHoneypot
 *   - pageMetaOf：JS 只收清单（外链 src、内联长度 + djb2 hash），CSS 只收 href + 规则数
 *
 * 注意：extractSchema 会被 page.evaluate 序列化后注入页面，必须完全自包含
 * （除 DOM 全局外不引用任何外部变量，故所有辅助函数都定义在函数体内）。
 */
import type { ExtractResult, Field, FieldKind, FieldOption, PageMeta, ScriptMeta, StylesheetMeta } from './schema.js';

export function extractSchema(): ExtractResult {
  const clean = (s: string | null | undefined): string =>
    (s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

  const stripStars = (s: string | null | undefined): string =>
    clean(s)
      .replace(/^[*＊\s]+/, '')
      .replace(/\s*[*＊]\s*$/, '')
      .trim();

  const isVisible = (el: Element): boolean => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    // 只看盒子本身有没有尺寸，不看它相对视口的位置：
    // 滚到页面底部时，上方字段的 rect.bottom < 0，若按视口过滤就会把它们丢掉
    // （顶部清空=54 道、底部清空=1 道、中部=二三十道，就是这么来的）。
    // 真正隐藏的（display:none / hidden / 透明）上面已经排除了。
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return true;
  };

  // 上报用：JS 只收清单（外链 src 列表＋内联脚本长度/hash），不收全文
  const pageMetaOf = (): PageMeta => {
    const hash = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    };
    const scripts = Array.from(document.scripts).map((s): ScriptMeta =>
      s.src
        ? { src: s.src }
        : { inline: true, chars: (s.textContent || '').length, hash: hash(s.textContent || '') }
    );
    const stylesheets: StylesheetMeta[] = [];
    for (const sh of Array.from(document.styleSheets)) {
      try {
        stylesheets.push({ href: sh.href || '(inline <style>)', rules: sh.cssRules.length });
      } catch {
        stylesheets.push({ href: sh.href || '(inline)', rules: 'blocked' });
      }
    }
    return { scripts, stylesheets };
  };

  const isHoneypot = (el: Element): boolean => {
    if (el.getAttribute('tabindex') === '-1') return true;
    if (/hp_|honeypot|_trap/i.test(el.getAttribute('name') || '')) return true;
    return false;
  };

  const textWithoutControls = (node: Element): string => {
    const c = node.cloneNode(true) as Element;
    c.querySelectorAll('input,select,textarea,button,[contenteditable]').forEach((n) => n.remove());
    return clean(c.textContent);
  };

  // 控件自带的语义属性（不同框架写法不一，按可信度排）
  const attrLabel = (el: Element): string => {
    for (const name of ['msg', 'data-label', 'data-title', 'label', 'aria-label', 'title']) {
      const v = el.getAttribute(name);
      if (v && clean(v) && clean(v).length <= 30) return clean(v);
    }
    return '';
  };

  // 网上申报类表单常见结构：<div class="...cell-l" title="姓名"><span>姓名</span></div>
  // 控件在右侧的 cell-r 里，label 在兄弟节点的“左侧标签格”
  const labelCellOf = (el: Element): string => {
    const looksLikeLabel = (n: Element | null): boolean => {
      if (!n || n.querySelector('input,select,textarea,[contenteditable]')) return false;
      const cls = (n.className || '').toString();
      const t = clean(n.getAttribute('title')) || clean(n.textContent);
      return /(cell-l|form-label|label|lbl|name|title)/i.test(cls) && t.length > 0 && t.length <= 30;
    };

    let node: Element | null = el;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const prev = node.previousElementSibling;
      if (looksLikeLabel(prev)) {
        return clean(prev?.getAttribute('title')) || textWithoutControls(prev as Element);
      }
      // 有些站点把 label 挂在控件所在单元格的前一个单元格
      const cell = node.closest('td,th');
      if (cell && cell.previousElementSibling && looksLikeLabel(cell.previousElementSibling)) {
        return textWithoutControls(cell.previousElementSibling);
      }
    }
    return '';
  };

  // 字段属于哪个区块（实习经历 / 项目经验 / …）。
  // 往上找最近的区块容器：section / fieldset / id 以 nav_ 开头的分块，
  // 取它里面第一个标题（h1-h4 / .mdf-tit / legend）的文字。
  const sectionOf = (el: Element): string => {
    let node: Element | null = el.parentElement;
    for (let depth = 0; depth < 10 && node && node.tagName !== 'BODY'; depth++, node = node.parentElement) {
      const tag = node.tagName;
      const id = node.id || '';
      const cls = (node.className || '').toString();
      const isSec =
        tag === 'SECTION' ||
        tag === 'FIELDSET' ||
        /^nav[_-]/i.test(id) ||
        /(^|[-_\s])(section|resume-section|block|group|panel|part|chapter)($|[-_\s])/i.test(cls);
      if (!isSec) continue;
      const h = node.querySelector(
        'h1,h2,h3,h4,legend,.mdf-tit,.section-title,.block-title,.group-title,[role="heading"]'
      );
      let t = h ? stripStars(clean(h.textContent)) : '';
      if (!t || t.length > 30) {
        const own = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-title');
        t = own ? clean(own) : '';
      }
      if (t && t.length <= 30) return t;
      // 这个容器没有标题，继续往上找更大的区块
    }
    return '';
  };

  // occurrence 分组键：同（section,label）为一组；section 为空时用就近容器回退——
  // 复用 sectionOf 的容器判定：有标题就按标题分组，无标题用容器标识（同列表同键、不同列表不同键）。
  const groupKeyOf = (el: Element, section: string, label: string): string => {
    if (section) return 'S:' + section + '' + label;
    let node: Element | null = el.parentElement;
    for (let depth = 0; depth < 10 && node && node.tagName !== 'BODY'; depth++, node = node.parentElement) {
      const tag = node.tagName;
      const id = node.id || '';
      const cls = (node.className || '').toString();
      const isSec =
        tag === 'SECTION' ||
        tag === 'FIELDSET' ||
        /^nav[_-]/i.test(id) ||
        /(^|[-_\s])(section|resume-section|block|group|panel|part|chapter)($|[-_\s])/i.test(cls);
      if (!isSec) continue;
      const h = node.querySelector(
        'h1,h2,h3,h4,legend,.mdf-tit,.section-title,.block-title,.group-title,[role="heading"]'
      );
      let t = h ? stripStars(clean(h.textContent)) : '';
      if (!t) {
        const own = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-title');
        t = own ? clean(own) : '';
      }
      if (t) return 'S:' + t.slice(0, 30) + '' + label;
      return 'B:' + tag + '|' + cls + '|' + id + '' + label;
    }
    return 'B:ROOT' + label;
  };

  const labelOf = (el: Element): string => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = textWithoutControls(wrap);
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = clean(
        lb
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
      );
      if (t) return t;
    }
    const attr = attrLabel(el);
    if (attr) return attr;
    const cellLabel = labelCellOf(el);
    if (cellLabel) return cellLabel;
    // 表格布局：取同一行第一个单元格的说明文字
    const tr = el.closest('tr');
    if (tr) {
      const cell = tr.querySelector('th, td');
      const t = clean(cell?.textContent);
      if (t && t.length <= 30) return t;
    }
    // 前一个兄弟节点（常见：<div class="lbl">字段名</div><input>）
    const prev = el.previousElementSibling;
    if (prev && !prev.querySelector('input,select,textarea,[contenteditable]')) {
      const t = clean(prev.textContent);
      if (t && t.length <= 40) return t;
    }
    // 包一层的容器里的文字
    // 飞书招聘表单用 data-form-field-id 标记字段容器，字段控件本身
    // 常被多层 label/div 包裹；优先取该容器，避免学校、日期范围和长题目丢标签。
    const box = el.closest('[data-form-field-id],.field,.form-item,.ant-form-item,.form-group,td,li');
    const t = textWithoutControls(box || (el.parentElement as Element));
    if (t && t.length <= 40) return t;
    return '';
  };

  const optionTextOf = (m: Element): string => {
    const lab = m.closest('label');
    if (lab) {
      const t = textWithoutControls(lab);
      if (t && t.length <= 20) return t;
    }
    const sib = m.nextElementSibling;
    if (sib) {
      const t = clean(sib.getAttribute('title')) || textWithoutControls(sib);
      if (t && t.length <= 20) return t;
    }
    const t = textWithoutControls(m.parentElement as Element);
    return t && t.length <= 20 ? t : clean((m as HTMLInputElement).value);
  };

  const groupLabel = (members: Element[]): string => {
    const first = members[0];
    // 优先整行（表格布局），再退到字段容器，避免落进只包着选项的 <td>
    const box =
      first.closest('tr') ||
      first.closest('.field,.form-item,.ant-form-item,fieldset') ||
      first.closest('td') ||
      (first.parentElement as Element);
    const cands = Array.from(box.querySelectorAll('label,.label,.lbl,legend,dt,td.k,th')).filter(
      (n) => !n.querySelector('input,select,textarea')
    );
    const t = clean(cands.map((n) => n.textContent).join(' '));
    if (t) return t;
    return labelOf(first);
  };

  const assignId = (el: Element, id: string): void => {
    el.setAttribute('data-ai-id', id);
  };

  const nodes = Array.from(
    document.querySelectorAll<Element>(
      'input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="combobox"], button.dropdown-toggle'
    )
  ).filter((el) => {
    /* bootstrap 开关 button：不过可见性过滤（配对时再判），只排除菜单/搜索框/隐藏弹窗里的 */
    if (el.tagName === 'BUTTON') {
      if (!el.classList.contains('dropdown-toggle')) return false;
      if (el.closest('.bs-searchbox,[role="listbox"],[role="menu"]')) return false;
      const dialog = el.closest('.modal,[role="dialog"],.ant-modal,.el-dialog');
      if (dialog && !dialog.matches('.in,.show,[aria-hidden="false"],.ant-modal-wrap')) return false;
      return true;
    }
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    if (el.tagName === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
    // 得物/飞书多选控件内部的 inline search input 不是表单字段。
    // 外层 role=combobox 仍需保留，它才是可操作的自定义下拉字段。
    if (el.tagName === 'INPUT' && /select-search/i.test(String(el.className || ''))) return false;
    if (el.closest('[hidden]')) return false;
    // 弹窗/抽屉模板（学校选择器、城市选择器）不是主表单
    const dialog = el.closest('.modal,[role="dialog"],.ant-modal,.el-dialog');
    if (dialog && !dialog.matches('.in,.show,[aria-hidden="false"],.ant-modal-wrap')) return false;
    // 下拉组件自带的搜索框（bootstrap-select / antd / element 都会塞一个）
    if (el.closest('.bootstrap-select,.bs-searchbox,.dropdown-menu,[role="listbox"],[role="menu"]')) return false;
    if (/^search$/i.test(el.getAttribute('aria-label') || '')) return false;
    return isVisible(el) && !isHoneypot(el);
  });

  /* 抽取幂等：清掉上次抽取留在 DOM 上的旧标记，否则重抽时 bootstrap 第二遍会因 select 已带 data-ai-id 而整批跳过（102→64 且永不恢复的真凶）。
     主循环不认旧标记、只认本轮 seen；FILL 与抽取不会并发（单线程，消息排队），清标记不影响正在填的步骤。 */
  try {
    for (const n of Array.from(document.querySelectorAll('[data-ai-id],[data-ai-opt]'))) {
      n.removeAttribute('data-ai-id');
      n.removeAttribute('data-ai-opt');
    }
  } catch {
    /* 清理失败就当没清，主循环照常打标 */
  }
  /* bootstrap 配对：可见 button[data-toggle=dropdown] 通过 data-id 或就近容器配对原生 select（常被藏起来）。 */
  const digitCore = (s: string): string => (s.match(/\d+/g) || []).join('');
  const pairSelectOf = (btn: Element): HTMLSelectElement | null => {
    const did = btn.getAttribute('data-id');
    if (did) {
      const s = document.getElementById(did);
      if (s && s.tagName === 'SELECT') return s as HTMLSelectElement;
    }
    let node: Element | null = btn.parentElement;
    for (let d = 0; d < 3 && node; d++, node = node.parentElement) {
      const sels = Array.from(node.querySelectorAll('select'));
      const hit = sels.find((s) => !s.hasAttribute('data-ai-id')) || sels[0];
      if (hit) return hit as HTMLSelectElement;
    }
    return null;
  };
  const bootstrapOptions = (sel: HTMLSelectElement): FieldOption[] =>
    Array.from(sel.options)
      .map((o) => ({
        text: clean(o.textContent),
        value: o.value,
        disabled: o.disabled,
      }))
      .filter((o) => (o.text || o.value) && !(o.value === '' && /请选择/.test(o.text)));
  const fields: Field[] = [];
  const groupKeys: string[] = [];
  const fieldMembers: Element[][] = [];
  const seen = new Set<Element>();
  let seq = 0;

  for (const el of nodes) {
    if (seen.has(el)) continue;
    /* bootstrap 开关：在 DOM 原位直接建字段，顺序天然正确，不用事后排序 */
    if (el.tagName === 'BUTTON') {
      const btn = el;
      const toggle = btn.getAttribute('data-toggle') || btn.getAttribute('data-bs-toggle');
      if (toggle !== 'dropdown') continue;
      const bsel = pairSelectOf(btn);
      if (!bsel || bsel.hasAttribute('data-ai-id')) continue; // 已认领（可见原生 select 走主分支）
      if (!isVisible(btn) && !isVisible(bsel)) continue;
      if (isHoneypot(bsel)) continue;
      seen.add(btn);
      seen.add(bsel);
      const bid = `af-${++seq}`;
      assignId(btn, bid);
      assignId(bsel, bid);
      const msg = clean(bsel.getAttribute('msg'));
      const baseLabel = labelOf(bsel);
      const brawLabel = msg || baseLabel;
      const bsection = sectionOf(bsel);
      const bfinalLabel = stripStars(brawLabel);
      groupKeys.push(groupKeyOf(btn, bsection, bfinalLabel));
      const bbox = bsel.closest('.field,.form-item,.ant-form-item,.form-group,td,li,tr');
      fields.push({
        id: bid,
        kind: 'select',
        type: (bsel.type || '').toLowerCase(),
        tag: 'select',
        name: bsel.getAttribute('name') || '',
        label: bfinalLabel,
        rawLabel: clean(brawLabel),
        section: bsection,
        placeholder: clean(bsel.getAttribute('placeholder')),
        required: bsel.required || bsel.getAttribute('aria-required') === 'true' || /[*＊]/.test(brawLabel) || /必填/.test(brawLabel),
        disabled: bsel.disabled,
        readonly: false,
        maxLength: bsel.getAttribute('maxlength') || '',
        options: bootstrapOptions(bsel),
        value: bsel.value || '',
        wrapperText: clean(bbox?.textContent || '').slice(0, 80),
      });
      fieldMembers.push([btn, bsel]);
      continue;
    }
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    const isChoice = type === 'radio' || type === 'checkbox';
    const members: Element[] =
      isChoice && (el as HTMLInputElement).name
        ? nodes.filter(
            (x) => (x as HTMLInputElement).type === type && (x as HTMLInputElement).name === (el as HTMLInputElement).name
          )
        : [el];
    members.forEach((m) => seen.add(m));
    fieldMembers.push(members);

    const id = `af-${++seq}`;
    members.forEach((m, i) => {
      assignId(m, id);
      if (members.length > 1) m.setAttribute('data-ai-opt', String(i));
    });

    let kind: FieldKind;
    if (members.length > 1) kind = type === 'radio' ? 'radio-group' : 'checkbox-group';
    else if (el.tagName === 'SELECT') kind = 'select';
    else if (el.tagName === 'TEXTAREA') kind = 'textarea';
    else if (el.hasAttribute('contenteditable')) kind = 'richtext';
    else if (el.matches('[role="combobox"]')) kind = 'custom-select';
    else if (type === 'checkbox') kind = 'checkbox';
    else if (type === 'radio') kind = 'radio';
    else if (type === 'file') kind = 'file';
    else if (type === 'date' || type === 'month') kind = 'date';
    else if (type === 'number') kind = 'number';
    else if (type === 'tel') kind = 'tel';
    else if (type === 'email') kind = 'email';
    else kind = 'text';

    let options: FieldOption[] = [];
    if (kind === 'select') {
      options = Array.from((el as HTMLSelectElement).options).map((o) => ({
        text: clean(o.textContent),
        value: o.value,
        disabled: o.disabled,
      }));
    } else if (kind === 'radio-group' || kind === 'checkbox-group') {
      options = members.map((m, i) => ({ text: optionTextOf(m), value: (m as HTMLInputElement).value, index: i }));
    } else if (kind === 'custom-select') {
      const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const list = listId
        ? document.getElementById(listId)
        : el.parentElement?.querySelector('[role="listbox"],[role="menu"]');
      options = list
        ? Array.from(list.querySelectorAll('[role="option"],li')).map((n) => ({
            text: clean(n.textContent),
            value: n.getAttribute('data-value') || '',
          }))
        : [];
    }

    const rawLabel = members.length > 1 ? groupLabel(members) : labelOf(el);
    const section = sectionOf(members[0]);
    const finalLabel = stripStars(rawLabel);
    groupKeys.push(groupKeyOf(el, section, finalLabel));
    const placeholder = clean(el.getAttribute('placeholder'));
    const required = members.some(
      (m) => (m as HTMLInputElement).required || m.getAttribute('aria-required') === 'true'
    );
    const box = el.closest('[data-form-field-id],.field,.form-item,.ant-form-item,.form-group,td,li,tr');
    const wrapperText = clean(box?.textContent || '').slice(0, 80);

    fields.push({
      id,
      kind,
      type,
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute('name') || '',
      label: finalLabel,
      rawLabel: clean(rawLabel),
      section,
      placeholder,
      required: required || /[*＊]/.test(rawLabel) || /必填/.test(rawLabel),
      disabled: members.every((m) => (m as HTMLInputElement).disabled),
      readonly: members.every((m) => (m as HTMLInputElement).readOnly),
      maxLength: el.getAttribute('maxlength') || '',
      options,
      value: kind.endsWith('-group')
        ? members.filter((m) => (m as HTMLInputElement).checked).map((m) => (m as HTMLInputElement).value)
        : (el as HTMLInputElement).value || '',
      wrapperText,
    });
  }



  /* 二级联动合并：连续两个 select 字段、后者只有占位选项、同一容器 → 同一个字段（data-ai-id 统一成前者）。
     年/月这种两边都有完整选项的不合并。 */
  const selectOf = (ms: Element[]): HTMLSelectElement | null => {
    for (const m of ms) if (m.tagName === 'SELECT') return m as HTMLSelectElement;
    return null;
  };
  const hasRealOptions = (sel: HTMLSelectElement): boolean =>
    Array.from(sel.options).some((o) => {
      const t = clean(o.textContent);
      return t !== '' && !/^(请选择|请先选择|加载中|--|—)/.test(t);
    });
  for (let i = fieldMembers.length - 1; i > 0; i--) {
    const prev = fields[i - 1];
    const cur = fields[i];
    if (prev.kind !== 'select' || cur.kind !== 'select') continue;
    const ps = selectOf(fieldMembers[i - 1]);
    const cs = selectOf(fieldMembers[i]);
    if (!ps || !cs) continue;
    if (hasRealOptions(cs)) continue;
    /* 同一容器：往上 6 层内离 ps 最近的、同时包住 cs 的祖先（排除 body/form 根）；
       div 布局（如 .ipt-item-half/.ipt-item9）下 closest(td/.field) 经常取不到，改用公共祖先。 */
    let sameBox: Element | null = null;
    try {
      let p: Element | null = ps.parentElement;
      for (let d = 0; d < 6 && p && p !== document.body && p !== document.documentElement; d++, p = p.parentElement) {
        if (p.contains(cs)) {
          const tag = (p.tagName || '').toUpperCase();
          sameBox = tag === 'FORM' || tag === 'BODY' || tag === 'HTML' ? null : p;
          break;
        }
      }
    } catch {
      sameBox = null;
    }
    if (!sameBox) continue;
    const pc = digitCore(ps.id || ps.getAttribute('name') || '');
    const cc = digitCore(cs.id || cs.getAttribute('name') || '');
    if (pc && cc && pc !== cc) continue; // 编号对不上不合并
    const keepId = prev.id;
    for (const n of fieldMembers[i]) n.setAttribute('data-ai-id', keepId);
    fields.splice(i, 1);
    fieldMembers.splice(i, 1);
    groupKeys.splice(i, 1);
  }

  /* 同（section,label）按 DOM 顺序编 occurrence（1 起）并计 groupTotal：多段重复块的区分依据 */
  const groupTotals = new Map<string, number>();
  for (const k of groupKeys) groupTotals.set(k, (groupTotals.get(k) ?? 0) + 1);
  const groupSeen = new Map<string, number>();
  fields.forEach((f, i) => {
    const total = groupTotals.get(groupKeys[i]) ?? 1;
    const n = (groupSeen.get(groupKeys[i]) ?? 0) + 1;
    groupSeen.set(groupKeys[i], n);
    f.occurrence = n;
    f.groupTotal = total;
  });

  return { url: location.href, title: document.title, fields, meta: pageMetaOf() };
}
