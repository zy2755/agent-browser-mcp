# agent-browser-mcp

给 AI agent 用的可靠浏览器控制 MCP server。针对现有浏览器工具的两大痛点专门设计:

- **点不了网页内容** → 语义快照 + ref 编号定位 + 多级兜底(见下文"点击是怎么解决的")
- **频繁断联出错** → 常驻进程 + 崩溃懒重启 + 会话恢复(见下文"断联是怎么解决的")

技术栈:Node + TypeScript + playwright-core(免下载浏览器,直接驱动系统已装的 Chrome/Edge)。

## 接入 MCP 客户端

server 走 stdio,任何支持 stdio MCP 的客户端都能接。先 `npm install && npm run build`,再把 `dist/index.js` 的**绝对路径**填进客户端配置(GUI 应用常不继承 shell 的工作目录,相对路径容易解析失败)。

### 通用配置

```json
{
  "mcpServers": {
    "agent-browser-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/agent-browser-mcp/dist/index.js"]
    }
  }
}
```

若客户端启动时拿不到 shell 的 `PATH`,把 `command` 换成 node 可执行文件的完整路径,如 `/usr/local/bin/node` 或 `C:\\Program Files\\nodejs\\node.exe`。

### Claude Desktop

配置文件位置:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agent-browser-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\agent-browser-mcp\\dist\\index.js"]
    }
  }
}
```

写完后**完全退出并重启**客户端(macOS 需从菜单栏退出,只关窗口不会重载配置)。Claude Code / Cline / Cursor / OpenClaw 等同样用这份 `mcpServers` 结构,只是配置文件位置不同。

### 启动参数

需要调整浏览器行为时,直接往 `args` 追加命令行参数:

```json
"args": ["/absolute/path/to/dist/index.js", "--headless", "--channels", "msedge"]
```

完整参数见 `node dist/index.js --help`。更推荐把常用项固化到 `~/.browser-mcp/config.json`(见下文「配置」),这样多个客户端共用一份配置。

## 构建

```bash
npm install
npm run build     # 产物在 dist/
npm run smoke     # 冒烟测试(40 项,会真实启动 Chrome)
npm run serve:fixtures   # 本地测试页(手动调试用)
```

## 工具集(14 个)

| 工具 | 说明 |
|---|---|
| `browser_navigate(url)` | 导航,**自动附交互元素快照** |
| `browser_snapshot` | 语义快照;`filter:"interactive"` 只看交互元素,`rootRef` 只看某元素子树 |
| `browser_click(ref)` | 点击;点击后自动附新快照;失效 ref 自动重解析 |
| `browser_type(ref, text)` | 输入(先清空);`submit:true` 回车提交 |
| `browser_press_key(key)` | 按键,如 `Enter` / `Escape` / `Control+a` |
| `browser_select_option(ref, values)` | 下拉选择,value/label 自动两轮匹配 |
| `browser_hover(ref)` | 悬停(触发悬浮菜单) |
| `browser_scroll(direction, amount, ref?)` | 滚动页面或指定滚动容器 |
| `browser_screenshot` | 截屏,返回图片 + 落盘 |
| `browser_evaluate(js)` | 逃生舱:页面内执行 JS |
| `browser_wait` | 等待:时长 / 文本出现 / 元素出现 / URL 变化 / 网络空闲 |
| `browser_tabs` | 多标签管理:list / new / select / close |
| `browser_get_info` | 健康状态、标签列表、重启次数、最近错误 |
| `browser_close` | 关闭浏览器(profile 登录态保留) |

**ref 的用法**:快照里每个可交互元素带 `[eN]` 编号,`browser_click({ ref: "e42" })` 直接引用。iframe 内元素拍平进同一棵树,编号同样可用。

## 点击是怎么解决的

1. **语义快照**:in-page DOM 遍历(无障碍角色 + 可访问名 + cursor:pointer 启发式),穿透 **open shadow DOM**,跨源 **iframe 内容拍平**进同一棵树;
2. **ref → 定位配方**:每个 ref 同时记录 css 路径(有 id 锚定 + nth-of-type,frame 内唯一)和 role+name 语义描述;
3. **解析兜底链**:cssPath → getByRole 精确 → getByRole 模糊 → getByText,任何一层命中都验证后使用;
4. **绝不死路**:ref 彻底失效时报错信息里直接给出行动建议(重新快照 / 先等待),不会让 agent 卡死。

## 断联是怎么解决的

- **进程模型**:MCP server 本身就是常驻 daemon(stdio 客户端会长期持有),浏览器经 **CDP pipe**(非 websocket 端口)启动,无端口冲突;
- **懒重启**:每次工具调用前健康检查(`browser.isConnected()`);浏览器被手动关闭/崩溃后,下一次调用自动重启并**恢复所有标签页**,结果中明确提示"旧 ref 已失效";
- **孤儿清理**:profile 被残留进程占用时,启动前按 profile 路径定向 taskkill,再重试;
- **悬挂护栏**:所有 Playwright 调用套 `withTimeout`,浏览器僵死时调用能超时返回而不是永久卡住;
- **全链路日志**:`~/.browser-mcp/logs/server-YYYYMMDD.log`(2MB 轮转,保留 3 份),`browser_get_info` 可查最近错误与重启次数。

## 浏览器来源(双模式)

- **launch 模式(默认)**:启动专用 Chrome,profile 在 `~/.browser-mcp/profile` —— 登录态持久保存,重启不丢。首次用某网站需在此 profile 登录一次。
- **connect 模式**:接管已开调试端口的现有浏览器,退出时不杀它:

```bash
# 先手动带调试端口启动 Chrome
chrome.exe --remote-debugging-port=9222
# server 端
node dist/index.js --connect          # 默认 http://127.0.0.1:9222
node dist/index.js --cdp-url http://127.0.0.1:9223
```

## 配置

优先级:命令行参数 > 环境变量(`BROWSER_MCP_*`)> `~/.browser-mcp/config.json` > 内置默认。

常用参数:`--headless`(无头)/ `--profile <dir>` / `--channels chrome,msedge` / `--executable <path>` / `--viewport 1440x900` / `--start-url <url>` / `--dialogs accept|dismiss`(对话框自动处理策略,默认 accept)。

完整参数见 `node dist/index.js --help`。

## 目录结构

```
src/
  index.ts           入口:stdio server、优雅退出
  config.ts          配置解析(文件/环境变量/命令行)
  browserManager.ts  浏览器生命周期:启动/健康检查/懒重启/会话恢复/弹窗对话框下载
  session.ts         标签页登记与持久化(原子写)
  snapshot.ts        in-page DOM walker + ref 注册表 + frame 拼接 + 渲染
  actions.ts         ref 解析兜底链 + 各类动作实现
  tools.ts           14 个 MCP 工具定义与接线
  errors.ts          错误整形(结构化 code + 行动建议)
  util.ts            日志(轮转)/超时护栏/截断
test/
  fixtures/          本地测试页(基础/shadow/跨源iframe/对话框/懒加载)
  serve.mjs          fixture 服务器
  smoke.mjs          40 项冒烟测试(含杀进程恢复、server 重启恢复)
  e2e-baidu.mjs      真实互联网端到端(百度搜索全流程)
```

## 安全提示

- 专用 profile 存有登录态(Cookies),等同于你的浏览器身份,注意不要把 `~/.browser-mcp/profile` 提交到任何仓库;
- 工具会自动接受页面对话框(默认策略),agent 无法处理验证码/支付类强交互,这些仍需人工;
- 日志可能包含页面 URL(含查询参数),排查问题后注意清理。

## 二期 backlog

文件上传、下载管理增强、请求拦截、Cookie/存储管理、PDF 导出、CLI 前端。

## 许可证

Apache-2.0,见 [LICENSE](LICENSE)。
