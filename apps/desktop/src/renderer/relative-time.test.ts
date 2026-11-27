import { describe, expect, it } from "vitest";
import { timeBucket } from "./relative-time";

/** 固定"现在"，避开跨分钟/跨天的抖动。 */
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("最近文件的相对时间分档", () => {
  it("一分钟内是「刚刚」", () => {
    expect(timeBucket(NOW - 30_000, NOW)).toEqual({ kind: "now" });
    expect(timeBucket(NOW, NOW)).toEqual({ kind: "now" });
  });

  it("未来时间不出现负数，按刚刚处理", () => {
    expect(timeBucket(NOW + 5 * MIN, NOW)).toEqual({ kind: "now" });
  });

  it("一小时内按分钟", () => {
    expect(timeBucket(NOW - 5 * MIN, NOW)).toEqual({ kind: "minutes", value: 5 });
    expect(timeBucket(NOW - 59 * MIN, NOW)).toEqual({ kind: "minutes", value: 59 });
  });

  it("一天内按小时", () => {
    expect(timeBucket(NOW - HOUR, NOW)).toEqual({ kind: "hours", value: 1 });
    expect(timeBucket(NOW - 23 * HOUR, NOW)).toEqual({ kind: "hours", value: 23 });
  });

  it("昨天单独一档，再往前按天", () => {
    expect(timeBucket(NOW - 25 * HOUR, NOW)).toEqual({ kind: "yesterday" });
    expect(timeBucket(NOW - 3 * DAY, NOW)).toEqual({ kind: "days", value: 3 });
    expect(timeBucket(NOW - 6 * DAY, NOW)).toEqual({ kind: "days", value: 6 });
  });

  it("超过一周退回日期", () => {
    const old = NOW - 10 * DAY;
    expect(timeBucket(old, NOW)).toEqual({ kind: "date", value: old });
  });
});
