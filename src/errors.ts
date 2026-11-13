// 错误整形:把底层异常翻译成 agent 能直接行动的结构化信息
import { log } from "./util.js";

export type ToolErrorShape = {
  code: string;
  message: string;
  hint?: string;
};

export class ToolError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function shapeError(e: unknown): ToolErrorShape {
  if (e instanceof ToolError) {
    return { code: e.code, message: e.message, hint: e.hint };
  }
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const msg = raw.slice(0, 500);
  void log("error", "action failed", raw);

  if (/Timeout.*exceeded|TimeoutError/i.test(raw)) {
    return {
      code: "timeout",
      message: msg,
      hint: "元素未出现或不可操作。常见原因:①页面还在加载,先调 browser_wait;②元素在 iframe 里,用 browser_snapshot 查看最新结构;③选择器过期,重新 browser_snapshot 拿最新 ref。",
    };
  }
  if (/Target closed|Target page, context or browser has been closed|Browser closed|browser has been closed/i.test(raw)) {
    return {
      code: "browser_closed",
      message: msg,
      hint: "浏览器连接已断开(可能被手动关闭或崩溃)。下次工具调用会自动重启浏览器并恢复会话,直接重试即可;旧 ref 已全部失效,请重新 browser_snapshot。",
    };
  }
  if (/EBUSY|EPERM|accessdenied|singleton/i.test(raw)) {
    return {
      code: "profile_locked",
      message: msg,
      hint: "profile 目录被占用(可能有残留 Chrome 进程)。系统会尝试清理后重试;若仍失败,请手动关闭使用该 profile 的 Chrome。",
    };
  }
  if (/Execution context was destroyed|navigation/i.test(raw)) {
    return {
      code: "page_navigated",
      message: msg,
      hint: "操作过程中页面发生了跳转。请重新 browser_snapshot 后用新 ref 重试。",
    };
  }
  return {
    code: "unknown",
    message: msg,
    hint: "未知错误。可调用 browser_get_info 查看浏览器健康状态,或重新 browser_snapshot 获取当前页面。",
  };
}
