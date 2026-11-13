// 配置:默认值 → 配置文件 → 环境变量 → 命令行参数(后者覆盖前者)
import { homedir } from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface BrowserMcpConfig {
  /** launch = 启动专用 Chrome(默认);connect = 连接已开调试端口的浏览器 */
  mode: "launch" | "connect";
  /** connect 模式的 CDP 地址,如 http://127.0.0.1:9222 */
  cdpUrl: string | null;
  /** 专用 profile 用户数据目录(launch 模式) */
  profileDir: string;
  /** 浏览器渠道回退链,依次尝试 */
  channels: string[];
  /** 直接指定浏览器可执行文件(优先于 channel) */
  executablePath: string | null;
  headless: boolean;
  viewport: { width: number; height: number } | null; // null = 有头时跟随窗口
  locale: string;
  stateDir: string;
  logDir: string;
  downloadDir: string;
  navTimeoutMs: number;
  actionTimeoutMs: number;
  /** 单次工具返回文本预算(字符) */
  resultMaxChars: number;
  /** 快照最多收录的元素数 */
  snapshotMaxElements: number;
  /** 对话框策略:自动接受 / 自动取消 */
  dialogPolicy: "accept" | "dismiss";
  /** 新会话(无历史标签)时打开的起始页 */
  startUrl: string;
  /** 附加 Chrome 启动参数 */
  extraArgs: string[];
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function parseViewport(v: string | undefined): { width: number; height: number } | null | undefined {
  if (v === undefined || v === "") return undefined;
  if (v.toLowerCase() === "max" || v === "null") return null;
  const m = v.match(/^(\d+)x(\d+)$/);
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 极简 argv 解析:--key value / --key=value / --flag */
function parseArgv(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): BrowserMcpConfig {
  const args = parseArgv(argv);
  const env = process.env;
  const home = homedir();

  const stateDir = String(args["state-dir"] ?? env.BROWSER_MCP_STATE_DIR ?? path.join(home, ".browser-mcp"));
  const defaultProfile = path.join(stateDir, "profile");

  // 配置文件(可整体覆盖默认值;同步读,启动时只跑一次)
  const cfgFile = path.join(stateDir, "config.json");
  let fileCfg: Partial<BrowserMcpConfig> = {};
  try {
    if (existsSync(cfgFile)) {
      fileCfg = JSON.parse(readFileSync(cfgFile, "utf8")) as Partial<BrowserMcpConfig>;
    }
  } catch {
    fileCfg = {}; // 配置文件损坏时按默认值启动,不阻塞
  }

  const cfg: BrowserMcpConfig = {
    mode: "launch",
    cdpUrl: null,
    profileDir: defaultProfile,
    channels: ["chrome", "msedge"],
    executablePath: null,
    headless: false,
    viewport: null,
    locale: "zh-CN",
    stateDir,
    logDir: path.join(stateDir, "logs"),
    downloadDir: path.join(stateDir, "downloads"),
    navTimeoutMs: 30000,
    actionTimeoutMs: 15000,
    resultMaxChars: 30000,
    snapshotMaxElements: 400,
    dialogPolicy: "accept",
    startUrl: "about:blank",
    extraArgs: [],
  };

  const apply = (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === "") continue;
      (cfg as unknown as Record<string, unknown>)[k] = v;
    }
  };

  // 文件配置
  apply(fileCfg as Record<string, unknown>);

  // 环境变量
  apply({
    mode: parseBool(env.BROWSER_MCP_CONNECT) === true ? "connect" : undefined,
    cdpUrl: env.BROWSER_MCP_CDP_URL,
    profileDir: env.BROWSER_MCP_PROFILE,
    channels: env.BROWSER_MCP_CHANNELS ? env.BROWSER_MCP_CHANNELS.split(",").map((s) => s.trim()) : undefined,
    executablePath: env.BROWSER_MCP_EXECUTABLE,
    headless: parseBool(env.BROWSER_MCP_HEADLESS),
    viewport: parseViewport(env.BROWSER_MCP_VIEWPORT),
    locale: env.BROWSER_MCP_LOCALE,
    navTimeoutMs: env.BROWSER_MCP_NAV_TIMEOUT ? Number(env.BROWSER_MCP_NAV_TIMEOUT) : undefined,
    actionTimeoutMs: env.BROWSER_MCP_ACTION_TIMEOUT ? Number(env.BROWSER_MCP_ACTION_TIMEOUT) : undefined,
    dialogPolicy: env.BROWSER_MCP_DIALOGS as "accept" | "dismiss" | undefined,
    startUrl: env.BROWSER_MCP_START_URL,
  });

  // 命令行参数(优先级最高;ZCode 注册时用 args 传)
  apply({
    mode: args["connect"] === true || (typeof args["cdp-url"] === "string" && args["cdp-url"] !== "") ? "connect" : undefined,
    cdpUrl: typeof args["cdp-url"] === "string" ? args["cdp-url"] : args["connect"] === true ? "http://127.0.0.1:9222" : undefined,
    profileDir: typeof args["profile"] === "string" ? args["profile"] : undefined,
    channels: typeof args["channels"] === "string" ? String(args["channels"]).split(",").map((s) => s.trim()) : undefined,
    executablePath: typeof args["executable"] === "string" ? args["executable"] : undefined,
    headless: args["headless"] === true ? true : args["headed"] === true ? false : undefined,
    viewport: parseViewport(typeof args["viewport"] === "string" ? args["viewport"] : undefined),
    locale: typeof args["locale"] === "string" ? args["locale"] : undefined,
    navTimeoutMs: typeof args["nav-timeout"] === "string" ? Number(args["nav-timeout"]) : undefined,
    actionTimeoutMs: typeof args["action-timeout"] === "string" ? Number(args["action-timeout"]) : undefined,
    dialogPolicy: typeof args["dialogs"] === "string" ? (args["dialogs"] as "accept" | "dismiss") : undefined,
    startUrl: typeof args["start-url"] === "string" ? args["start-url"] : undefined,
    extraArgs: typeof args["extra-args"] === "string" ? String(args["extra-args"]).split(" ").filter(Boolean) : undefined,
  });

  if (cfg.mode === "connect" && !cfg.cdpUrl) cfg.cdpUrl = "http://127.0.0.1:9222";
  return cfg;
}
