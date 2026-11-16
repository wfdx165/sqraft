/**
 * 同客户端的写操作串行化：两个入口同时点「接入」时，不能让它们各自读写同一份配置。
 * 只保证顺序，不合并任务；前一个失败不阻塞后一个。
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
