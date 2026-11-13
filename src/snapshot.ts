// 快照引擎:页面 DOM → 语义树 + ref 注册表。解决“agent 点不到内容”的地基。
// 设计要点:
//  - 每个 frame 独立走一遍 in-page DOM walker(iframe 内容拍平进同一棵树)
//  - ref 编号单调递增、永不复用;每个 ref 记录 cssPath(主定位)+ role/name(失效重解析兜底)
//  - CSS path 在有 id 的最近祖先处锚定 + nth-of-type,保证在本 frame 内唯一
//  - Playwright 的 css 引擎自动穿透 open shadow DOM,因此 shadow 内元素 = host 路径 + 内部路径
import type { Frame, Page } from "playwright-core";
import { truncate } from "./util.js";

// ============ in-page walker(会在浏览器上下文里执行,必须自包含) ============

export interface WalkOptions {
  maxInteractive: number;
  maxText: number;
  maxDepth: number;
  rootSelector?: string;
}

export interface WNode {
  t: "el" | "iframe";
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  href?: string;
  checked?: boolean;
  placeholder?: string;
  disabled?: boolean;
  selected?: string;
  optionsCount?: number;
  alt?: string;
  src?: string;
  frameName?: string;
  interactive?: boolean;
  scrollable?: boolean;
  landmark?: string; // landmark 名称,如 main/nav/form
  heading?: string; // h1..h6
  textblock?: boolean;
  box?: [number, number, number, number];
  cssPath: string;
  roleOccurrence?: number;
  children?: WNode[];
}

export interface WalkResult {
  roots: WNode[];
  truncated: boolean;
  visited: number;
}

export const WALKER_FN = function walkerInPage(options: WalkOptions): WalkResult {
  const maxInteractive = options.maxInteractive ?? 400;
  const maxText = options.maxText ?? 250;
  const maxDepth = options.maxDepth ?? 40;

  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "select", "textarea", "summary", "label", "option",
    "details", "audio", "video", "embed", "object", "menuitem", "area", "canvas",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox",
    "listbox", "option", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "switch", "treeitem", "gridcell", "cell",
  ]);
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "template", "head", "meta", "link", "title",
    "br", "hr", "source", "track", "datalist", "param", "base", "wbr",
  ]);
  const TEXT_TAGS = new Set(["p", "li", "td", "th", "dd", "dt", "blockquote", "figcaption", "pre", "code", "span", "em", "strong", "small", "div"]);
  const LANDMARK_MAP: Record<string, string> = {
    main: "main", nav: "nav", header: "header", footer: "footer",
    aside: "aside", section: "section", form: "form", article: "article", search: "search",
  };
  const LANDMARK_ROLES = new Set(["main", "navigation", "banner", "contentinfo", "complementary", "region", "form", "search", "article", "dialog"]);

  let interactiveEmitted = 0;
  let textEmitted = 0;
  let visited = 0;
  let truncated = false;
  const roleCounters = new Map<string, number>();

  function collapse(s: string | null | undefined, max: number): string | undefined {
    if (!s) return undefined;
    const t = s.replace(/\s+/g, " ").trim();
    if (!t) return undefined;
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  function ownText(el: Element): string {
    let out = "";
    Array.from(el.childNodes).forEach((n) => {
      if (n.nodeType === 3) out += n.textContent ?? "";
    });
    return out;
  }

  function accName(el: Element, tag: string): string {
    const doc = el.ownerDocument;
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const parts = labelledby
        .split(/\s+/)
        .map((id) => root.getElementById ? (root.getElementById(id)?.textContent ?? "") : "")
        .join(" ");
      const j = collapse(parts, 120);
      if (j) return j;
    }
    if (tag === "img" || tag === "area" || tag === "image") {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return alt;
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") {
        const v = (el as HTMLInputElement).value || el.getAttribute("value");
        if (v) return String(v);
      }
      if (el.id) {
        try {
          const lb = doc.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
          if (lb && lb.textContent) return collapse(lb.textContent, 120) || "";
        } catch { /* ignore */ }
      }
      const wrap = el.closest("label");
      if (wrap && wrap !== el && wrap.textContent) return collapse(wrap.textContent, 120) || "";
      const ph = el.getAttribute("placeholder");
      if (ph) return ph;
      const nm = el.getAttribute("name");
      if (nm) return nm;
      return "";
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return title;
    if (tag === "button" || tag === "a" || tag === "summary" || tag === "label" || tag === "select" || tag === "textarea") {
      const t = collapse(el.textContent, 120);
      if (t) return t;
    }
    return "";
  }

  function cssEscape(s: string): string {
    try {
      return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1");
    } catch {
      return s;
    }
  }

  /** container = Document 或 ShadowRoot;返回容器内的唯一 css 路径(失败返回 null) */
  function cssPathWithin(container: Document | ShadowRoot, el: Element): string | null {
    const segs: string[] = [];
    let node: Node | null = el;
    while (node && node !== (container as Node)) {
      if (node.nodeType !== 1) {
        node = node.parentNode;
        continue;
      }
      const elCur = node as Element;
      if (elCur.id) {
        segs.unshift("#" + cssEscape(elCur.id));
        return segs.join(" ");
      }
      let seg = elCur.localName;
      const parent: Element | null = elCur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === elCur.localName);
        if (same.length > 1) {
          seg += ":nth-of-type(" + (same.indexOf(elCur) + 1) + ")";
        }
      }
      segs.unshift(seg);
      node = elCur.parentNode;
    }
    if (node !== (container as Node)) return null; // 不在容器内(detached)
    return segs.join(" ") || "*";
  }

  function roleFor(el: Element, tag: string): string | undefined {
    const roleAttr = el.getAttribute("role");
    if (roleAttr) return roleAttr;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "option") return "option";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "section") return "region";
    if (tag === "article") return "article";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      return "textbox";
    }
    return undefined;
  }

  function isInteractive(el: Element, tag: string, role: string | undefined, st: CSSStyleDeclaration): boolean {
    const roleAttr = el.getAttribute("role");
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === "a") return !!(el.getAttribute("href") || roleAttr);
      return true;
    }
    if (roleAttr && INTERACTIVE_ROLES.has(roleAttr)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.getAttribute("onclick") || el.getAttribute("ondblclick") || el.getAttribute("onmousedown")) return true;
    if (st.cursor === "pointer") {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 200) return true;
    }
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    return false;
  }

  function makeNode(el: Element, container: Document | ShadowRoot, prefix: string, st: CSSStyleDeclaration): WNode | null {
    const tag = el.localName;
    const cssRel = cssPathWithin(container, el);
    if (!cssRel) return null;
    const role = roleFor(el, tag);
    const name = collapse(accName(el, tag), 120);
    const rect = el.getBoundingClientRect();
    const node: WNode = { t: "el", tag, cssPath: prefix ? prefix + " " + cssRel : cssRel };
    if (role) node.role = role;
    if (name) node.name = name;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 0 || h > 0) node.box = [Math.round(rect.left), Math.round(rect.top), w, h];

    // 状态
    if (tag === "input" || tag === "textarea") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const input = el as HTMLInputElement;
      if (type === "checkbox" || type === "radio") node.checked = input.checked;
      else if (type !== "password" && input.value) node.value = collapse(input.value, 80);
      if (type === "password") node.value = "•••";
    }
    if (tag === "textarea" && (el as HTMLTextAreaElement).value) node.value = collapse((el as HTMLTextAreaElement).value, 80);
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opt = sel.selectedOptions;
      if (opt && opt.length) node.selected = collapse(Array.from(opt).map((o) => o.label || o.value).join(", "), 60);
      node.optionsCount = sel.options ? sel.options.length : undefined;
    }
    if (tag === "a") {
      const href = (el as HTMLAnchorElement).href;
      if (href) node.href = href.length > 120 ? href.slice(0, 120) + "…" : href;
    }
    const ph = el.getAttribute("placeholder");
    if (ph) node.placeholder = collapse(ph, 80);
    if (el.getAttribute("aria-disabled") === "true") node.disabled = true;
    if (tag === "input" || tag === "button" || tag === "select" || tag === "textarea" || tag === "option") {
      if ((el as HTMLButtonElement).disabled) node.disabled = true;
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt) node.alt = collapse(alt, 80);
    }
    // 可滚动容器
    if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 8) node.scrollable = true;
    else if ((st.overflowX === "auto" || st.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 8) node.scrollable = true;

    if (tag === "img" || tag === "svg" || tag === "canvas") {
      node.role = node.role ?? "img";
    }

    const interactive = isInteractive(el, tag, node.role ?? undefined, st);
    const heading = /^h[1-6]$/.test(tag) ? tag : undefined;
    const landmark = LANDMARK_MAP[tag] ?? (el.getAttribute("role") && LANDMARK_ROLES.has(el.getAttribute("role")!) ? el.getAttribute("role") : undefined);
    const own = ownText(el);
    const textblock = !interactive && !heading && !landmark && collapse(own, 200) !== undefined && TEXT_TAGS.has(tag) && el.children.length === 0;

    if (interactive) {
      if (interactiveEmitted >= maxInteractive) {
        truncated = true;
        return null;
      }
      interactiveEmitted++;
      node.interactive = true;
      const key = (node.role ?? tag) + "\u0000" + (name ?? "");
      const occ = roleCounters.get(key) ?? 0;
      node.roleOccurrence = occ;
      roleCounters.set(key, occ + 1);
    } else if (heading) {
      node.heading = heading;
      node.text = collapse(el.textContent, 200);
    } else if (landmark) {
      node.landmark = landmark;
      if (name) node.name = name;
    } else if (textblock) {
      if (textEmitted >= maxText) {
        return null;
      }
      textEmitted++;
      node.textblock = true;
      node.text = collapse(own, 200);
    } else if (node.scrollable) {
      node.interactive = true; // 可滚动容器也需要 ref(供 browser_scroll 用)
      node.role = node.role ?? "scrollable";
      interactiveEmitted++;
    } else {
      return null; // 无语义的普通容器:不发射,但继续走子树
    }
    return node;
  }

  function walk(el: Element, container: Document | ShadowRoot, prefix: string, depth: number, parentChildren: WNode[]): void {
    if (visited >= 20000 || depth > maxDepth) {
      truncated = true;
      return;
    }
    visited++;
    const tag = el.localName;
    if (!tag || SKIP_TAGS.has(tag)) return;
    if (el.getAttribute("aria-hidden") === "true") return;

    let st: CSSStyleDeclaration;
    try {
      st = getComputedStyle(el);
    } catch {
      return;
    }
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return;

    // iframe:发射占位节点,不下钻(由 Node 侧按 URL 拼接)
    if (tag === "iframe" || tag === "frame") {
      const src = (el as HTMLIFrameElement).src || el.getAttribute("src") || "";
      const node: WNode = {
        t: "iframe",
        tag,
        cssPath: prefix ? prefix + " " + cssPathWithin(container, el) : cssPathWithin(container, el) || "",
        src: src || "about:blank",
        frameName: el.getAttribute("name") ?? undefined,
      };
      try {
        const a = new URL(src, location.href);
        node.src = a.href;
      } catch { /* keep raw */ }
      parentChildren.push(node);
      return;
    }
    if (tag === "svg") {
      // svg 当整体,不下钻内部
      const node = makeNode(el, container, prefix, st);
      if (node) parentChildren.push(node);
      return;
    }

    // shadow host:透明处理(不发射 host 本身),改走 shadow 内部
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
      const hostRel = cssPathWithin(container, el);
      if (hostRel) {
        const hostPrefix = prefix ? prefix + " " + hostRel : hostRel;
        Array.from(shadow.childNodes).forEach((n) => {
          if (n.nodeType === 1) walk(n as Element, shadow, hostPrefix, depth + 1, parentChildren);
        });
      }
      return;
    }

    const node = makeNode(el, container, prefix, st);
    if (node) {
      parentChildren.push(node);
      // 继续下钻(在已发射节点内找更多语义节点)
      if (tag !== "select" && tag !== "option" && tag !== "textarea" && tag !== "input") {
        Array.from(el.children).forEach((c) => walk(c, container, prefix, depth + 1, (node.children ??= [])));
      }
      return;
    }

    // 未发射:继续走子树(挂在同一层)
    if (tag !== "select" && tag !== "option" && tag !== "textarea") {
      Array.from(el.children).forEach((c) => walk(c, container, prefix, depth + 1, parentChildren));
    }
  }

  let rootContainer: Document | ShadowRoot | null = null;
  let rootEl: Element | null = null;
  if (options.rootSelector) {
    try {
      rootEl = document.querySelector(options.rootSelector);
    } catch { /* 无效选择器 */ }
    if (!rootEl) return { roots: [], truncated: false, visited: 0 };
  }

  const roots: WNode[] = [];
  const startEls: Array<Element> = [];
  if (rootEl) {
    rootContainer = document;
    startEls.push(rootEl);
    // 根元素本身可能是语义节点
  } else {
    rootContainer = document;
    const body = document.body ?? document.documentElement;
    if (!body) return { roots: [], truncated: false, visited: 0 };
    startEls.push(body);
  }

  for (const start of startEls) {
    const st = getComputedStyle(start);
    const node = rootEl ? makeNode(start, rootContainer, "", st) : null;
    if (node) {
      roots.push(node);
      Array.from(start.children).forEach((c) => walk(c, rootContainer!, "", 1, (node.children ??= [])));
    } else {
      // 根为透明容器:走子树
      if (start instanceof HTMLElement && start.shadowRoot) {
        const shadow = start.shadowRoot;
        const hostRel = cssPathWithin(document, start);
        const prefix2 = hostRel ?? "";
        Array.from(shadow.childNodes).forEach((n) => {
          if (n.nodeType === 1) walk(n as Element, shadow, prefix2, 1, roots);
        });
      } else {
        Array.from(start.children).forEach((c) => walk(c, rootContainer!, "", 1, roots));
      }
    }
  }

  return { roots, truncated, visited };
};

// ============ Node 侧:ref 注册表、frame 拼接、渲染 ============

export interface FrameDesc {
  url: string;
  name: string;
}

export interface RefEntry {
  ref: string;
  pageId: string;
  pageUrl: string;
  framePath: FrameDesc[]; // 从主 frame 到元素所在 frame 的链条
  cssPath: string;
  tag: string;
  role: string | null;
  name: string;
  occurrence: number;
  box?: [number, number, number, number];
}

export class RefRegistry {
  private byRef = new Map<string, RefEntry>();
  private counter = 0;
  private readonly maxEntries = 8000;

  assign(entry: Omit<RefEntry, "ref">): string {
    this.counter++;
    const ref = "e" + this.counter;
    this.byRef.set(ref, { ...entry, ref });
    while (this.byRef.size > this.maxEntries) {
      const first = this.byRef.keys().next();
      if (first.done) break;
      this.byRef.delete(first.value);
    }
    return ref;
  }

  get(ref: string): RefEntry | undefined {
    return this.byRef.get(ref.trim());
  }

  /** 页面导航后该页旧 ref 作废 */
  clearPage(pageId: string): void {
    for (const [k, v] of this.byRef) {
      if (v.pageId === pageId) this.byRef.delete(k);
    }
  }

  get size(): number {
    return this.byRef.size;
  }
}

type SNode = WNode & { framePath?: FrameDesc[] };

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return u;
  }
}

/** 把子 frame 的树拼进 iframe 占位节点;返回未能匹配的 frame */
function stitchInto(roots: SNode[], parentFrame: Frame, frameTrees: Map<Frame, SNode[]>, usedFrames: Set<Frame>): Frame[] {
  // DFS 按文档序找 iframe 占位
  const placeholders: SNode[] = [];
  const dfs = (nodes: SNode[]) => {
    for (const n of nodes) {
      if (n.t === "iframe") placeholders.push(n);
      if (n.children) dfs(n.children as SNode[]);
    }
  };
  dfs(roots);

  const children = parentFrame.childFrames();
  const unmatched: Frame[] = [];

  for (const ph of placeholders) {
    let matched: Frame | undefined;
    // 1. URL 精确匹配(忽略 hash)
    matched = children.find((f) => !usedFrames.has(f) && normalizeUrl(f.url()) === normalizeUrl(ph.src ?? ""));
    // 2. name 匹配
    if (!matched && ph.frameName) {
      matched = children.find((f) => !usedFrames.has(f) && f.name() === ph.frameName);
    }
    // 3. about:blank 顺序匹配
    if (!matched && (ph.src === "about:blank" || !ph.src)) {
      matched = children.find((f) => !usedFrames.has(f) && f.url() === "about:blank");
    }
    if (matched) {
      usedFrames.add(matched);
      const sub = (frameTrees.get(matched) ?? []) as SNode[];
      // 子 frame 根节点的 framePath = 父路径 + 子 frame 描述符
      const childPath = [...(ph.framePath ?? []), { url: matched.url(), name: matched.name() }];
      ph.framePath = childPath;
      for (const n of sub) n.framePath = childPath;
      ph.children = sub.length > 0 ? sub : [{ t: "el", tag: "em", text: "(iframe 内容为空或不可访问)", cssPath: "" }];
      // 递归拼更深一层
      const deeper = stitchInto(ph.children as SNode[], matched, frameTrees, usedFrames);
      unmatched.push(...deeper);
    } else {
      void ph;
    }
  }

  // 没匹配上任何占位的 frame,追加到末尾(不丢信息)
  for (const f of children) {
    if (usedFrames.has(f)) continue;
    const sub = (frameTrees.get(f) ?? []) as SNode[];
    const ph: SNode = {
      t: "iframe",
      tag: "iframe",
      cssPath: "",
      src: f.url() || "about:blank",
      frameName: f.name() || undefined,
      children: sub.length > 0 ? sub : [{ t: "el", tag: "em", text: "(iframe 内容为空)", cssPath: "" }],
    };
    const childPath = [...(roots[0]?.framePath ?? []), { url: f.url(), name: f.name() }];
    for (const n of sub) n.framePath = childPath;
    ph.framePath = childPath;
    roots.push(ph);
    unmatched.push(...stitchInto(ph.children as SNode[], f, frameTrees, usedFrames));
    usedFrames.add(f);
  }
  return unmatched;
}

function framePathOf(frame: Frame): FrameDesc[] {
  const chain: FrameDesc[] = [];
  let cur: Frame | null = frame;
  while (cur && cur.parentFrame()) {
    chain.unshift({ url: cur.url(), name: cur.name() });
    cur = cur.parentFrame();
  }
  return chain;
}

async function walkFrame(frame: Frame, opts: WalkOptions): Promise<SNode[]> {
  try {
    const result = (await frame.evaluate(WALKER_FN, opts)) as WalkResult;
    return result.roots as SNode[];
  } catch {
    // frame 可能已销毁/跨域被销毁重建
    return [];
  }
}

export interface SnapshotOptions {
  filter?: "balanced" | "interactive" | "text";
  maxElements?: number;
  maxChars?: number;
  rootRef?: string;
  rootSelector?: string;
  title?: string;
}

export interface SnapshotOutput {
  text: string;
  refCount: number;
  truncated: boolean;
}

/** 对整页(含 iframe)做快照,登记 ref,返回渲染后的文本 */
export async function snapshotPage(
  page: Page,
  pageId: string,
  registry: RefRegistry,
  opts: SnapshotOptions = {},
): Promise<SnapshotOutput> {
  const filter = opts.filter ?? "balanced";
  const maxElements = opts.maxElements ?? 400;
  const maxChars = opts.maxChars ?? 30000;

  let rootSelector = opts.rootSelector;
  let targetFrame: Frame = page.mainFrame();
  if (opts.rootRef) {
    const entry = registry.get(opts.rootRef);
    if (!entry) {
      return { text: `ref ${opts.rootRef} 不存在或已过期,请重新 browser_snapshot。`, refCount: 0, truncated: false };
    }
    if (entry.framePath.length > 0) {
      const found = findFrameByPath(page, entry.framePath);
      if (!found) return { text: `ref ${opts.rootRef} 所在的 frame 已不存在,请重新 browser_snapshot。`, refCount: 0, truncated: false };
      targetFrame = found;
    }
    rootSelector = entry.cssPath;
  }

  const walkOpts: WalkOptions = {
    maxInteractive: 400,
    maxText: 250,
    maxDepth: 40,
    rootSelector,
  };

  // 并行走所有 frame
  const frames = page.frames();
  const results = await Promise.all(frames.map((f) => walkFrame(f, walkOpts)));
  const frameTrees = new Map<Frame, SNode[]>();
  frames.forEach((f, i) => frameTrees.set(f, results[i]));

  // 主 frame 根部继承空 framePath
  const mainRoots = (frameTrees.get(page.mainFrame()) ?? []) as SNode[];
  for (const n of mainRoots) n.framePath = [];
  frameTrees.set(page.mainFrame(), mainRoots);

  // 拼接子 frame
  const used = new Set<Frame>([page.mainFrame()]);
  stitchInto(mainRoots, page.mainFrame(), frameTrees, used);

  // DFS:登记 ref + 渲染
  const lines: string[] = [];
  let refCount = 0;
  let hitCap = false;

  const renderExtras = (n: WNode): string => {
    const parts: string[] = [];
    if (n.value !== undefined) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.placeholder) parts.push(`placeholder=${JSON.stringify(n.placeholder)}`);
    if (n.checked !== undefined) parts.push(n.checked ? "(已勾选)" : "(未勾选)");
    if (n.selected) parts.push(`selected=${JSON.stringify(n.selected)}`);
    if (n.optionsCount !== undefined) parts.push(`(${n.optionsCount}个选项)`);
    if (n.disabled) parts.push("(禁用)");
    if (n.scrollable) parts.push("[可滚动]");
    if (n.href) {
      let short = n.href;
      try {
        const u = new URL(n.href);
        short = u.host + u.pathname + (u.search ? u.search.slice(0, 40) : "");
      } catch { /* keep */ }
      parts.push(`→ ${short}`);
    }
    return parts.length ? " " + parts.join(" ") : "";
  };

  const assignRef = (n: SNode): string => {
    const framePath = n.framePath ?? [];
    return registry.assign({
      pageId,
      pageUrl: page.url(),
      framePath,
      cssPath: n.cssPath,
      tag: n.tag,
      role: n.role ?? null,
      name: n.name ?? "",
      occurrence: n.roleOccurrence ?? 0,
      box: n.box,
    });
  };

  const emit = (n: SNode, depth: number): void => {
    if (hitCap || lines.length >= maxElements) {
      hitCap = true;
      return;
    }
    const indent = "  ".repeat(depth);
    const isInteractive = n.interactive === true;

    if (filter !== "interactive" || isInteractive || n.t === "iframe") {
      if (n.t === "iframe") {
        lines.push(`${indent}- iframe → ${n.src ?? ""}${n.frameName ? ` (name=${n.frameName})` : ""}`);
      } else if (isInteractive) {
        const role = n.role ?? n.tag;
        const name = n.name ? ` "${n.name}"` : n.text ? ` "${truncate(n.text, 40, "…")}"` : "";
        const ref = assignRef(n);
        lines.push(`${indent}- [${ref}] ${role}${name}${renderExtras(n)}`);
        refCount++;
      } else if (n.heading) {
        lines.push(`${indent}- ${n.heading}: ${n.text ?? n.name ?? ""}`);
      } else if (n.landmark) {
        lines.push(`${indent}- [${n.landmark}${n.name ? ` ${JSON.stringify(n.name)}` : ""}]`);
      } else if (n.textblock && filter !== "interactive") {
        lines.push(`${indent}- text: ${n.text ?? ""}`);
      }
    }

    if (n.children) {
      for (const c of n.children as SNode[]) emit(c, depth + 1);
    }
  };

  for (const n of mainRoots) emit(n, 0);

  const title = opts.title ?? "";
  const header = `# 快照: ${title || "(无标题)"} — ${page.url()}`;
  const body = lines.join("\n").slice(0, maxChars);
  const footers: string[] = ["(带 [eN] 的行可交互/可滚动,ref 可直接用于 browser_click/type 等工具)"];
  if (hitCap) {
    footers.push(`⚠️ 已截断(超 ${maxElements} 行)—— 用 rootRef/selector 只看相关区域,或 filter:"interactive" 只看交互元素`);
  }
  return { text: `${header}\n${body}\n${footers.join(";")}。`, refCount, truncated: hitCap };
}

export function findFrameByPath(page: Page, path: FrameDesc[]): Frame | null {
  let cur: Frame = page.mainFrame();
  for (const desc of path) {
    const children = cur.childFrames();
    let next: Frame | undefined;
    next = children.find((f) => normalizeUrl(f.url()) === normalizeUrl(desc.url));
    if (!next && desc.name) next = children.find((f) => f.name() === desc.name);
    if (!next && (!desc.url || desc.url === "about:blank")) {
      next = children.find((f) => f.url() === "about:blank");
    }
    if (!next) return null;
    cur = next;
  }
  return cur;
}
