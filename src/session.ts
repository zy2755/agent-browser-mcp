// 会话状态:标签页登记、激活页管理、持久化与恢复
import type { BrowserContext, Page } from "playwright-core";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { uid, withTimeout, log } from "./util.js";

export interface TabRecord {
  id: string;
  url: string;
  title: string;
}

interface SessionState {
  version: 1;
  tabs: TabRecord[];
  activeId: string | null;
  updatedAt: string;
}

/**
 * 页面登记表。所有页面(含弹窗)都有 uuid,id 持久化以便跨重启恢复。
 * 注册表/快照 ref 均通过 pageId 关联页面。
 */
export class SessionTracker {
  private pages = new Map<string, Page>();
  private meta = new Map<string, { url: string; title: string }>();
  private activeId: string | null = null;
  private saveFile: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving = false;
  private dirty = false;

  constructor(stateDir: string) {
    this.saveFile = path.join(stateDir, "session.json");
  }

  adopt(page: Page, opts?: { activate?: boolean }): string {
    // 弹窗/新标签可能触发多次 adopt,先查重
    for (const [id, p] of this.pages) {
      if (p === page) return id;
    }
    const id = uid();
    this.pages.set(id, page);
    this.meta.set(id, { url: page.url(), title: "" });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        const m = this.meta.get(id);
        if (m) {
          m.url = page.url();
          this.markDirty();
        }
      }
    });
    page.once("close", () => {
      this.remove(id);
    });
    if (opts?.activate || this.activeId === null || !this.pages.has(this.activeId)) {
      this.activeId = id;
    }
    this.markDirty();
    return id;
  }

  remove(id: string): void {
    this.pages.delete(id);
    this.meta.delete(id);
    if (this.activeId === id) {
      const first = this.pages.keys().next();
      this.activeId = first.done ? null : first.value;
    }
    this.markDirty();
  }

  get(id: string): Page | undefined {
    const p = this.pages.get(id);
    return p && !p.isClosed() ? p : undefined;
  }

  getActive(): Page | undefined {
    if (this.activeId) {
      const p = this.get(this.activeId);
      if (p) return p;
      this.activeId = null; // 已死,自动换到第一个活页
    }
    const first = this.pages.keys().next();
    if (first.done) return undefined;
    this.activeId = first.value;
    return this.pages.get(first.value);
  }

  setActive(id: string): boolean {
    if (!this.get(id)) return false;
    this.activeId = id;
    this.markDirty();
    return true;
  }

  listTabs(): Array<TabRecord & { active: boolean; pageId: string }> {
    const out: Array<TabRecord & { active: boolean; pageId: string }> = [];
    for (const [id, p] of this.pages) {
      if (p.isClosed()) continue;
      const m = this.meta.get(id);
      out.push({
        id,
        url: p.url(),
        title: m?.title ?? "",
        active: id === this.activeId,
        pageId: id,
      });
    }
    return out;
  }

  async refreshTitle(id: string): Promise<void> {
    const p = this.pages.get(id);
    if (!p || p.isClosed()) return;
    try {
      const t = await withTimeout(p.title(), 3000, "取标题");
      this.meta.set(id, { url: p.url(), title: t });
    } catch {
      /* 标题拿不到不影响主流程 */
    }
  }

  markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flush(), 600);
  }

  /** 原子写 session.json(tmp + rename),标题尽力而为 */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty && !this.forceSaveFlag) return;
    this.dirty = false;
    this.forceSaveFlag = false;
    this.saving = true;
    try {
      const tabs: TabRecord[] = [];
      for (const [id, p] of this.pages) {
        if (p.isClosed()) continue;
        const m = this.meta.get(id);
        let title = m?.title ?? "";
        try {
          if (!title) title = await withTimeout(p.title(), 1500, "取标题");
        } catch {
          title = "";
        }
        tabs.push({ id, url: p.url(), title });
      }
      const state: SessionState = {
        version: 1,
        tabs,
        activeId: this.activeId,
        updatedAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(this.saveFile), { recursive: true });
      const tmp = this.saveFile + ".tmp";
      await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await rename(tmp, this.saveFile);
    } catch (e) {
      void log("warn", "session save failed", e);
    } finally {
      this.saving = false;
    }
  }

  private forceSaveFlag = false;

  /** 读出持久化的会话(用于重启恢复) */
  readPersisted(): SessionState | null {
    try {
      if (!existsSync(this.saveFile)) return null;
      const raw = readFileSync(this.saveFile, "utf8");
      const st = JSON.parse(raw) as SessionState;
      if (st.version !== 1 || !Array.isArray(st.tabs)) return null;
      return st;
    } catch (e) {
      void log("warn", "session read failed", e);
      return null;
    }
  }
}
