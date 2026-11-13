// 本地 fixture 服务器:127.0.0.1:8899(iframe.html 里引用 127.0.0.1,主页面用 localhost 打开 → 天然跨源 iframe)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const PORT = Number(process.env.FIXTURE_PORT ?? 8899);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const file = path.join(FIXTURES, url.pathname === "/" ? "basic.html" : url.pathname.replace(/^\//, ""));
    if (!file.startsWith(FIXTURES)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("fixture not found");
  }
});

export function startFixtures() {
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve(PORT));
  });
}

export function stopFixtures() {
  server.close();
}

// 直接运行时启动(供手动调试)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startFixtures().then((p) => console.log(`fixtures on http://127.0.0.1:${p}/basic.html`));
}
