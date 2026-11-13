// MCP 工具定义与接线:14 个工具,统一走 ensureReady / 错误整形 / 文本预算
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Page } from "playwright-core";
import type { BrowserManager } from "./browserManager.js";
import type { RefRegistry } from "./snapshot.js";
import { snapshotPage } from "./snapshot.js";
import {
  doClick,
  doEvaluate,
  doHover,
  doPressKey,
  doScreenshot,
  doScroll,
  doSelectOption,
  doType,
  doWait,
  formatAfter,
  resolveTarget,
} from "./actions.js";
import { ToolError, shapeError } from "./errors.js";
import { safeStringify, truncate } from "./util.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface ToolDef extends Tool {
  handler: Handler;
  /** 调用前是否自动启动/恢复浏览器 */
  needsBrowser: boolean;
}

function text(content: string): CallToolResult {
  return { content: [{ type: "text", text: content }] };
}

function textError(shape: { code: string; message: string; hint?: string }): CallToolResult {
  const lines = [`❌ [${shape.code}] ${shape.message}`];
  if (shape.hint) lines.push(`💡 ${shape.hint}`);
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

const STR = { type: "string" } as const;
const NUM = { type: "number" } as const;
const BOOL = { type: "boolean" } as const;

function strEnum(values: string[]): { type: "string"; enum: string[] } {
  return { type: "string", enum: values };
}

export function registerTools(server: Server, manager: BrowserManager, registry: RefRegistry): void {
  // ---------- 公共助手 ----------

  async function requireActivePage(): Promise<{ page: Page; pageId: string; created: boolean }> {
    await manager.ensureReady();
    const ctx = manager.getContext();
    const page = manager.session.getActive();
    if (page) {
      const all = manager.session.listTabs();
      const active = all.find((t) => t.active) ?? all[0];
      if (active) return { page, pageId: active.id, created: false };
    }
    const newPage = await ctx.newPage();
    const pageId = manager.session.adopt(newPage, { activate: true });
    return { page: newPage, pageId, created: true };
  }

  function activePageId(): string | undefined {
    return manager.session.listTabs().find((t) => t.active)?.id;
  }

  async function attachSnapshot(
    out: string[],
    page: Page,
    args: Record<string, unknown>,
    filter: "balanced" | "interactive" | "text" = "balanced",
  ): Promise<void> {
    if (args.snapshot === false) return;
    const pageId = activePageId() ?? "?";
    const snap = await snapshotPage(page, pageId, registry, { filter });
    out.push("", "── 最新快照 ──", snap.text);
  }

  function capOut(s: string): string {
    return s.length > manager.cfg.resultMaxChars
      ? s.slice(0, manager.cfg.resultMaxChars) + `\n…(结果超过 ${manager.cfg.resultMaxChars} 字符被截断,请缩小查询范围)`
      : s;
  }

  // ---------- 工具定义 ----------

  const tools: ToolDef[] = [
    {
      name: "browser_navigate",
      description:
        "导航到 URL,返回后自动附带页面交互元素快照(带 [eN] ref 编号,可直接用于 click/type)。缺协议时自动补 https://。",
      inputSchema: {
        type: "object",
        properties: {
          url: { ...STR, description: "目标 URL" },
          newTab: { ...BOOL, description: "是否在新标签页打开(默认 false,当前页导航)" },
          timeoutMs: { ...NUM, description: "导航超时毫秒数(默认 30000)" },
          snapshot: { ...BOOL, description: "是否在结果中附快照(默认 true)" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        let url = String(args.url).trim();
        if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url) && !/^about:/i.test(url)) {
          url = "https://" + url;
        }
        const ctx = manager.getContext();
        let page: Page;
        let pageId: string;
        if (args.newTab === true) {
          page = await ctx.newPage();
          pageId = manager.session.adopt(page, { activate: true });
        } else {
          const active = await requireActivePage();
          page = active.page;
          pageId = active.pageId;
        }
        registry.clearPage(pageId); // 导航后旧 ref 作废
        const out: string[] = [];
        const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : manager.cfg.navTimeoutMs;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/Timeout/i.test(msg)) {
            out.push(`⚠️ 导航超时(${timeout}ms),页面可能仍在加载。当前 URL: ${page.url()}`);
            out.push("💡 可直接 browser_snapshot 看看已加载的部分,或用 browser_wait {idle:true} 再等网络空闲。");
          } else {
            throw e;
          }
        }
        manager.session.markDirty();
        const title = await page.title().catch(() => "");
        out.push(`✅ 已打开: ${title || "(无标题)"} — ${page.url()}`);
        const popups = manager.popupsSince(Date.now() - 2000);
        for (const p of popups) out.push(`🪟 检测到新标签页 → ${p.url}`);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_snapshot",
      description:
        '获取当前页面语义快照:交互元素带 [eN] ref 编号(iframe 内容已拍平)。支持 rootRef(只看某元素子树)、selector、filter:"interactive" 只看交互元素。',
      inputSchema: {
        type: "object",
        properties: {
          filter: strEnum(["balanced", "interactive", "text"]),
          rootRef: { ...STR, description: "只快照该 ref 元素的子树" },
          selector: { ...STR, description: "只快照匹配该 CSS 选择器的子树(主文档)" },
          maxElements: { ...NUM, description: "最多输出行数(默认 400)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const pageId = activePageId() ?? "?";
        const snap = await snapshotPage(page, pageId, registry, {
          filter: args.filter as never,
          rootRef: args.rootRef as string | undefined,
          rootSelector: args.selector as string | undefined,
          maxElements: typeof args.maxElements === "number" ? args.maxElements : undefined,
          title: await page.title().catch(() => ""),
        });
        return text(capOut(snap.text));
      },
    },
    {
      name: "browser_click",
      description:
        "点击元素(优先用快照里的 ref)。自动等待可操作、自动重解析失效 ref、点击后自动附最新快照。特殊对话框会自动处理并上报。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR, description: "快照中的 [eN] 编号" },
          selector: { ...STR, description: "CSS 选择器(ref 不可用时的兜底)" },
          text: { ...STR, description: "按可见文本匹配" },
          button: strEnum(["left", "right", "middle"]),
          doubleClick: { ...BOOL },
          timeoutMs: { ...NUM },
          snapshot: { ...BOOL, description: "点击后是否附快照(默认 true)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { target, after } = await doClick(manager, page, registry, args as never);
        const out: string[] = [];
        out.push("✅ 已点击。" + (target.notes.length ? "\n" + target.notes.join("\n") : ""));
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_type",
      description: "向输入框输入文本(先清空再输入)。submit:true 时回车提交。适用于 input/textarea/contenteditable。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR },
          selector: { ...STR },
          text: { ...STR, description: "要输入的文本" },
          submit: { ...BOOL, description: "输入后按 Enter(默认 false)" },
          clear: { ...BOOL, description: "是否先清空(默认 true;false 则追加)" },
          timeoutMs: { ...NUM },
        },
        required: ["text"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { target, after } = await doType(manager, page, registry, args as never);
        const out: string[] = [];
        out.push(`✅ 已输入: ${JSON.stringify(truncate(String(args.text), 80))}` + (args.submit ? " 并回车提交。" : ".") + (target.notes.length ? "\n" + target.notes.join("\n") : ""));
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_press_key",
      description: '按下键盘按键,如 Enter / Tab / ArrowDown / "Control+a"。带 ref 时先聚焦该元素。',
      inputSchema: {
        type: "object",
        properties: {
          key: { ...STR, description: "键名,如 Enter、Escape、ArrowDown、Control+a" },
          ref: { ...STR, description: "先聚焦此元素再按键" },
        },
        required: ["key"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { after } = await doPressKey(manager, page, registry, args as never);
        const out: string[] = [`✅ 已按下 ${args.key}。`];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_select_option",
      description: "在下拉框(select)中选中选项。values 可为 value 或可见 label,自动两轮匹配。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR },
          selector: { ...STR },
          values: { type: "array", items: STR, description: "要选中的 value/label 列表" },
          timeoutMs: { ...NUM },
        },
        required: ["values"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { selected, after } = await doSelectOption(manager, page, registry, args as never);
        const out: string[] = [`✅ 已选中: ${JSON.stringify(selected)}`];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_hover",
      description: "鼠标悬停到元素上(触发悬浮菜单/tooltip)。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { ...STR },
          selector: { ...STR },
          timeoutMs: { ...NUM },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { target, after } = await doHover(manager, page, registry, args as never);
        const out: string[] = ["✅ 已悬停。" + (target.notes.length ? "\n" + target.notes.join("\n") : "")];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        await attachSnapshot(out, page, args);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_scroll",
      description: "滚动页面或指定滚动容器(带 ref 时滚动该容器)。方向 + 像素量。",
      inputSchema: {
        type: "object",
        properties: {
          direction: strEnum(["up", "down", "left", "right"]),
          amount: { ...NUM, description: "滚动像素(默认 600)" },
          ref: { ...STR, description: "滚动该容器(快照中带 [可滚动] 标记的元素)" },
        },
        required: ["direction"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { after } = await doScroll(manager, page, registry, args as never);
        const out: string[] = ["✅ 已滚动。" ];
        const afterText = formatAfter(after);
        if (afterText) out.push(afterText);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_screenshot",
      description: "截屏并保存到本地,返回图片(供多模态查看)。可整页、可视区或单元素(ref)。",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { ...BOOL, description: "整页截图(默认只截可视区)" },
          ref: { ...STR, description: "只截该元素" },
          filename: { ...STR, description: "文件名(不含扩展名,默认时间戳)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const shot = await doScreenshot(manager, page, registry, args as never);
        return {
          content: [
            { type: "image", data: shot.base64, mimeType: shot.mimeType },
            { type: "text", text: `✅ 截图已保存 → ${shot.file}` },
          ],
        };
      },
    },
    {
      name: "browser_evaluate",
      description:
        "逃生舱:在页面里执行 JS 并返回 JSON 可序列化结果。传函数字符串如 `() => document.title` 或 `() => {...}`;带 ref 时在该元素上执行(`(el, ) => el.value`)。",
      inputSchema: {
        type: "object",
        properties: {
          js: { ...STR, description: "函数字符串,如 `() => document.querySelector('#app')?.innerText.slice(0,2000)`" },
          ref: { ...STR, description: "在该元素上执行,回调第一个参数是元素" },
        },
        required: ["js"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { result } = await doEvaluate(manager, page, registry, args as never);
        const s = safeStringify(result, 8000);
        return text(capOut(`✅ 执行结果:\n${s === undefined ? "undefined" : s}`));
      },
    },
    {
      name: "browser_wait",
      description: '等待条件成立:timeMs 固定时长 / text 文本出现 / selector 元素出现 / url 跳转 / idle 网络空闲。可组合。',
      inputSchema: {
        type: "object",
        properties: {
          timeMs: { ...NUM },
          text: { ...STR, description: "等待该文本出现在页面上" },
          selector: { ...STR },
          url: { ...STR, description: "等待 URL 变为该模式" },
          idle: { ...BOOL, description: "等待网络空闲(最长 15s)" },
          timeoutMs: { ...NUM, description: "等待超时(默认 15000)" },
        },
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const { page } = await requireActivePage();
        const { waited, notes } = await doWait(manager, page, args as never);
        const out: string[] = [`✅ ${waited}。`];
        for (const n of notes) out.push(`⚠️ ${n}`);
        return text(capOut(out.join("\n")));
      },
    },
    {
      name: "browser_tabs",
      description: "多标签管理:list 列出 / new 新建 / select 切换(按 list 显示的 index 或 id)/ close 关闭。",
      inputSchema: {
        type: "object",
        properties: {
          action: strEnum(["list", "new", "select", "close"]),
          url: { ...STR, description: "new 时打开的 URL(可选)" },
          index: { ...NUM, description: "select/close 的目标标签序号(见 list 输出,0 起)" },
          id: { ...STR, description: "select/close 的目标标签 pageId" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      needsBrowser: true,
      handler: async (args) => {
        const action = String(args.action);
        const ctx = manager.getContext();
        const tabs = manager.session.listTabs();
        if (action === "list") {
          const lines = tabs.map(
            (t, i) => `${t.active ? "▶" : " "} [${i}] id=${t.id} ${t.title || "(无标题)"} — ${t.url}`,
          );
          return text(capOut(`共 ${tabs.length} 个标签页:\n${lines.join("\n") || "(无)"}`));
        }
        if (action === "new") {
          const page = await ctx.newPage();
          const id = manager.session.adopt(page, { activate: true });
          const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : "about:blank";
          if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
          manager.session.markDirty();
          return text(`✅ 新标签页已打开 → ${url}(id=${id})`);
        }
        // select / close 需要目标
        const byIndex = typeof args.index === "number" ? tabs[args.index]?.id : undefined;
        const targetId = (typeof args.id === "string" && args.id) || byIndex;
        if (!targetId) {
          throw new ToolError("missing_target", "select/close 需要指定 index 或 id", "先 browser_tabs {action:'list'} 查看标签列表");
        }
        const targetPage = manager.pageById(targetId);
        if (!targetPage) {
          throw new ToolError("not_found", `标签 ${targetId} 不存在或已关闭`, "先 browser_tabs {action:'list'} 查看标签列表");
        }
        if (action === "select") {
          manager.session.setActive(targetId);
          const title = await targetPage.title().catch(() => "");
          return text(`✅ 已切换到标签: ${title} — ${targetPage.url()}`);
        }
        // close
        await targetPage.close().catch(() => {});
        manager.session.remove(targetId);
        manager.session.markDirty();
        const remaining = manager.session.listTabs();
        if (remaining.length === 0) {
          const page = await ctx.newPage();
          manager.session.adopt(page, { activate: true });
          return text("✅ 已关闭最后一个标签,已新建空白页。");
        }
        return text(`✅ 已关闭标签(id=${targetId}),剩余 ${remaining.length} 个。`);
      },
    },
    {
      name: "browser_get_info",
      description: "查询浏览器健康状态:模式、标签列表、重启次数、最近错误/对话框/下载。不会启动浏览器。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      needsBrowser: false,
      handler: async () => {
        const tabs = manager.session.listTabs();
        const info = {
          mode: manager.cfg.mode,
          state: manager.state,
          headless: manager.cfg.headless,
          channels: manager.cfg.channels,
          profileDir: manager.cfg.profileDir,
          restartCount: manager.restartCount,
          launchedAt: manager.launchedAt ? new Date(manager.launchedAt).toISOString() : null,
          lastError: manager.lastError,
          browserPids: manager.browserPids,
          tabs: tabs.map((t, i) => ({ index: i, id: t.id, active: t.active, title: t.title, url: t.url })),
          recentDialogs: manager.recentDialogs.slice(-5),
          recentDownloads: manager.recentDownloads.slice(-5),
          registryRefs: registry.size,
          logDir: manager.cfg.logDir,
        };
        return text(safeStringify(info, 6000) ?? "{}");
      },
    },
    {
      name: "browser_close",
      description: "关闭浏览器(launch 模式下整个浏览器退出,profile 登录态保留;connect 模式只断开连接)。下次工具调用会自动重启。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      needsBrowser: false,
      handler: async () => {
        await manager.shutdown();
        return text("✅ 浏览器已关闭。" + (manager.cfg.mode === "launch" ? `profile 已保留(${manager.cfg.profileDir}),下次启动登录态仍在。` : "外部浏览器未被关闭。"));
      },
    },
  ];

  // ---------- 注册到 Server ----------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })) as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = tools.find((t) => t.name === name);
    if (!def) {
      return textError({ code: "unknown_tool", message: `未知工具: ${name}`, hint: "tools/list 查看可用工具" });
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (def.needsBrowser) {
        const notes = await manager.ensureReady();
        if (notes.length > 0 && notes.some((n) => n.includes("重启"))) {
          // 重启提示在最前面
          const result = await def.handler(args);
          const first = (result.content?.[0] as { type: string; text?: string }) ?? null;
          if (first?.type === "text" && first.text) {
            first.text = notes.join("\n") + "\n" + first.text;
          }
          return result;
        }
      }
      return await def.handler(args);
    } catch (e) {
      return textError(shapeError(e));
    }
  });
}
