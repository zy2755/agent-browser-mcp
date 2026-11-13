// 冒烟测试:起 fixture 服务器 + 以子进程方式拉起 MCP server,走 stdio JSON-RPC 全流程验证。
// 覆盖:握手/工具清单/导航/快照/点击/输入/下拉/勾选/evaluate/shadow DOM/跨源 iframe/对话框/
//       懒加载等待/截图/stale-ref 语义重解析/杀进程自动恢复/多标签管理/关闭。
import { spawn, execFile } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtures, stopFixtures } from "./serve.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(__dirname, ".tmp-smoke");
const PORT = 8899;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function refOf(snapshotText, regex) {
  const m = snapshotText.match(regex);
  return m ? m[1] : null;
}

// ---------- 极简 MCP stdio 客户端 ----------
class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => process.env.SMOKE_DEBUG && process.stderr.write("[server:err] " + c));
  }
  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }
  call(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用 ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  textOf(result) {
    const block = result.content?.find((c) => c.type === "text");
    return block ? block.text : "";
  }
  callText(name, args, timeoutMs) {
    return this.call("tools/call", { name, arguments: args }, timeoutMs).then((r) => this.textOf(r));
  }
}

function toolText(result) {
  const block = result.content?.find((c) => c.type === "text");
  return block ? block.text : "";
}

async function main() {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });

  await startFixtures();
  console.log(`fixtures ready on ${BASE}`);

  const serverProc = spawn(
    process.execPath,
    [
      path.join(ROOT, "dist", "index.js"),
      "--state-dir", STATE,
      "--profile", path.join(STATE, "profile"),
      "--channels", "chrome,msedge",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const client = new McpClient(serverProc);
  const exitPromise = new Promise((resolve) => serverProc.on("exit", (code) => resolve(code)));

  try {
    // ---- 握手 ----
    console.log("\n== 握手与工具清单 ==");
    const init = await client.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    });
    check("initialize 返回 serverInfo", !!init.serverInfo?.name);
    client.notify("notifications/initialized");

    const tools = await client.call("tools/list", {});
    const names = tools.tools.map((t) => t.name);
    const expectTools = [
      "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
      "browser_press_key", "browser_select_option", "browser_hover", "browser_scroll",
      "browser_screenshot", "browser_evaluate", "browser_wait", "browser_tabs",
      "browser_get_info", "browser_close",
    ];
    check("工具清单完整(14 个)", expectTools.every((n) => names.includes(n)), `实际: ${names.join(",")}`);

    // ---- get_info 不启动浏览器 ----
    const info0 = JSON.parse(await client.callText("browser_get_info", {}));
    check("get_info 在未启动时返回 stopped", info0.state === "stopped");

    // ---- 导航 + 快照 ----
    console.log("\n== 导航 / 快照 / 点击 / 输入 ==");
    const nav1 = await client.callText("browser_navigate", { url: `${BASE}/basic.html` });
    check("navigate 报告打开成功", nav1.includes("已打开") && nav1.includes("basic.html"), nav1.slice(0, 200));
    check("navigate 自动附快照且含 ref", /\[e\d+\]/.test(nav1));

    const loginRef = refOf(nav1, /\[(e\d+)\] button "登录"/);
    const userRef = refOf(nav1, /\[(e\d+)\] textbox "用户名"/);
    const cityRef = refOf(nav1, /\[(e\d+)\] combobox/);
    const rememberRef = refOf(nav1, /\[(e\d+)\] checkbox/);
    check("快照识别出登录按钮 ref", !!loginRef);
    check("快照识别出用户名输入框 ref", !!userRef);
    check("快照识别出下拉框 ref", !!cityRef);
    check("快照识别出复选框 ref", !!rememberRef);

    // 点击前先输入
    const typeRes = await client.callText("browser_type", { ref: userRef, text: "agent_user" });
    check("type 成功并回显", typeRes.includes("已输入"));

    const click1 = await client.callText("browser_click", { ref: loginRef });
    check("点击后自动快照显示登录成功", click1.includes("登录成功 #1"), click1.slice(0, 300));
    check("点击后快照显示输入值", click1.includes("agent_user"));

    // 下拉选择(按 label)
    const selRes = await client.callText("browser_select_option", { ref: cityRef, values: ["上海"] });
    check("select_option 按 label 选中", selRes.includes("已选中") && selRes.includes("上海"), selRes.slice(0, 200));

    // 复选框
    await client.callText("browser_click", { ref: rememberRef, snapshot: false });
    const snapCk = await client.callText("browser_snapshot", { filter: "interactive" });
    check("checkbox 点击后显示已勾选", snapCk.includes("已勾选"));

    // evaluate
    const evalRes = await client.callText("browser_evaluate", { js: "() => document.title" });
    check("evaluate 返回页面标题", evalRes.includes("基础测试页"), evalRes.slice(0, 120));

    // ---- shadow DOM ----
    console.log("\n== Shadow DOM ==");
    const navSh = await client.callText("browser_navigate", { url: `${BASE}/shadow.html` });
    const shBtnRef = refOf(navSh, /\[(e\d+)\] button "shadow 按钮"/);
    const shInputRef = refOf(navSh, /\[(e\d+)\] textbox.*shadow 输入框/);
    check("快照穿透 shadow DOM 识别按钮", !!shBtnRef, navSh.slice(0, 400));
    check("快照穿透 shadow DOM 识别输入框", !!shInputRef);
    if (shInputRef && shBtnRef) {
      await client.callText("browser_type", { ref: shInputRef, text: "穿透成功" });
      const shClick = await client.callText("browser_click", { ref: shBtnRef });
      check("shadow 按钮可点击", shClick.includes("shadow 点击 1 次"), shClick.slice(0, 300));
    }

    // ---- 跨源 iframe ----
    console.log("\n== 跨源 iframe ==");
    const navIf = await client.callText("browser_navigate", { url: `${BASE}/iframe.html` });
    check("iframe 内容拍平进快照", navIf.includes("iframe → http://127.0.0.1:8899/child.html"), navIf.slice(0, 400));
    const childBtnRef = refOf(navIf, /\[(e\d+)\] button "iframe 内按钮"/);
    check("快照识别出 iframe 内按钮", !!childBtnRef);
    if (childBtnRef) {
      const ifClick = await client.callText("browser_click", { ref: childBtnRef });
      check("iframe 内按钮可点击", ifClick.includes("已点击"), ifClick.slice(0, 400));
      const ifStatus = await client.callText("browser_evaluate", { js: "() => document.getElementById('parent-status').textContent" });
      check("iframe→父页 postMessage 到达", ifStatus.includes("iframe按钮被点了"));
    }

    // ---- 对话框自动处理 ----
    console.log("\n== 对话框 ==");
    const navDlg = await client.callText("browser_navigate", { url: `${BASE}/dialog.html` });
    const alertRef = refOf(navDlg, /\[(e\d+)\] button "触发 alert"/);
    const dlgClick = await client.callText("browser_click", { ref: alertRef, snapshot: false });
    check("alert 被自动接受并上报", dlgClick.includes("对话框") && dlgClick.includes("这是一个警告对话框"), dlgClick.slice(0, 300));

    // confirm → accept 路径
    const confirmRef = refOf(navDlg, /\[(e\d+)\] button "触发 confirm"/);
    const confirmClick = await client.callText("browser_click", { ref: confirmRef, snapshot: false });
    const confirmEval = await client.callText("browser_evaluate", { js: "() => document.getElementById('confirm-result').textContent" });
    check("confirm 接受后结果正确", confirmEval.includes("确认了"), confirmEval.slice(0, 120));

    // ---- 懒加载 + wait ----
    console.log("\n== 懒加载与等待 ==");
    const lazyRef = refOf(navDlg, /\[(e\d+)\] button "加载延迟内容"/);
    await client.callText("browser_click", { ref: lazyRef, snapshot: false });
    const waitRes = await client.callText("browser_wait", { text: "延迟出现的按钮", timeoutMs: 8000 });
    check("wait 等到懒加载文本", waitRes.includes("等待文本出现"), waitRes.slice(0, 200));
    const snapLazy = await client.callText("browser_snapshot", {});
    const lazyTargetRef = refOf(snapLazy, /\[(e\d+)\] button "延迟出现的按钮"/);
    check("懒加载元素出现在新快照", !!lazyTargetRef);

    // ---- stale ref 语义重解析 ----
    console.log("\n== stale-ref 语义重解析 ==");
    // 回到 basic 页
    await client.callText("browser_navigate", { url: `${BASE}/basic.html`, snapshot: false });
    const snap2 = await client.callText("browser_snapshot", {});
    const loginRef2 = refOf(snap2, /\[(e\d+)\] button "登录"/);
    // 破坏结构:去掉按钮自身的 id(登录按钮的 cssPath 锚定在 #login-btn 上),让 cssPath 彻底失效
    await client.callText("browser_evaluate", { js: "() => document.getElementById('login-btn').removeAttribute('id')" });
    const reClick = await client.callText("browser_click", { ref: loginRef2 });
    check("cssPath 失效后自动按 role+name 重解析", reClick.includes("重解析"), reClick.slice(0, 500));
    check("重解析后点击成功", reClick.includes("登录成功 #"), reClick.slice(0, 500));

    // ---- 截图 ----
    console.log("\n== 截图 ==");
    const shot = await client.call("tools/call", { name: "browser_screenshot", arguments: {} });
    const imgBlock = shot.content?.find((c) => c.type === "image");
    check("截图返回 image 内容块", !!imgBlock && imgBlock.data?.length > 1000);
    const shotText = toolText(shot);
    check("截图落盘并返回路径", shotText.includes("截图已保存"));

    // ---- 杀进程 → 自动恢复 ----
    console.log("\n== 杀进程自动恢复 ==");
    const infoPids = JSON.parse(await client.callText("browser_get_info", {}));
    check("启动后记录了浏览器进程 pid", Array.isArray(infoPids.browserPids) && infoPids.browserPids.length > 0, JSON.stringify(infoPids.browserPids));
    const killPs = infoPids.browserPids.map((pid) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue;`).join(" ");
    await new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", killPs], () => resolve());
    });
    await sleep(1500);
    const infoCrash = JSON.parse(await client.callText("browser_get_info", {}));
    check("杀进程后状态变为 crashed", infoCrash.state === "crashed", `state=${infoCrash.state}`);

    const navRecover = await client.callText("browser_navigate", { url: `${BASE}/basic.html` });
    check("下次调用自动重启", navRecover.includes("自动重启"), navRecover.slice(0, 300));
    check("重启后新快照正常", /\[e\d+\]/.test(navRecover));

    // ---- 多标签 ----
    console.log("\n== 多标签管理 ==");
    await client.callText("browser_tabs", { action: "new", url: `${BASE}/second.html` });
    const tabList = await client.callText("browser_tabs", { action: "list" });
    check("列出 2 个标签", tabList.includes("2 个标签页") && tabList.includes("second.html"), tabList.slice(0, 300));
    await client.callText("browser_tabs", { action: "select", index: 0 });
    const infoTabs = JSON.parse(await client.callText("browser_get_info", {}));
    check("切换激活标签", infoTabs.tabs.find((t) => t.index === 0)?.active === true);
    await client.callText("browser_tabs", { action: "close", index: 1 });
    const tabList2 = await client.callText("browser_tabs", { action: "list" });
    check("关闭后剩 1 个标签", tabList2.includes("1 个标签页"));

    // ---- 会话恢复持久化验证:重启 MCP server 本身 ----
    console.log("\n== MCP server 重启后会话恢复 ==");
    serverProc.kill();
    const exitCode = await Promise.race([exitPromise, sleep(5000).then(() => "no-exit")]);
    check("server 正常退出", exitCode === 0 || exitCode === null, String(exitCode));

    const serverProc2 = spawn(
      process.execPath,
      [
        path.join(ROOT, "dist", "index.js"),
        "--state-dir", STATE,
        "--profile", path.join(STATE, "profile"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const client2 = new McpClient(serverProc2);
    try {
      await client2.call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke2", version: "0.0.0" },
      });
      client2.notify("notifications/initialized");
      const navRestore = await client2.callText("browser_navigate", { url: `${BASE}/dialog.html` });
      check("重启后浏览器可用(登录态 profile 保留)", navRestore.includes("已打开") || navRestore.includes("专用浏览器"), navRestore.slice(0, 200));
      const snapFinal = await client2.callText("browser_snapshot", { filter: "interactive" });
      check("最终快照正常出 ref", /\[e\d+\]/.test(snapFinal));
      await client2.callText("browser_close", {});
    } finally {
      serverProc2.kill();
      await sleep(800);
    }
  } catch (e) {
    failed++;
    failures.push("未预期的异常: " + e.message);
    console.error("\n💥 未预期异常:", e);
  } finally {
    stopFixtures();
    serverProc.kill();
  }

  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  if (failures.length) {
    console.log("失败项:", failures.join(" | "));
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
