// 入口:stdio MCP server。日志只进文件/stderr,stdout 专用于 MCP 协议。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { BrowserManager } from "./browserManager.js";
import { RefRegistry } from "./snapshot.js";
import { registerTools } from "./tools.js";
import { initLogging, log } from "./util.js";

async function main(): Promise<void> {
  // --help / --version
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stderr.write(`agent-browser-mcp — 给 agent 用的可靠浏览器控制 MCP server

用法: node dist/index.js [选项]
  --cdp-url <url>     connect 模式:连接已开调试端口的浏览器(如 http://127.0.0.1:9222)
  --headless          无头模式(默认有头)
  --profile <dir>     指定 profile 用户数据目录(默认 ~/.browser-mcp/profile)
  --channels <list>   浏览器渠道回退链(默认 chrome,msedge)
  --executable <path> 直接指定浏览器可执行文件
  --viewport WxH      固定视口(默认有头时跟随窗口大小)
  --start-url <url>   全新会话的起始页
  --dialogs accept|dismiss  对话框策略(默认 accept)
  --state-dir <dir>   状态目录(默认 ~/.browser-mcp)
配置文件: ~/.browser-mcp/config.json;环境变量: BROWSER_MCP_*(详见 README)
`);
    return;
  }

  const cfg = loadConfig();
  await initLogging(cfg.logDir);
  await log("info", "server starting", { pid: process.pid, mode: cfg.mode, headless: cfg.headless, profile: cfg.profileDir });

  const manager = new BrowserManager(cfg);
  const registry = new RefRegistry();

  const server = new Server(
    { name: "agent-browser-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, manager, registry);

  // 优雅退出:关闭浏览器防止僵尸进程;connect 模式只断开
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await log("info", `shutting down (${reason})`);
    await manager.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("exit", () => {
    // exit 回调里不能异步;launch 模式下浏览器是子进程,进程死亡后由系统回收
    // 若有残留,下次启动时 killOrphanByProfile 会清理
  });
  process.on("unhandledRejection", (e) => {
    void log("error", "unhandledRejection", e);
  });
  process.on("uncaughtException", (e) => {
    void log("error", "uncaughtException", e);
    // 不退出:MCP server 存活优先,工具调用层已有兜底
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await log("info", "stdio transport connected, serving tools");
}

main().catch(async (e) => {
  await log("error", "fatal startup error", e).catch(() => {});
  process.stderr.write(`agent-browser-mcp 启动失败: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
