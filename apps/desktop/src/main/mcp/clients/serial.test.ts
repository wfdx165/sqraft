import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./serial";

describe("写操作串行化", () => {
  it("按提交顺序执行，不并发", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    let active = 0;
    const task = (name: string) => async () => {
      active += 1;
      expect(active).toBe(1);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}:end`);
      active -= 1;
    };
    await Promise.all([queue(task("a")), queue(task("b")), queue(task("c"))]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("前一个失败不阻塞后一个", async () => {
    const queue = createSerialQueue();
    const failed = queue(async () => {
      throw new Error("boom");
    });
    const next = queue(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
