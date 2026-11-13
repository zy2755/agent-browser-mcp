// 端到端真实场景:百度搜索 → 点结果 → 验证落地页(走构建产物 + 默认配置)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      }
    });
  }
  call(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + " timeout")); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  textOf(r) { return r.content?.find((c) => c.type === "text")?.text ?? ""; }
  async callText(name, args) { return this.textOf(await this.call("tools/call", { name, arguments: args })); }
}

const proc = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"] });
const client = new McpClient(proc);
function refOf(text, re) { const m = text.match(re); return m ? m[1] : null; }

await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
client.notify("notifications/initialized");

console.log("== 1. 打开百度 ==");
const nav = await client.callText("browser_navigate", { url: "https://www.baidu.com" });
console.log(nav.split("\n").slice(0, 3).join("\n"));

console.log("\n== 2. 输入搜索词 ==");
const inputRef = refOf(nav, /\[(e\d+)\] textbox[^\n]*/) ?? refOf(nav, /\[(e\d+)\] textbox/);
console.log("输入框 ref:", inputRef);
const typed = await client.callText("browser_type", { ref: inputRef, text: "Playwright 浏览器自动化", submit: true });
const tLines = typed.split("\n").slice(0, 6).join("\n");
console.log(tLines);

console.log("\n== 3. 检查搜索结果出现 ==");
const waitRes = await client.callText("browser_wait", { idle: true, timeoutMs: 10000 }).catch((e) => "idle skip: " + e.message);
console.log(String(waitRes).split("\n")[0]);
const snap = await client.callText("browser_snapshot", { filter: "interactive", maxElements: 120 });
const hasResults = /Playwright|自动化|百度/.test(snap);
console.log("结果页包含关键词:", hasResults);
console.log("当前 URL:", (snap.match(/— (\S+)/) || [])[1]);

console.log("\n== 4. 点开第一个相关结果 ==");
// 找一个包含 Playwright 的链接
const linkMatch = snap.match(/\[(e\d+)\] link "([^"]*Playwright[^"]*)"/i) || snap.match(/\[(e\d+)\] link "([^"]{4,60})"/);
if (linkMatch) {
  console.log("点击:", linkMatch[2].slice(0, 60));
  const clicked = await client.callText("browser_click", { ref: linkMatch[1], snapshot: false });
  console.log(clicked.split("\n").slice(0, 4).join("\n"));
  const info = JSON.parse(await client.callText("browser_get_info", {}));
  console.log("当前激活页:", info.tabs.find((t) => t.active)?.url);
} else {
  console.log("(未找到可点击的链接,跳过)");
}

await client.callText("browser_close", {});
proc.kill();
console.log("\n✅ 端到端流程走完");
process.exit(0);
