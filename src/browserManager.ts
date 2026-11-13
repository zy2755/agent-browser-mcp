// 浏览器生命周期管理:启动 / 健康检查 / 崩溃懒重启 / 会话恢复 / 弹窗与对话框 / 下载
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Download,
} from "playwright-core";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import type { BrowserMcpConfig } from "./config.js";
import { SessionTracker } from "./session.js";
import { log, withTimeout, uid } from "./util.js";
import { ToolError } from "./errors.js";

export interface DialogRecord {
  ts: number;
  type: string;
  message: string;
  pageUrl: string;
}

export interface DownloadRecord {
  ts: number;
  url: string;
  path: string;
  error?: string;
}

export type ManagerState = "stopped" | "starting" | "ready" | "crashed";

const MAX_RING = 20;

export class BrowserManager {
  readonly cfg: BrowserMcpConfig;
  readonly session: SessionTracker;
  state: ManagerState = "stopped";
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private launching: Promise<void> | null = null;
  private crashedAt = 0;
  lastError: string | null = null;
  restartCount = 0;
  launchedAt: number | null = null;
  /** 最近弹出的新标签(context.on("page") 记录,供点击结果提示) */
  recentPopups: Array<{ ts: number; url: string }> = [];
  recentDialogs: DialogRecord[] = [];
  recentDownloads: DownloadRecord[] = [];
  /** 供 resolveTarget 按登记 id 找页面 */
  get pages(): SessionTracker {
    return this.session;
  }

  constructor(cfg: BrowserMcpConfig) {
    this.cfg = cfg;
    this.session = new SessionTracker(cfg.stateDir);
  }

  // ---------------- 健康检查与懒重启 ----------------

  /**
   * 每次工具调用前调用。已就绪直接返回;崩溃/未启动则启动并恢复会话。
   * 返回 notes 里包含需要呈现给 agent 的状态变化(如“浏览器已自动重启”)。
   */
  async ensureReady(force = false): Promise<string[]> {
    const notes: string[] = [];
    if (force) {
      notes.push("已强制重启浏览器,所有旧 ref 失效,请重新 browser_snapshot。");
      await this.killOwnBrowser();
      this.state = "crashed";
    }
    const healthy =
      this.state === "ready" &&
      !!this.context &&
      !!this.browser &&
      this.browser.isConnected();
    if (healthy) return notes;
    if (this.state !== "ready" && this.crashedAt > 0) {
      notes.push("⚠️ 检测到浏览器已断开/崩溃,正在自动重启并恢复会话…");
    }
    if (this.launching) {
      await this.launching;
      return notes;
    }
    this.launching = this.doLaunch(notes).finally(() => {
      this.launching = null;
    });
    await this.launching;
    return notes;
  }

  private async doLaunch(notes: string[]): Promise<void> {
    this.state = "starting";
    try {
      await mkdir(this.cfg.downloadDir, { recursive: true });
      if (this.cfg.mode === "connect") {
        await this.connect(notes);
      } else {
        await this.launchOwn(notes);
      }
      this.state = "ready";
      this.launchedAt = Date.now();
      this.lastError = null;
      this.restartCount++;
      void log("info", `browser ready (mode=${this.cfg.mode}, restart=#${this.restartCount})`);
    } catch (e) {
      this.state = "crashed";
      this.crashedAt = Date.now();
      this.lastError = e instanceof Error ? e.message : String(e);
      void log("error", "launch failed", this.lastError);
      throw e;
    }
  }

  // ---------------- 专用浏览器(launch 模式) ----------------

  private launchArgs(): string[] {
    const args = [
      "--no-first-run",
      "--no-default-browser-check",
      // 窗口失焦时不禁定时器/渲染 —— agent 使用时窗口经常不在前台
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-blink-features=AutomationControlled",
      ...this.cfg.extraArgs,
    ];
    if (!this.cfg.headless && this.cfg.viewport === null) args.push("--start-maximized");
    return args;
  }

  private launchOptionsFor(channel: string | undefined, executablePath: string | undefined) {
    const headless = this.cfg.headless;
    return {
      channel: channel as "chrome" | "msedge" | undefined,
      executablePath,
      headless,
      viewport: headless ? this.cfg.viewport ?? { width: 1440, height: 900 } : this.cfg.viewport,
      args: this.launchArgs(),
      ignoreDefaultArgs: ["--enable-automation"],
      acceptDownloads: true as const,
      timeout: 30000,
      locale: this.cfg.locale,
      env: undefined as NodeJS.ProcessEnv | undefined,
    };
  }

  private async launchOwn(notes: string[]): Promise<void> {
    const candidates: Array<{ channel?: string; executablePath?: string }> = [];
    if (this.cfg.executablePath) {
      candidates.push({ executablePath: this.cfg.executablePath });
    } else {
      for (const c of this.cfg.channels) candidates.push({ channel: c });
    }

    let lastErr: unknown = null;
    for (const cand of candidates) {
      // 第一次尝试失败且疑似 profile 被占(残留进程)时,定向清理后重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          void log("info", `launching via ${cand.channel ?? cand.executablePath} (attempt ${attempt + 1})`);
          const context = await withTimeout(
            chromium.launchPersistentContext(this.cfg.profileDir, this.launchOptionsFor(cand.channel, cand.executablePath)),
            45000,
            "启动浏览器",
          );
          this.context = context;
          this.browser = context.browser();
          const { restoredCount } = await this.attachContext(context, { restoreSession: true });
          if (restoredCount > 0) notes.push(`已恢复 ${restoredCount} 个标签页。`);
          notes.push(
            `已启动专用浏览器(${cand.channel ?? "自定义路径"}, profile: ${this.cfg.profileDir}, ${this.cfg.headless ? "无头" : "有头"})。`,
          );
          return;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          void log("warn", "launch attempt failed", msg);
          const looksLocked = /ProcessSingleton|SingletonLock|already running|Failed to create|user data directory/i.test(msg);
          if (attempt === 0 && looksLocked) {
            notes.push("profile 疑似被残留进程占用,正在清理…");
            await this.killOrphanByProfile();
          } else {
            break;
          }
        }
      }
    }
    throw new ToolError(
      "launch_failed",
      `无法启动浏览器:${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      "已依次尝试渠道:" + (this.cfg.executablePath ? this.cfg.executablePath : this.cfg.channels.join(" → ")) + "。可检查 config.json 的 channels/executablePath,或确认 Chrome/Edge 已安装。",
    );
  }

  /** 按 profile 路径定向清理残留 Chrome 进程(Windows: PowerShell Get-CimInstance) */
  /** 由启动时记录的本浏览器进程 pid(供 get_info 展示与定向清理;best-effort) */
  browserPids: string[] = [];

  private async recordBrowserPids(): Promise<void> {
    if (process.platform !== "win32") return;
    const profile = path.resolve(this.cfg.profileDir).toLowerCase();
    const ps = `
      Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${profile.replace(/'/g, "''")}') } |
      ForEach-Object { $_.ProcessId }
    `.trim();
    await new Promise<void>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { timeout: 15000 },
        (err, stdout) => {
          if (!err && stdout) {
            this.browserPids = stdout.split(/\s+/).filter((s) => /^\d+$/.test(s));
          }
          resolve();
        },
      );
    });
    void log("info", "browser pids recorded", this.browserPids);
  }

  private async killOrphanByProfile(): Promise<void> {
    if (process.platform !== "win32") return;
    const profile = path.resolve(this.cfg.profileDir).toLowerCase();
    const ps = `
      Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${profile.replace(/'/g, "''")}') } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    `.trim();
    await new Promise<void>((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15000 }, () => resolve());
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  // ---------------- 外连浏览器(connect 模式) ----------------

  private async connect(notes: string[]): Promise<void> {
    const url = this.cfg.cdpUrl!;
    let browser: Browser;
    try {
      browser = await withTimeout(chromium.connectOverCDP(url, { timeout: 10000 }), 15000, "连接 CDP");
    } catch (e) {
      throw new ToolError(
        "connect_failed",
        `无法连接浏览器 ${url}:${e instanceof Error ? e.message : String(e)}`,
        "请确认目标浏览器已带调试端口启动,例如:chrome.exe --remote-debugging-port=9222",
      );
    }
    this.browser = browser;
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    this.context = ctx;
    await this.attachContext(ctx, { restoreSession: false, adoptExisting: true });
    notes.push(`已连接到现有浏览器(${url}),退出时不会关闭它。`);
  }

  // ---------------- 事件挂载 ----------------

  private async attachContext(
    ctx: BrowserContext,
    opts: { restoreSession: boolean; adoptExisting?: boolean },
  ): Promise<{ restoredCount: number }> {
    // 事件注册必须先于一切业务操作(含会话恢复),否则会漏掉期间发生的页面/对话框事件
    for (const p of ctx.pages()) {
      this.session.adopt(p, { activate: false });
    }
    void log("info", `attached context with ${ctx.pages().length} existing pages`);

    ctx.on("page", (page: Page) => {
      const id = this.session.adopt(page, { activate: true });
      this.recentPopups.push({ ts: Date.now(), url: page.url() });
      if (this.recentPopups.length > MAX_RING) this.recentPopups.shift();
      void log("info", "new page adopted", { id, url: page.url() });
    });

    ctx.on("dialog", async (dialog) => {
      const rec: DialogRecord = {
        ts: Date.now(),
        type: dialog.type(),
        message: dialog.message().slice(0, 500),
        pageUrl: safeUrl(dialog.page()),
      };
      this.recentDialogs.push(rec);
      if (this.recentDialogs.length > MAX_RING) this.recentDialogs.shift();
      void log("info", "dialog", rec);
      try {
        if (this.cfg.dialogPolicy === "accept") {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }
      } catch {
        /* 页面可能已跳转 */
      }
    });

    ctx.on("download", (download: Download) => {
      const file = path.join(this.cfg.downloadDir, download.suggestedFilename() || `download-${uid()}`);
      const rec: DownloadRecord = { ts: Date.now(), url: download.url(), path: file };
      download
        .saveAs(file)
        .then(() => {
          this.recentDownloads.push(rec);
        })
        .catch((e) => {
          rec.error = e instanceof Error ? e.message : String(e);
          this.recentDownloads.push(rec);
        });
      if (this.recentDownloads.length > MAX_RING) this.recentDownloads.shift();
    });

    if (this.browser) {
      this.browser.on("disconnected", () => {
        // 懒重启:不在这里自动重启,等下次工具调用时 ensureReady 处理
        this.state = "crashed";
        this.crashedAt = Date.now();
        this.lastError = this.lastError ?? "浏览器连接断开(手动关闭或崩溃)";
        void log("warn", "browser disconnected; will lazy-restart on next call");
      });
    }

    ctx.on("close", () => {
      if (this.cfg.mode === "launch") {
        this.state = "crashed";
        this.crashedAt = Date.now();
      }
    });

    // 事件就绪后再做会话恢复/认领
    if (opts.adoptExisting) {
      // connect 模式:不导航,只认领已有页面
      const pages = this.session.listTabs();
      if (pages.length > 0) {
        void this.session.setActive(pages[0].id);
      }
      await this.recordBrowserPids();
      return { restoredCount: 0 };
    }
    if (opts.restoreSession) {
      const r = await this.restoreSession(ctx);
      await this.recordBrowserPids();
      return r;
    }
    return { restoredCount: 0 };
  }

  private restoring = false;
  private async restoreSession(ctx: BrowserContext): Promise<{ restoredCount: number }> {
    if (this.restoring) return { restoredCount: 0 };
    this.restoring = true;
    let restoredCount = 0;
    try {
      const persisted = this.session.readPersisted();
      const validTabs = persisted?.tabs.filter((t) => t.url && t.url !== "about:blank") ?? [];
      const existing = ctx.pages();
      if (validTabs.length === 0) {
        // 全新会话:起始页
        const page = existing[0] ?? (await ctx.newPage());
        const id = this.session.adopt(page, { activate: true });
        if (this.cfg.startUrl !== "about:blank") {
          await safeGoto(page, this.cfg.startUrl, this.cfg.navTimeoutMs);
        }
        this.session.setActive(id);
        return { restoredCount: 0 };
      }
      // 恢复:第一个标签用已有空白页,其余新建;失败容忍
      for (let i = 0; i < validTabs.length; i++) {
        const tab = validTabs[i];
        let page: Page | undefined;
        if (i === 0 && existing.length > 0 && existing[0].url() === "about:blank") {
          page = existing[0];
        } else {
          page = await ctx.newPage();
        }
        const id = this.session.adopt(page, { activate: tab.id === persisted?.activeId });
        await safeGoto(page, tab.url, Math.min(15000, this.cfg.navTimeoutMs));
        restoredCount++;
      }
      if (restoredCount > 0) {
        void log("info", "session restored", { count: restoredCount });
      }
      return { restoredCount };
    } catch (e) {
      void log("warn", "session restore partial failure", e);
      return { restoredCount };
    } finally {
      this.restoring = false;
    }
  }

  // ---------------- 查询与关闭 ----------------

  getContext(): BrowserContext {
    if (!this.context) throw new ToolError("not_ready", "浏览器尚未启动", "这是内部错误,请重试一次");
    return this.context;
  }

  pageById(id: string): Page | undefined {
    return this.session.get(id);
  }

  /** 最近 N ms 内出现的新弹窗(供点击结果提示) */
  popupsSince(ts: number): Array<{ url: string }> {
    return this.recentPopups.filter((p) => p.ts >= ts).map((p) => ({ url: p.url }));
  }

  dialogsSince(ts: number): DialogRecord[] {
    return this.recentDialogs.filter((d) => d.ts >= ts);
  }

  downloadsSince(ts: number): DownloadRecord[] {
    return this.recentDownloads.filter((d) => d.ts >= ts);
  }

  async killOwnBrowser(): Promise<void> {
    try {
      if (this.browser) {
        await withTimeout(this.browser.close(), 8000, "关闭浏览器");
      }
    } catch {
      /* 忽略 */
    }
    if (this.cfg.mode === "launch") {
      // 双保险:确保没有残留进程占用 profile
      await this.killOrphanByProfile();
    }
    this.browser = null;
    this.context = null;
  }

  async shutdown(): Promise<void> {
    await this.session.flush().catch(() => {});
    if (this.cfg.mode === "connect") {
      // 外部浏览器不关,只断开
      try {
        await this.browser?.close();
      } catch {
        /* connectOverCDP 的 close 只断开连接 */
      }
    } else {
      await this.killOwnBrowser();
    }
    this.state = "stopped";
  }
}

function safeUrl(page: Page | null | undefined): string {
  try {
    return page?.url() ?? "";
  } catch {
    return "";
  }
}

async function safeGoto(page: Page, url: string, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(
      page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
      timeoutMs + 5000,
      "导航 " + url,
    );
  } catch (e) {
    void log("warn", `restore goto failed: ${url}`, e);
  }
}
