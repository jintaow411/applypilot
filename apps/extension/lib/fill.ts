/**
 * 页面内执行的填充动作（TS 版）。
 *
 * 对应关系：移植自 src/fill.js，逐个动作与页面标记一一对应：
 *   pageSetText / pageSetRichText / pageReadOptions / pageChooseOption（按 index 优先）/
 *   pageClickTextOption / pageOpenCustomSelect / pageCheck / pageInspect
 *
 * 关键点（与 JS 版一致）：React/Vue 的受控组件对 `el.value = x` 免疫，
 * 必须用原型链上的原生 setter 赋值，再派发 input/change 事件。
 *
 * 注意：这些函数会被 page.evaluate 序列化后注入页面，必须完全自包含；
 * 只用 data-ai-id / data-ai-opt 标记定位元素，不依赖任何模块级变量。
 */
import type { FieldOption } from './schema.js';
import { matchExpandRule, type ExpandRule } from './expand-rules.js';

export interface SetTextArgs {
  id: string;
  value: string;
}

export interface ActionResult {
  ok: boolean;
  why?: string;
  /** 回读到的控件值 */
  value?: string;
  /** select 选中项的文本 */
  text?: string;
  checked?: boolean;
  /** pageClickTextOption 找不到选项时回传候选文本 */
  options?: string[];
}

export interface ChooseOptionArgs {
  id: string;
  /** 组内序号，对应页面上的 data-ai-opt；优先于 text */
  index?: number | null;
  text: string;
}

export interface InspectResult {
  id: string;
  missing?: boolean;
  value?: string;
  empty?: boolean;
  error?: boolean;
}

/** 直接赋值 + 派发事件（select 走原生 value setter，其余走 input/textarea setter） */
export function pageSetText({ id, value }: SetTextArgs): ActionResult {
  let el = document.querySelector<HTMLElement>(`[data-ai-id="${id}"]`);
  if (!el) return { ok: false, why: 'not-found' };
  /* bootstrap-select：button 和 select 共用 data-ai-id，写值必须落在原生 select 上 */
  if (el.tagName !== 'SELECT') {
    const sel = document.querySelector<HTMLElement>(`select[data-ai-id="${id}"]`);
    if (sel) el = sel;
  }
  if (el.tagName === 'BUTTON' || el.tagName === 'A') return { ok: false, why: 'not-selectable' };

  if (el.tagName === 'SELECT') {
    const sel = el as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(sel, value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const opt = sel.selectedOptions[0];
    return { ok: sel.value === value, value: sel.value, text: opt && opt.textContent ? opt.textContent.trim() : '' };
  }

  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  el.focus({ preventScroll: true });
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (el.blur) el.blur();
  return { ok: true, value: (el as HTMLInputElement).value };
}

/** 富文本：清空后按行插入 <p>，再派发 InputEvent（多个富文本编辑器依赖 inputType） */
export function pageSetRichText({ id, value }: SetTextArgs): ActionResult {
  const el = document.querySelector<HTMLElement>(`[data-ai-id="${id}"]`);
  if (!el) return { ok: false, why: 'not-found' };
  el.focus({ preventScroll: true });
  el.textContent = '';
  for (const line of String(value).split(/\n+/)) {
    const p = document.createElement('p');
    p.textContent = line;
    el.appendChild(p);
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: el.innerText.trim() };
}

/** 读当前选项：原生 select 读 options，自定义下拉读 aria-controls 指向的 listbox */
export function pageReadOptions(id: string): FieldOption[] {
  /* bootstrap-select：优先读原生 select 的 options（button 和 select 共用 data-ai-id） */
  const el =
    document.querySelector<HTMLElement>(`select[data-ai-id="${id}"]`) ||
    document.querySelector<HTMLElement>(`[data-ai-id="${id}"]`);
  if (!el) return [];
  if (el.tagName === 'SELECT') {
    return Array.from((el as HTMLSelectElement).options).map((o) => ({
      text: (o.textContent || '').trim(),
      value: o.value,
      disabled: o.disabled,
    }));
  }
  const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  // 飞书/得物的下拉选项会通过 portal 挂到 body，不在控件父节点下面。
  const list =
    (listId ? document.getElementById(listId) : null) ||
    el.parentElement?.querySelector('[role="listbox"],[role="menu"]') ||
    document.querySelector('[role="listbox"]:not([aria-hidden="true"]),[role="menu"]:not([aria-hidden="true"])');
  if (!list) return [];
  return Array.from(list.querySelectorAll('[role="option"],li')).map((n) => ({
    text: (n.textContent || '').trim(),
    value: n.getAttribute('data-value') || '',
  }));
}

/** 同 id 下原生 select 的个数（bootstrap 二级联动=2，普通=1） */
export function pageCountSelects(id: string): number {
  return document.querySelectorAll(`select[data-ai-id="${id}"]`).length;
}

/** 读第 index 个同 id select 的选项（二级联动的省/市分开读，填充时调用 */
export function pageReadSelectOptions({ id, index }: { id: string; index: number }): FieldOption[] {
  const sels = Array.from(document.querySelectorAll<HTMLSelectElement>(`select[data-ai-id="${id}"]`));
  const sel = sels[index];
  if (!sel) return [];
  return Array.from(sel.options).map((o) => ({
    text: (o.textContent || '').trim(),
    value: o.value,
    disabled: o.disabled,
  }));
}

/** 写第 index 个同 id select 的值（原生 setter + 事件，与 pageSetText 的 SELECT 分支一致） */
export function pageSetSelectValue({ id, index, value }: { id: string; index: number; value: string }): ActionResult {
  const sels = Array.from(document.querySelectorAll<HTMLSelectElement>(`select[data-ai-id="${id}"]`));
  const sel = sels[index];
  if (!sel) return { ok: false, why: 'not-found' };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(sel, value);
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const opt = sel.selectedOptions[0];
  return { ok: sel.value === value, value: sel.value, text: opt && opt.textContent ? opt.textContent.trim() : '' };
}

/** 勾选组内某个选项：按 data-ai-opt 序号优先，其次按文本/值兜底 */
export function pageChooseOption({ id, index, text }: ChooseOptionArgs): ActionResult {
  const members = Array.from(document.querySelectorAll<HTMLInputElement>(`[data-ai-id="${id}"]`));
  if (!members.length) return { ok: false, why: 'not-found' };
  let hit: HTMLInputElement | null = null;
  if (index !== undefined && index !== null) {
    hit = members.find((m) => m.getAttribute('data-ai-opt') === String(index)) || null;
  }
  if (!hit) {
    hit =
      members.find((m) => {
        const label = m.closest('label');
        const sib = m.nextElementSibling;
        const t = (label ? label.textContent : '') || sib?.getAttribute('title') || sib?.textContent || m.value || '';
        return t.replace(/\s/g, '') === String(text).replace(/\s/g, '') || m.value === text;
      }) || null;
  }
  if (!hit) return { ok: false, why: 'option-missing' };
  hit.click();
  return { ok: true, checked: hit.checked, value: hit.value };
}

/** 点击自定义下拉里的文本项（先点开控件，再按文本精确匹配） */
export function pageClickTextOption({ id, text }: { id: string; text: string }): ActionResult {
  const el = document.querySelector<HTMLElement>(`[data-ai-id="${id}"]`);
  if (!el) return { ok: false, why: 'not-found' };
  const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  const list =
    (listId ? document.getElementById(listId) : null) ||
    el.parentElement?.querySelector('[role="listbox"],[role="menu"]') ||
    document.querySelector('[role="listbox"]:not([aria-hidden="true"]),[role="menu"]:not([aria-hidden="true"])');
  if (!list) return { ok: false, why: 'no-list' };
  const items = Array.from(list.querySelectorAll<HTMLElement>('[role="option"],li')).filter((item) => {
    const r = item.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const hit = items.find((n) => (n.textContent || '').trim() === String(text).trim());
  if (!hit) return { ok: false, why: 'option-missing', options: items.map((n) => (n.textContent || '').trim()) };
  hit.click();
  return { ok: true };
}

/** 单个 checkbox / radio：按布尔语义决定勾还是不勾 */
export function pageCheck({ id, wanted }: { id: string; wanted: string | number | null | undefined }): ActionResult {
  const el = document.querySelector<HTMLInputElement>(`[data-ai-id="${id}"]`);
  if (!el) return { ok: false, why: 'not-found' };
  const want = !/^(false|0|no|否|不接受)$/i.test(String(wanted));
  if (el.checked !== want) el.click();
  return { ok: el.checked === want, checked: el.checked };
}

/** 点开自定义下拉（先 click 再等异步选项） */
export function pageOpenCustomSelect(id: string): ActionResult {
  const el = document.querySelector<HTMLElement>(`[data-ai-id="${id}"]`);
  if (!el) return { ok: false, why: 'not-found' };
  // 得物的真实触发器是 readonly input 外层 selector；旧逻辑点击 input
  // 在部分版本中只获得焦点而不会打开 portal 弹层。
  const trigger =
    el.closest<HTMLElement>('[role="combobox"],.ud__select__selector,.atsx-select-selection') || el;
  trigger.click();
  return { ok: true };
}

/** 一键清除：把给定 id 的控件值全部清空（文本/下拉置空、勾选取消、富文本清空），自包含可被 evaluate 序列化 */
export function pageClearAll(ids: string[]): { cleared: number; total: number } {
  let cleared = 0;
  for (const id of ids) {
    const members = Array.from(document.querySelectorAll<HTMLElement>('[data-ai-id="' + id + '"]'));
    if (!members.length) continue;
    const el = members[0];
    try {
      if (members.length > 1) {
        for (const m of members) {
          const input = m as HTMLInputElement;
          if (input.checked) input.click();
        }
        cleared++;
        continue;
      }
      const tag = el.tagName;
      if (tag === 'SELECT') {
        const sel = el as HTMLSelectElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(sel, '');
        sel.selectedIndex = -1;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        cleared++;
        continue;
      }
      if (tag === 'INPUT') {
        const input = el as HTMLInputElement;
        const type = (input.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if (input.checked) input.click();
        } else {
          const proto = HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
          (el as HTMLElement).focus?.({ preventScroll: true });
          setter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if ((el as HTMLElement).blur) (el as HTMLElement).blur();
        }
        cleared++;
        continue;
      }
      if (tag === 'TEXTAREA') {
        const proto = HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        cleared++;
        continue;
      }
      if (el.hasAttribute('contenteditable')) {
        (el as HTMLElement).focus?.({ preventScroll: true });
        el.textContent = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        cleared++;
        continue;
      }
      cleared++;
    } catch {
      /* 单个失败不中断 */
    }
  }
  return { cleared, total: ids.length };
}

/**
 * 定位高亮：滚动到 data-ai-id 控件并 focus，高亮闪一下后 2s 内渐隐复原。
 * 自包含（只用 document / window），可被 evaluate 序列化注入页面。
 * radio/checkbox 组有多个同 id 控件时取该组第一个可见控件。
 */
/**
 * 定位高亮：滚动到 data-ai-id 控件并 focus，高亮闪一下后 2s 内渐隐复原。
 * 自包含（只用 document / window），可被 evaluate 序列化注入页面。
 * radio/checkbox 组有多个同 id 控件时取该组第一个可见控件。
 *
 * 折叠展开走纯登记制（lib/expand-rules.ts）：命中规则才点规则里登记的开关；
 * 无命中 / 点后仍不可见 / 超时（总预算 1.5s），一律降级为直接跳——
 * 滚到目标最近可见祖先并高亮该祖先，return ok:true（不 toast 打断用户）。
 * ok:false 只留给真正找不到控件的情况。
 */
export async function pageFocusField(fieldId: string): Promise<{ ok: boolean; error?: string }> {
  const id = String(fieldId || '');
  if (!id) return { ok: false, error: '缺少字段 id' };
  const members = Array.from(document.querySelectorAll<HTMLElement>('[data-ai-id="' + id + '"]'));
  if (!members.length) return { ok: false, error: '页面上找不到该字段，可能被折叠或尚未加载' };
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => window.setTimeout(() => resolve(), ms));
  const rectOk = (node: HTMLElement): boolean => {
    try {
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = window.getComputedStyle(node);
      if ((cs.display || '').toLowerCase() === 'none') return false;
      const vis = (cs.visibility || '').toLowerCase();
      if (vis === 'hidden' || vis === 'collapse') return false;
      return true;
    } catch {
      return false;
    }
  };
  /* 离 node 最近的折叠容器：display:none，或限高裁掉（scroll 差值>100 且 overflow 非 visible）。
     纯可见性判定，不猜开关，只回答“藏没藏”。 */
  const foldedAncestor = (node: HTMLElement): HTMLElement | null => {
    let p: HTMLElement | null = node;
    for (let d = 0; d < 13 && p; d++, p = p.parentElement) {
      try {
        const cs = window.getComputedStyle(p);
        if ((cs.display || '').toLowerCase() === 'none') return p;
        const ov = ((cs.overflow || '') + ' ' + (cs.overflowY || '')).toLowerCase();
        const clipped =
          ov.indexOf('hidden') >= 0 || ov.indexOf('clip') >= 0 || ov.indexOf('auto') >= 0 || ov.indexOf('scroll') >= 0;
        if (!clipped) continue;
        if (p.scrollHeight - p.clientHeight <= 100) continue;
        /* 真滚动区（overflow auto/scroll 且有可观高度）不是折叠，别误伤 */
        const over = (cs.overflow || '').toLowerCase();
        const overY = (cs.overflowY || '').toLowerCase();
        if ((over === 'auto' || over === 'scroll' || overY === 'auto' || overY === 'scroll') && p.clientHeight > 120) continue;
        return p;
      } catch {
        /* 忽略单个祖先 */
      }
    }
    return null;
  };
  const isShown = (node: HTMLElement): boolean => rectOk(node) && !foldedAncestor(node);
  let target: HTMLElement | null = null;
  for (const m of members) {
    try {
      if (isShown(m)) {
        target = m;
        break;
      }
    } catch {
      /* 单个可见性判断失败就跳过，看下一个 */
    }
  }
  if (!target) target = members[0];
  const anchor: HTMLElement = target;

  /* ---------- 登记制展开：只点规则开关，无规则不猜 ---------- */
  let rule: ExpandRule | null = null;
  try {
    rule = matchExpandRule(window.location.href);
  } catch {
    rule = null;
  }
  /* 登记选择器安全排除（防规则写错，是安全项不是启发式）：外链 / submit / delete 类一律不点 */
  const ruleSafe = (cand: Element): cand is HTMLElement => {
    if (!(cand instanceof HTMLElement) || !rectOk(cand)) return false;
    if (cand === anchor) return false;
    const tag = (cand.tagName || '').toUpperCase();
    try {
      const host =
        tag === 'A'
          ? (cand as HTMLAnchorElement)
          : ((cand as HTMLElement).closest('a[href]') as HTMLAnchorElement | null);
      if (host && host.hasAttribute && host.hasAttribute('href')) {
        const href = ((host.getAttribute('href')) || '').trim().toLowerCase();
        if (href !== '#' && href.indexOf('javascript:') !== 0) return false;
      }
    } catch {
      /* 忽略 */
    }
    if (tag === 'BUTTON' || tag === 'INPUT') {
      const bt = (((cand as HTMLButtonElement).type) || '').toLowerCase();
      if (bt === 'submit' || bt === 'image') return false;
      if (!bt && tag === 'BUTTON') {
        try {
          if ((cand as HTMLElement).closest('form')) return false;
        } catch {
          /* 忽略 */
        }
      }
    }
    try {
      if (/delete|shanchu|submit/i.test((((cand as HTMLElement).className) || '').toString())) return false;
      if ((cand as HTMLElement).querySelector('[class*="elete"],[class*="hanchu"]')) return false;
    } catch {
      /* 忽略 */
    }
    if ((cand as HTMLButtonElement).disabled) return false;
    return true;
  };
  /* 在规则 scope 内按 toggles 优先级找开关（scope 自身命中选择器也算） */
  const findRuleToggle = (): HTMLElement | null => {
    if (!rule || !rule.toggles || !rule.toggles.length) return null;
    const scopes: Element[] = [];
    try {
      if (rule.scope) {
        const s = anchor.closest(rule.scope);
        if (s) scopes.push(s);
      }
    } catch {
      /* 忽略 */
    }
    if (!scopes.length) {
      try {
        if (anchor.parentElement) scopes.push(anchor.parentElement);
      } catch {
        /* 忽略 */
      }
    }
    for (const scope of scopes) {
      for (const sel of rule.toggles || []) {
        let list: Element[] = [];
        try {
          list = Array.from(scope.querySelectorAll(sel));
          try {
            if ((scope as HTMLElement).matches && (scope as HTMLElement).matches(sel)) list.unshift(scope);
          } catch {
            /* 忽略 */
          }
        } catch {
          continue;
        }
        for (const c of list) {
          if (ruleSafe(c)) return c;
        }
      }
    }
    return null;
  };
  /* 总预算 1.5s：能展开就展开，打不开/超时直接降级 */
  const deadline = Date.now() + 1500;
  let shown = false;
  try {
    shown = isShown(anchor);
  } catch {
    shown = false;
  }
  while (!shown && rule && Date.now() < deadline) {
    let toggle: HTMLElement | null = null;
    try {
      toggle = findRuleToggle();
    } catch {
      toggle = null;
    }
    if (!toggle) break;
    try {
      toggle.click();
    } catch {
      break;
    }
    await sleep(450);
    try {
      shown = isShown(anchor);
    } catch {
      shown = false;
    }
  }
  /* 降级：仍不可见就滚到最近可见祖先并高亮该祖先，ok:true */
  let main: HTMLElement = anchor;
  let group: HTMLElement[] = members;
  if (!shown) {
    let p: HTMLElement | null = null;
    try {
      p = anchor.parentElement;
    } catch {
      p = null;
    }
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        if (rectOk(p)) {
          main = p;
          break;
        }
      } catch {
        /* 忽略 */
      }
      p = p.parentElement;
    }
    group = [main];
  }
  try {
    main.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } catch {
    try {
      main.scrollIntoView();
    } catch {
      /* 尽力而为 */
    }
  }
  try {
    main.focus({ preventScroll: true });
  } catch {
    try {
      main.focus();
    } catch {
      /* 尽力而为 */
    }
  }
  try {
    main.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } catch {
    /* focus 后再对齐一次，失败忽略 */
  }
  try {
    /* 快照原内联样式（只动这几个属性，事后逐个还原，不污染页面） */
    const PROPS = ['outline', 'outline-offset', 'box-shadow', 'transition', 'background-color', 'border-radius'];
    const snap = (node: HTMLElement): string[] => PROPS.map((p) => node.style.getPropertyValue(p));
    const restore = (node: HTMLElement, s: string[]): void => {
      for (let i = 0; i < PROPS.length; i++) {
        if (s[i]) node.style.setProperty(PROPS[i], s[i]);
        else node.style.removeProperty(PROPS[i]);
      }
    };
    /* 高亮目标：强描边（容器/单个控件）+ 浅底（包裹行）+ 轻描边（组成员），最后统一还原 */
    const highlighted: { node: HTMLElement; prev: string[]; light: boolean }[] = [];
    const paintStrong = (node: HTMLElement): void => {
      highlighted.push({ node, prev: snap(node), light: false });
      node.style.setProperty('transition', 'none');
      node.style.setProperty('outline', '3px solid #0284c7', 'important');
      node.style.setProperty('outline-offset', '2px', 'important');
      node.style.setProperty('box-shadow', '0 0 0 6px rgba(2,132,199,0.35)', 'important');
    };
    const paintTint = (node: HTMLElement): void => {
      highlighted.push({ node, prev: snap(node), light: false });
      node.style.setProperty('transition', 'none');
      node.style.setProperty('background-color', 'rgba(2,132,199,0.15)', 'important');
      node.style.setProperty('border-radius', '6px');
      node.style.setProperty('outline', '2px solid #0284c7', 'important');
      node.style.setProperty('outline-offset', '2px', 'important');
    };
    const paintLight = (node: HTMLElement): void => {
      highlighted.push({ node, prev: snap(node), light: true });
      node.style.setProperty('transition', 'none');
      node.style.setProperty('outline', '2px solid #0284c7', 'important');
      node.style.setProperty('outline-offset', '1px', 'important');
    };
    if (group.length > 1) {
      /* 整组：最小公共祖先容器打强描边，每个成员再加轻描边 */
      let box: HTMLElement | null = null;
      try {
        let node: HTMLElement | null = group[0].parentElement;
        for (let depth = 0; depth < 6 && node && node !== document.body && node !== document.documentElement; depth++) {
          let allInside = true;
          for (const m of group) {
            if (!node.contains(m)) { allInside = false; break; }
          }
          if (allInside) { box = node; break; }
          node = node.parentElement;
        }
      } catch {
        /* 查找失败走兜底 */
      }
      if (!box || box === document.body || box === document.documentElement) box = group[0].parentElement;
      if (box && box !== document.body && box !== document.documentElement) paintStrong(box);
      else paintStrong(main);
      for (const m of group) paintLight(m);
    } else {
      /* 单个控件：本体强描边；radio/checkbox 另给最近 label 包裹行加浅底 */
      paintStrong(main);
      try {
        const input = main as HTMLInputElement;
        const kind = (input.type || '').toLowerCase();
        if (main.tagName === 'INPUT' && (kind === 'checkbox' || kind === 'radio')) {
          const lab = main.closest('label');
          const host = (lab as HTMLElement | null) || main.parentElement;
          if (host && host !== document.body && host !== document.documentElement) paintTint(host as HTMLElement);
        }
      } catch {
        /* 只高亮本体 */
      }
    }
    /* 保持约 1.2s 清晰可见，再用 0.8s 渐隐（总时长约 2s），最后还原 */
    window.setTimeout(() => {
      for (const h of highlighted) {
        h.node.style.setProperty('transition', 'outline-color 0.8s ease, box-shadow 0.8s ease, background-color 0.8s ease');
        h.node.style.setProperty('outline', (h.light ? '2px' : '3px') + ' solid transparent', 'important');
        h.node.style.setProperty('box-shadow', '0 0 0 0 rgba(2,132,199,0)', 'important');
        h.node.style.setProperty('background-color', 'rgba(2,132,199,0)', 'important');
      }
      window.setTimeout(() => {
        for (const h of highlighted) restore(h.node, h.prev);
      }, 800);
    }, 1200);
  } catch {
    /* 高亮失败不影响定位结果 */
  }
  return { ok: true };
}

/** 预展开结果：本次点的开关数 / 跑的轮数 / 是否触发单轮上限（纯登记制下 restored 恒为 0，字段保留以兼容调用方） */
export interface ExpandAllResult {
  clicked: number;
  rounds: number;
  capped: boolean;
  restored: number;
}

/**
 * 全页预展开（纯登记制）：只认 lib/expand-rules.ts。
 * 有规则：只遍历规则 scope，只点规则 toggles 里登记的选择器（可见 + 安全排除），
 *   且只点“藏着控件”的 scope（块内全可见的 scope 不碰，避免把已展开的块点关）；
 * 无规则：直接返回 0，连扫描都不扫——宁可漏过（单点定位会降级直跳），也不点错。
 * 自包含（只用 document / window），可被 evaluate 序列化注入页面；异步（点后等 500ms 复查）。
 */
export async function pageExpandAll(pageUrl?: string): Promise<ExpandAllResult> {
  const empty: ExpandAllResult = { clicked: 0, rounds: 0, capped: false, restored: 0 };
  let rule: ExpandRule | null = null;
  try {
    rule = matchExpandRule(pageUrl || window.location.href);
  } catch {
    rule = null;
  }
  if (!rule || !rule.toggles || !rule.toggles.length) return empty;
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => window.setTimeout(() => resolve(), ms));
  const rectOk = (node: HTMLElement): boolean => {
    try {
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = window.getComputedStyle(node);
      if ((cs.display || '').toLowerCase() === 'none') return false;
      const vis = (cs.visibility || '').toLowerCase();
      if (vis === 'hidden' || vis === 'collapse') return false;
      return true;
    } catch {
      return false;
    }
  };
  /* 离 node 最近的折叠容器：display:none，或限高裁掉。纯可见性判定，不猜开关。 */
  const foldedAncestor = (node: HTMLElement): HTMLElement | null => {
    let p: HTMLElement | null = node;
    for (let d = 0; d < 13 && p; d++, p = p.parentElement) {
      try {
        const cs = window.getComputedStyle(p);
        if ((cs.display || '').toLowerCase() === 'none') return p;
        const ov = ((cs.overflow || '') + ' ' + (cs.overflowY || '')).toLowerCase();
        const clipped =
          ov.indexOf('hidden') >= 0 || ov.indexOf('clip') >= 0 || ov.indexOf('auto') >= 0 || ov.indexOf('scroll') >= 0;
        if (!clipped) continue;
        if (p.scrollHeight - p.clientHeight <= 100) continue;
        const over = (cs.overflow || '').toLowerCase();
        const overY = (cs.overflowY || '').toLowerCase();
        if ((over === 'auto' || over === 'scroll' || overY === 'auto' || overY === 'scroll') && p.clientHeight > 120) continue;
        return p;
      } catch {
        /* 忽略单个祖先 */
      }
    }
    return null;
  };
  const isShown = (node: HTMLElement): boolean => rectOk(node) && !foldedAncestor(node);
  /* 登记选择器安全排除（防规则写错，是安全项不是启发式）：外链 / submit / delete 类一律不点 */
  const ruleSafe = (cand: Element): cand is HTMLElement => {
    if (!(cand instanceof HTMLElement) || !rectOk(cand)) return false;
    const tag = (cand.tagName || '').toUpperCase();
    try {
      const host =
        tag === 'A'
          ? (cand as HTMLAnchorElement)
          : ((cand as HTMLElement).closest('a[href]') as HTMLAnchorElement | null);
      if (host && host.hasAttribute && host.hasAttribute('href')) {
        const href = ((host.getAttribute('href')) || '').trim().toLowerCase();
        if (href !== '#' && href.indexOf('javascript:') !== 0) return false;
      }
    } catch {
      /* 忽略 */
    }
    if (tag === 'BUTTON' || tag === 'INPUT') {
      const bt = (((cand as HTMLButtonElement).type) || '').toLowerCase();
      if (bt === 'submit' || bt === 'image') return false;
      if (!bt && tag === 'BUTTON') {
        try {
          if ((cand as HTMLElement).closest('form')) return false;
        } catch {
          /* 忽略 */
        }
      }
    }
    try {
      if (/delete|shanchu|submit/i.test((((cand as HTMLElement).className) || '').toString())) return false;
      if ((cand as HTMLElement).querySelector('[class*="elete"],[class*="hanchu"]')) return false;
    } catch {
      /* 忽略 */
    }
    if ((cand as HTMLButtonElement).disabled) return false;
    return true;
  };
  /* scope 确定折叠才算折叠，宁可漏展一个块也不点错：
     - aria-expanded 直接判定（false=折叠，true=展开）；
     - 其余要求藏起的控件共享块内折叠容器（折叠体 display:none/被裁，控件在其体内）；
       Angular 条件分支把各控件逐个 display:none（各自藏起、无共享折叠体）时不动手，避免把展开块点关。
     块内有任一可见控件同样不动。 */
  const scopeFolded = (scope: Element): boolean => {
    try {
      const ae = (scope as HTMLElement).getAttribute && (scope as HTMLElement).getAttribute('aria-expanded');
      if (ae === 'false') return true;
      if (ae === 'true') return false;
    } catch {
      /* 继续常规判定 */
    }
    let controls: Element[] = [];
    try {
      controls = Array.from(scope.querySelectorAll('input,select,textarea,[contenteditable]'));
    } catch {
      return false;
    }
    let hidden = 0;
    let visible = 0;
    const foldedHosts = new Set<Element>();
    for (const el of controls) {
      try {
        if (!(el instanceof HTMLElement)) continue;
        if (((el as HTMLInputElement).type || '').toLowerCase() === 'hidden') continue;
        if (isShown(el as HTMLElement)) {
          visible++;
          continue;
        }
        hidden++;
        const f = foldedAncestor(el as HTMLElement);
        if (f && f !== el && f !== scope && scope.contains(f)) foldedHosts.add(f);
      } catch {
        /* 忽略 */
      }
    }
    if (hidden === 0 || visible > 0) return false;
    return foldedHosts.size > 0;
  };
  let clicked = 0;
  let rounds = 0;
  let capped = false;
  for (let round = 0; round < 3; round++) {
    const scopes: Element[] = [];
    try {
      if (rule.scope) {
        for (const s of Array.from(document.querySelectorAll(rule.scope))) scopes.push(s);
      } else {
        scopes.push(document.body);
      }
    } catch {
      /* 忽略 */
    }
    /* 本轮待点开关：只收折叠 scope 内的登记选择器 */
    const pending: HTMLElement[] = [];
    for (const scope of scopes) {
      let folded = false;
      try {
        folded = scopeFolded(scope);
      } catch {
        folded = false;
      }
      if (!folded) continue;
      for (const sel of rule.toggles || []) {
        let list: Element[] = [];
        try {
          list = Array.from(scope.querySelectorAll(sel));
          try {
            if ((scope as HTMLElement).matches && (scope as HTMLElement).matches(sel)) list.unshift(scope);
          } catch {
            /* 忽略 */
          }
        } catch {
          continue;
        }
        for (const c of list) {
          if (ruleSafe(c) && pending.indexOf(c) < 0) pending.push(c);
        }
      }
    }
    if (!pending.length) break;
    rounds++;
    let batch = pending;
    if (batch.length > 20) {
      batch = batch.slice(0, 20);
      capped = true;
    }
    for (const t of batch) {
      try {
        t.click();
      } catch {
        /* 单个点不动不影响其它 */
      }
    }
    clicked += batch.length;
    await sleep(500);
    if (capped) break;
  }
  return { clicked, rounds, capped, restored: 0 };
}

/** 回填完成后读取实际值，用于核对 */
export function pageInspect(ids: string[]): InspectResult[] {
  return ids.map((id) => {
    const members = Array.from(document.querySelectorAll<HTMLElement>(`[data-ai-id="${id}"]`));
    const el = members[0];
    if (!el) return { id, missing: true };
    const box = el.closest('.field,.form-item,tr');
    const bad = box && /(^|\s)(invalid|bad)(\s|$)/.test(box.className || '');
    let value = '';
    /* bootstrap/联动：同 id 下有原生 select 时，值取各 select 现值拼串（button 成员忽略） */
    const selects = members.filter((m) => m.tagName === 'SELECT') as HTMLSelectElement[];
    if (selects.length && members.every((m) => m.tagName === 'SELECT' || m.tagName === 'BUTTON' || m.tagName === 'A'))
      value = selects
        .map((s) => s.value)
        .filter(Boolean)
        .join('/');
    else if (members.length > 1)
      value = members
        .filter((m) => (m as HTMLInputElement).checked)
        .map((m) => (m as HTMLInputElement).value)
        .join(',');
    else if (el.hasAttribute('contenteditable')) value = el.innerText.trim();
    else if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) value = (el as HTMLInputElement).value;
    else value = el.innerText.trim();
    return { id, value, empty: !String(value).trim(), error: !!bad };
  });
}
