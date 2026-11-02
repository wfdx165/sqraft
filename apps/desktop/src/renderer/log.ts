/**
 * 渲染层日志出口：只上报"事件 + 字段"，格式化、截断与落盘全在主进程。
 *
 * 纪律：
 * 1. 日志是旁路，任何一步失败都吞掉，绝不影响业务；
 * 2. 字段必须是可结构化克隆的纯值（不要传 Vue 代理、DOM、节点对象），
 *    所以在调用点就拆成基本类型，而不是把整个对象丢过来。
 */
import type { AppLogLevel } from "../shared/ipc";

interface LogBridge {
  log?: (level: AppLogLevel, event: string, fields?: Record<string, unknown>) => void;
}

export function logEvent(level: AppLogLevel, event: string, fields?: Record<string, unknown>): void {
  try {
    const bridge = (window as unknown as { sqraft?: { app?: LogBridge } }).sqraft;
    bridge?.app?.log?.(level, event, fields);
  } catch {
    /* 桥未就绪 / 字段不可克隆：日志放弃，业务继续 */
  }
}

export function logInfo(event: string, fields?: Record<string, unknown>): void {
  logEvent("info", event, fields);
}

export function logWarn(event: string, fields?: Record<string, unknown>): void {
  logEvent("warn", event, fields);
}

export function logError(event: string, fields?: Record<string, unknown>): void {
  logEvent("error", event, fields);
}

/** 错误栈按行拆开：单字段有 200 字符上限，整段塞进去会被截掉有用的帧。 */
function stackLines(value: unknown): string[] | undefined {
  if (!(value instanceof Error) || !value.stack) return undefined;
  return value.stack.split("\n").slice(0, 12);
}

/**
 * 接管未捕获错误与未处理的 Promise 拒绝。
 * 只装一次：dev 热更新会重新执行入口模块，重复注册会让同一错误记多遍。
 */
export function installRendererErrorLog(): void {
  const marker = globalThis as { __sqraftErrorLog?: boolean };
  if (marker.__sqraftErrorLog) return;
  marker.__sqraftErrorLog = true;

  window.addEventListener("error", (event) => {
    logError("uncaught error", {
      message: event.message || String(event.error),
      source: `${event.filename}:${event.lineno}:${event.colno}`,
      stack: stackLines(event.error),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    logError("unhandled rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: stackLines(reason),
    });
  });
}
