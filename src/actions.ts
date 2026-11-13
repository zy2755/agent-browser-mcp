// 动作层:ref → locator 的解析与多级兜底 + 所有页面操作实现
// 兜底链:cssPath(主,精确)→ getByRole+name(语义,DOM 变化后仍可用)→ 报告最新快照(绝不死路)
import type { Frame, Locator, Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserManager } from "./browserManager.js";
import type { RefEntry, RefRegistry } from "./snapshot.js";
import { findFrameByPath } from "./snapshot.js";
import { ToolError } from "./errors.js";
import { withTimeout, truncate } from "./util.js";

export interface ResolvedTarget {
  locator: Locator;
  frame: Frame;
  entry?: RefEntry;
  notes: string[];
}

function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = "";
    ub.hash = "";
    return ua.href === ub.href;
  } catch {
    return a === b;
  }
}

/**
 * 解析目标元素。
 * - ref:按注册表配方解析;cssPath 找不到时降级 getByRole;页面 URL 已变时仍尽力解析(带警告)
 * - selector / text:直接构造
 */
export async function resolveTarget(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { ref?: string; selector?: string; text?: string },
  opts: { textAsLocator?: boolean } = {},
): Promise<ResolvedTarget> {
  const notes: string[] = [];
  const textAsLocator = opts.textAsLocator !== false;
  const hasRef = nonEmpty(params.ref);
  const hasSelector = nonEmpty(params.selector);
  // click 等工具的 text 可作为定位方式;type 的 text 是输入内容,不参与定位
  const hasText = textAsLocator && nonEmpty(params.text);
  if (!hasRef && !hasSelector && !hasText) {
    throw new ToolError(
      "missing_target",
      "需要提供 ref / selector" + (textAsLocator ? " / text 之一" : " 之一"),
      textAsLocator
        ? "先调用 browser_snapshot 获取元素的 [eN] 编号,再用 ref 操作"
        : "text 参数是要输入的内容;请用 ref 或 selector 指定输入目标",
    );
  }
  if (Number(hasRef) + Number(hasSelector) + Number(hasText) > 1) {
    notes.push("同时提供了多种定位方式,按 ref > selector > text 优先级取其一。");
  }

  // ---------- ref 路径 ----------
  if (params.ref) {
    const entry = registry.get(params.ref);
    if (!entry) {
      throw new ToolError(
        "unknown_ref",
        `ref ${params.ref} 不存在(可能来自更早的会话或已超出注册表容量)`,
        "请先 browser_snapshot 获取当前页面的最新 ref 列表",
      );
    }
    const targetPage = manager.pageById(entry.pageId);
    if (!targetPage || targetPage.isClosed()) {
      throw new ToolError(
        "stale_ref",
        `ref ${params.ref} 所属的标签页已关闭`,
        "用 browser_tabs list 查看现存标签,或重新 browser_snapshot",
      );
    }
    if (!sameUrl(entry.pageUrl, targetPage.url())) {
      notes.push(`⚠️ ref ${params.ref} 摄取自旧页面(${truncate(entry.pageUrl, 60)}),当前页面已变为 ${truncate(targetPage.url(), 60)} —— 优先按语义重解析,若结果不符预期请重新快照。`);
    }

    let frame: Frame = targetPage.mainFrame();
    if (entry.framePath.length > 0) {
      const f = findFrameByPath(targetPage, entry.framePath);
      if (f) {
        frame = f;
      } else {
        notes.push("元素所在 iframe 已不存在,尝试在主文档解析。");
      }
    }

    // 主定位:cssPath(Playwright css 引擎自动穿透 open shadow DOM)
    try {
      const byCss = frame.locator(entry.cssPath);
      const n = await withTimeout(byCss.count(), 5000, "cssPath 计数");
      if (n === 1) {
        return { locator: byCss.first(), frame, entry, notes };
      }
      if (n > 1) {
        notes.push(`cssPath 命中 ${n} 个元素,取第 1 个。`);
        return { locator: byCss.first(), frame, entry, notes };
      }
    } catch {
      notes.push("cssPath 解析失败(结构已变),改用语义定位。");
    }

    // 兜底 1:getByRole + name(精确)
    if (entry.role && entry.name) {
      try {
        const byRole = frame.getByRole(entry.role as never, { name: entry.name, exact: true });
        const n = await withTimeout(byRole.count(), 5000, "role 计数");
        if (n >= 1) {
          if (n > 1) {
            notes.push(`语义定位命中 ${n} 个同名元素,取第 ${entry.occurrence + 1} 个。`);
            return { locator: byRole.nth(Math.min(entry.occurrence, n - 1)), frame, entry, notes };
          }
          notes.push("ref 已按语义(role+name)自动重解析 —— 结构变了但元素还在。");
          return { locator: byRole.first(), frame, entry, notes };
        }
      } catch { /* 继续下一个兜底 */ }
    }

    // 兜底 2:getByRole + name(包含匹配)
    if (entry.role && entry.name) {
      try {
        const byRole = frame.getByRole(entry.role as never, { name: entry.name });
        const n = await withTimeout(byRole.count(), 5000, "role 模糊计数");
        if (n >= 1) {
          notes.push("ref 已按语义(模糊匹配)自动重解析。");
          return { locator: byRole.nth(Math.min(entry.occurrence, n - 1)), frame, entry, notes };
        }
      } catch { /* 忽略 */ }
    }

    // 兜底 3:文本
    if (entry.name) {
      const byText = frame.getByText(entry.name, { exact: false });
      const n = await withTimeout(byText.count(), 5000, "text 计数").catch(() => 0);
      if (n >= 1) {
        notes.push("ref 已按文本自动重解析。");
        return { locator: byText.first(), frame, entry, notes };
      }
    }

    throw new ToolError(
      "stale_ref",
      `ref ${params.ref} 的元素在页面上已找不到(结构已变化且语义重解析失败)`,
      "请重新 browser_snapshot 获取最新 ref;如该区域内容是动态渲染的,可先 browser_wait 等待内容出现",
    );
  }

  // ---------- selector / text 路径 ----------
  if (hasSelector) {
    let frame: Frame = page.mainFrame();
    const loc = frame.locator(params.selector!);
    const n = await withTimeout(loc.count(), 5000, "selector 计数").catch(() => -1);
    if (n === 0) {
      throw new ToolError("not_found", `selector 未命中任何元素: ${params.selector}`, "用 browser_snapshot 查看页面结构后再定位");
    }
    if (n > 1) notes.push(`selector 命中 ${n} 个元素,取第 1 个(可用更精确的 selector 或 :nth-child 控制)。`);
    return { locator: loc.first(), frame, notes };
  }

  // text 定位(仅 click 等把 text 当定位方式的工具会走到这里)
  {
    let frame: Frame = page.mainFrame();
    const loc = frame.getByText(params.text!, { exact: false });
    const n = await withTimeout(loc.count(), 5000, "text 计数").catch(() => -1);
    if (n === 0) {
      throw new ToolError("not_found", `未找到包含文本的元素: ${params.text}`, "文本匹配区分大小写且要求连续;用 browser_snapshot 查看元素实际文本");
    }
    if (n > 1) notes.push(`文本命中 ${n} 个元素,取第 1 个。`);
    return { locator: loc.first(), frame, notes };
  }
}

function nonEmpty(v: string | undefined): boolean {
  return v !== undefined && v !== null && v !== "";
}

// ---------------- 各类动作 ----------------

export interface ActionResultNotes {
  notes: string[];
  urlChanged: boolean;
  newUrl?: string;
  popups: Array<{ url: string }>;
  dialogs: Array<{ type: string; message: string }>;
  downloads: Array<{ path: string; error?: string }>;
}

/** 动作执行后的环境变化采集(跳转/弹窗/对话框/下载) */
export async function collectAfter(
  manager: BrowserManager,
  page: Page,
  tsBefore: number,
  urlBefore: string,
): Promise<ActionResultNotes> {
  const notes: ActionResultNotes = {
    notes: [],
    urlChanged: false,
    popups: [],
    dialogs: [],
    downloads: [],
  };
  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    notes.urlChanged = true;
    notes.newUrl = urlAfter;
    // 等新页面基本就绪
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  }
  notes.popups = manager.popupsSince(tsBefore);
  notes.dialogs = manager.dialogsSince(tsBefore).map((d) => ({ type: d.type, message: d.message }));
  notes.downloads = manager.downloadsSince(tsBefore).map((d) => ({ path: d.path, error: d.error }));
  return notes;
}

export function formatAfter(notes: ActionResultNotes): string {
  const lines: string[] = [];
  if (notes.urlChanged) lines.push(`↗️ 页面跳转 → ${notes.newUrl}`);
  for (const p of notes.popups) lines.push(`🪟 新标签页打开 → ${p.url}`);
  for (const d of notes.dialogs) lines.push(`💬 页面对话框(${d.type},已按策略处理):${d.message}`);
  for (const d of notes.downloads) {
    lines.push(d.error ? `⬇️ 下载失败: ${d.error}` : `⬇️ 已下载 → ${d.path}`);
  }
  return lines.join("\n");
}

export async function doClick(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: {
    ref?: string;
    selector?: string;
    text?: string;
    button?: "left" | "right" | "middle";
    doubleClick?: boolean;
    timeoutMs?: number;
  },
): Promise<{ target: ResolvedTarget; after: ActionResultNotes }> {
  const target = await resolveTarget(manager, page, registry, params);
  const tsBefore = Date.now();
  const urlBefore = page.url();
  const timeout = params.timeoutMs ?? manager.cfg.actionTimeoutMs;
  try {
    await withTimeout(
      target.locator.click({
        button: params.button ?? "left",
        clickCount: params.doubleClick ? 2 : 1,
        timeout,
      }),
      timeout + 8000,
      "click",
    );
  } catch (e) {
    // 二次尝试:重解析一次(元素可能在等待期间被重渲染)
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout/i.test(msg) && target.entry) {
      const retry = await resolveTarget(manager, page, registry, { ref: params.ref }).catch(() => null);
      if (retry) {
        target.notes.push("首次点击超时,已重解析 ref 并重试一次。");
        await withTimeout(retry.locator.click({ timeout: Math.min(timeout, 8000) }), timeout + 5000, "click retry");
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
  await page.waitForTimeout(150);
  const after = await collectAfter(manager, page, tsBefore, urlBefore);
  return { target, after };
}

export async function doType(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { ref?: string; selector?: string; text: string; submit?: boolean; clear?: boolean; timeoutMs?: number },
): Promise<{ target: ResolvedTarget; after: ActionResultNotes }> {
  // text 是要输入的内容而非定位方式
  const target = await resolveTarget(manager, page, registry, params, { textAsLocator: false });
  const tsBefore = Date.now();
  const urlBefore = page.url();
  const timeout = params.timeoutMs ?? manager.cfg.actionTimeoutMs;
  if (params.clear === false) {
    await withTimeout(target.locator.focus(), timeout, "focus");
    await page.keyboard.insertText(params.text);
  } else {
    await withTimeout(target.locator.fill(params.text, { timeout }), timeout + 8000, "fill");
  }
  if (params.submit) {
    await withTimeout(target.locator.press("Enter", { timeout }), timeout, "Enter");
  }
  await page.waitForTimeout(150);
  const after = await collectAfter(manager, page, tsBefore, urlBefore);
  return { target, after };
}

export async function doPressKey(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { key: string; ref?: string; timeoutMs?: number },
): Promise<{ after: ActionResultNotes }> {
  const tsBefore = Date.now();
  const urlBefore = page.url();
  const timeout = params.timeoutMs ?? manager.cfg.actionTimeoutMs;
  if (params.ref) {
    const target = await resolveTarget(manager, page, registry, { ref: params.ref });
    await withTimeout(target.locator.press(params.key, { timeout }), timeout + 5000, "press");
  } else {
    await page.keyboard.press(params.key);
  }
  await page.waitForTimeout(120);
  const after = await collectAfter(manager, page, tsBefore, urlBefore);
  return { after };
}

export async function doSelectOption(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { ref?: string; selector?: string; values: string[]; timeoutMs?: number },
): Promise<{ target: ResolvedTarget; selected: string[]; after: ActionResultNotes }> {
  const target = await resolveTarget(manager, page, registry, params);
  const tsBefore = Date.now();
  const urlBefore = page.url();
  const timeout = params.timeoutMs ?? manager.cfg.actionTimeoutMs;
  let selected: string[] = [];
  try {
    selected = (await withTimeout(
      target.locator.selectOption(params.values, { timeout }),
      timeout + 5000,
      "selectOption",
    )) as string[];
  } catch {
    // 按 label 再试一轮
    selected = (await withTimeout(
      target.locator.selectOption(params.values.map((v) => ({ label: v })), { timeout }),
      timeout + 5000,
      "selectOption by label",
    )) as string[];
  }
  const after = await collectAfter(manager, page, tsBefore, urlBefore);
  return { target, selected, after };
}

export async function doHover(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { ref?: string; selector?: string; timeoutMs?: number },
): Promise<{ target: ResolvedTarget; after: ActionResultNotes }> {
  const target = await resolveTarget(manager, page, registry, params);
  const timeout = params.timeoutMs ?? manager.cfg.actionTimeoutMs;
  await withTimeout(target.locator.hover({ timeout }), timeout + 5000, "hover");
  const after = await collectAfter(manager, page, Date.now(), page.url());
  return { target, after };
}

export async function doScroll(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { direction: "up" | "down" | "left" | "right"; amount?: number; ref?: string },
): Promise<{ scrolled: boolean; after: ActionResultNotes }> {
  const amount = params.amount ?? 600;
  const tsBefore = Date.now();
  const urlBefore = page.url();
  const dx = params.direction === "left" ? -amount : params.direction === "right" ? amount : 0;
  const dy = params.direction === "up" ? -amount : params.direction === "down" ? amount : 0;
  if (params.ref) {
    const target = await resolveTarget(manager, page, registry, { ref: params.ref });
    await target.locator.evaluate((el, arg) => {
      el.scrollBy({ left: arg.dx, top: arg.dy, behavior: "instant" as ScrollBehavior });
    }, { dx, dy });
  } else {
    await page.mouse.wheel(dx, dy);
  }
  await page.waitForTimeout(200);
  const after = await collectAfter(manager, page, tsBefore, urlBefore);
  return { scrolled: true, after };
}

export async function doScreenshot(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { fullPage?: boolean; ref?: string; filename?: string },
): Promise<{ base64: string; file: string; mimeType: "image/png" | "image/jpeg" }> {
  const dir = path.join(manager.cfg.downloadDir, "screenshots");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = (params.filename ? params.filename.replace(/[^\w\u4e00-\u9fa5.-]/g, "_") : `shot-${ts}`) + ".png";
  const file = path.join(dir, name);
  let buf: Buffer;
  if (params.ref) {
    const target = await resolveTarget(manager, page, registry, { ref: params.ref });
    buf = await withTimeout(target.locator.screenshot({ timeout: manager.cfg.actionTimeoutMs }), manager.cfg.actionTimeoutMs + 8000, "元素截图");
  } else {
    buf = await withTimeout(
      page.screenshot({ fullPage: params.fullPage === true, timeout: manager.cfg.actionTimeoutMs }),
      manager.cfg.actionTimeoutMs + 15000,
      "页面截图",
    );
  }
  await writeFile(file, buf);
  return { base64: buf.toString("base64"), file, mimeType: "image/png" };
}

/** 把用户传入的 js 字符串转为可执行的函数对象。
 * Playwright 对字符串按表达式求值:`() => document.title` 会得到函数本身(序列化为 undefined)而非调用结果,
 * 因此凡是函数形态的字符串一律先在 Node 侧转成真正的函数再传给 evaluate。 */
function toPageFunction(js: string): unknown {
  const trimmed = js.trim();
  const looksLikeFunction =
    /^\(.*\)\s*=>/.test(trimmed) ||
    /^[A-Za-z_$][\w$]*\s*=>/.test(trimmed) ||
    /^(async\s+)?function\b/.test(trimmed) ||
    /^async\s*\(/.test(trimmed);
  if (!looksLikeFunction) return js; // 普通表达式,原样交给 Playwright
  try {
    return new Function(`return (${trimmed})`)();
  } catch {
    return js; // 解析失败按表达式处理,错误信息由页面侧给出
  }
}

export async function doEvaluate(
  manager: BrowserManager,
  page: Page,
  registry: RefRegistry,
  params: { js: string; ref?: string },
): Promise<{ result: unknown }> {
  const fn = toPageFunction(params.js);
  if (params.ref) {
    const target = await resolveTarget(manager, page, registry, { ref: params.ref });
    const result = await withTimeout(
      target.locator.evaluate(fn as never),
      manager.cfg.actionTimeoutMs + 8000,
      "evaluate(ref)",
    );
    return { result };
  }
  const result = await withTimeout(page.evaluate(fn as never), manager.cfg.actionTimeoutMs + 8000, "evaluate");
  return { result };
}

export async function doWait(
  manager: BrowserManager,
  page: Page,
  params: { timeMs?: number; text?: string; selector?: string; url?: string; idle?: boolean; timeoutMs?: number },
): Promise<{ waited: string; notes: string[] }> {
  const timeout = params.timeoutMs ?? manager.cfg.actionTimeoutMs;
  const notes: string[] = [];
  const done: string[] = [];

  if (params.timeMs) {
    const ms = Math.min(params.timeMs, 60000);
    await page.waitForTimeout(ms);
    done.push(`等待 ${ms}ms`);
  }
  if (params.url) {
    try {
      await page.waitForURL(params.url, { timeout });
      done.push(`等待 URL 匹配 ${params.url}`);
    } catch {
      notes.push(`URL 在 ${timeout}ms 内未变为 ${params.url}(当前 ${page.url()})`);
    }
  }
  if (params.text) {
    try {
      await page.getByText(params.text, { exact: false }).first().waitFor({ state: "visible", timeout });
      done.push(`等待文本出现 "${truncate(params.text, 50)}"`);
    } catch {
      notes.push(`文本 "${truncate(params.text, 50)}" 在 ${timeout}ms 内未出现 —— 内容可能还没加载,可加大 timeoutMs 或检查是否在 iframe 中`);
    }
  }
  if (params.selector) {
    try {
      await page.locator(params.selector).first().waitFor({ state: "visible", timeout });
      done.push(`等待选择器 ${params.selector}`);
    } catch {
      notes.push(`选择器 ${params.selector} 在 ${timeout}ms 内未出现`);
    }
  }
  if (params.idle) {
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 15000) });
      done.push("等待网络空闲");
    } catch {
      notes.push("网络在 15s 内未完全空闲(页面可能有长轮询),继续执行");
    }
  }
  if (done.length === 0 && notes.length === 0) {
    throw new ToolError("missing_params", "browser_wait 需要至少一个等待条件", "支持 timeMs / text / selector / url / idle");
  }
  return { waited: done.join("; "), notes };
}
