import { describe, expect, it } from "vitest";
import { SerialQueue } from "./queue";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("串行队列", () => {
  it("按入队顺序执行，不并发", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await wait(ms);
      order.push(`${name}:end`);
      return name;
    };
    const first = queue.enqueue(task("a", 20));
    const second = queue.enqueue(task("b", 5));
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("超时只拒绝调用方，下一个任务仍等慢任务真正结束", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    const slow = queue.enqueue(
      async () => {
        events.push("slow:start");
        await wait(60);
        events.push("slow:end");
        return "slow";
      },
      { timeoutMs: 20 },
    );
    const next = queue.enqueue(async () => {
      events.push("next:start");
      return "next";
    });

    await expect(slow).rejects.toThrow(/超时/);
    await expect(next).resolves.toBe("next");
    // 慢任务先跑完，下一个才开始：不会出现两个工具调用同时改文档
    expect(events).toEqual(["slow:start", "slow:end", "next:start"]);
  });

  it("客户端已断开时跳过排队中的任务", async () => {
    const queue = new SerialQueue();
    let alive = true;
    const first = queue.enqueue(
      async () => {
        alive = false;
        return "first";
      },
      { isAlive: () => true },
    );
    const second = queue.enqueue(async () => "should not run", { isAlive: () => alive });
    await first;
    await expect(second).rejects.toThrow(/断开/);
  });
});
