/**
 * 全局串行队列：多个 agent 同时连接时，工具调用按到达顺序执行。
 * 单次调用 30s 超时；连接已断开时直接跳过排队中的任务。
 *
 * 超时只对"调用方"生效：任务本身撤不回来，所以下一个任务必须等它真正结束，
 * 否则两个工具调用会并发改同一份文档（`DocStore.transact` 只有一个事务槽）。
 *
 * 这里打的三条日志（排队告警 / 超时 / 断连丢弃）都在"做决定的那一刻"打，
 * 上游不要再为同一原因重复记一遍。
 */
import { logWarn } from "./log";

export const CALL_TIMEOUT_MS = 30_000;
/** 排队超过这个时长才记一行 warn：几毫秒的排队是常态，记了只是噪音。 */
export const QUEUE_WARN_MS = 1_000;

/** 超时：已回给调用方，任务本身仍在跑（不会被打断）。 */
export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

/** 客户端在排队期间断开：任务不再执行。 */
export class ClientGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientGoneError";
  }
}

export interface QueueOptions {
  timeoutMs?: number;
  isAlive?: () => boolean;
  /** 日志用的会话标签（`c1 claude-code/2.1`）；缺省时不带来源。 */
  tag?: string;
  /** 排队告警阈值；测试用小值，生产用默认。 */
  queueWarnMs?: number;
}

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    const queueWarnMs = options.queueWarnMs ?? QUEUE_WARN_MS;
    const tag = options.tag ?? null;
    const queuedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armTimer = (): void => {};

    // 计时从任务真正开始算，排队时间不计入
    const timeout = new Promise<never>((_resolve, reject) => {
      armTimer = () => {
        timer = setTimeout(() => {
          logWarn(tag, `call timeout ${timeoutMs}ms`);
          reject(new QueueTimeoutError(`工具调用超时（${timeoutMs}ms）`));
        }, timeoutMs);
      };
    });

    const call = this.tail.then(async () => {
      if (options.isAlive && !options.isAlive()) {
        logWarn(tag, "call dropped: client gone");
        throw new ClientGoneError("客户端已断开，调用被丢弃");
      }
      const waited = Date.now() - queuedAt;
      if (waited > queueWarnMs) logWarn(tag, `queue wait ${waited}ms`);
      armTimer();
      try {
        return await task();
      } finally {
        if (timer) clearTimeout(timer);
      }
    });

    // 队列等任务结束，而不是等上面的 race
    this.tail = call.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([call, timeout]);
  }
}
