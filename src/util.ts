// 通用工具:日志、超时、截断、id
import { appendFile, mkdir, stat, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------- 日志 ----------------

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB 轮转
const KEEP_LOGS = 3;
let logDir: string | null = null;
let todayKey = "";

function dayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    if (!existsSync(file)) return;
    const s = await stat(file);
    if (s.size < MAX_LOG_BYTES) return;
    for (let i = KEEP_LOGS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (existsSync(from)) await rename(from, to);
    }
    await rename(file, `${file}.1`);
  } catch {
    /* 轮转失败不影响主流程 */
  }
}

export async function initLogging(dir: string): Promise<void> {
  logDir = dir;
  await mkdir(dir, { recursive: true });
}

export async function log(level: "info" | "warn" | "error", msg: string, detail?: unknown): Promise<void> {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${detail !== undefined ? " | " + safeStringify(detail).slice(0, 2000) : ""}\n`;
  if (process.env.BROWSER_MCP_DEBUG === "1") {
    process.stderr.write(line);
  }
  if (!logDir) return;
  const key = dayKey();
  if (key !== todayKey) todayKey = key;
  const file = path.join(logDir, `server-${key}.log`);
  await rotateIfNeeded(file);
  try {
    await appendFile(file, line, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function safeStringify(v: unknown, max = 8000): string {
  const seen = new WeakSet();
  try {
    const s = JSON.stringify(
      v,
      (_k, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        if (typeof val === "string" && val.length > 500) return val.slice(0, 500) + "…";
        return val;
      },
      2,
    );
    return s && s.length > max ? s.slice(0, max) + `…(截断,共${s.length}字符)` : s ?? String(v);
  } catch {
    return String(v);
  }
}

// ---------------- 超时竞速 ----------------

export class TimeoutError extends Error {}

/** 给任意 Promise 加超时。Playwright 调用在浏览器进程死亡时可能永久悬挂,这是断联自愈的关键护栏。 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${label} 超过 ${ms}ms 未返回(浏览器可能已无响应)`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------- 文本 ----------------

export function truncate(s: string, max: number, suffix = `…(截断,原长${s.length})`): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + suffix;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    if (!existsSync(file)) return null;
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
