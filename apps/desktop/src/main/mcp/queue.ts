/**
 * 全局串行队列：多个 agent 同时连接时，工具调用按到达顺序执行。
 * 单次调用 30s 超时；连接已断开时直接跳过排队中的任务。
 *
 * 超时只对"调用方"生效：任务本身撤不回来，所以下一个任务必须等它真正结束，
 * 否则两个工具调用会并发改同一份文档（`DocStore.transact` 只有一个事务槽）。
 */
export const CALL_TIMEOUT_MS = 30_000;

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>, options: { timeoutMs?: number; isAlive?: () => boolean } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armTimer = (): void => {};

    // 计时从任务真正开始算，排队时间不计入
    const timeout = new Promise<never>((_resolve, reject) => {
      armTimer = () => {
        timer = setTimeout(() => reject(new Error(`工具调用超时（${timeoutMs}ms）`)), timeoutMs);
      };
    });

    const call = this.tail.then(async () => {
      if (options.isAlive && !options.isAlive()) {
        throw new Error("客户端已断开，调用被丢弃");
      }
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
