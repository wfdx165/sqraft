/**
 * 欢迎页「最近打开」的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前，
 * 超过一周就退回日期（再往后"37 天前"没有信息量）。
 *
 * 分档与文案分开：`timeBucket` 是纯函数，测试不需要切语言；`relativeLabel` 只做翻译。
 */

import { locale, t } from "./i18n";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type TimeBucket =
  | { kind: "now" }
  | { kind: "minutes"; value: number }
  | { kind: "hours"; value: number }
  | { kind: "yesterday" }
  | { kind: "days"; value: number }
  | { kind: "date"; value: number };

export function timeBucket(mtimeMs: number, now = Date.now()): TimeBucket {
  const diff = Math.max(0, now - mtimeMs);
  if (diff < MINUTE) return { kind: "now" };
  if (diff < HOUR) return { kind: "minutes", value: Math.floor(diff / MINUTE) };
  if (diff < DAY) return { kind: "hours", value: Math.floor(diff / HOUR) };
  const days = Math.floor(diff / DAY);
  if (days === 1) return { kind: "yesterday" };
  if (days < 7) return { kind: "days", value: days };
  return { kind: "date", value: mtimeMs };
}

export function relativeLabel(bucket: TimeBucket): string {
  switch (bucket.kind) {
    case "now":
      return t("time.justNow");
    case "minutes":
      return t("time.minutesAgo", { count: bucket.value });
    case "hours":
      return t("time.hoursAgo", { count: bucket.value });
    case "yesterday":
      return t("time.yesterday");
    case "days":
      return t("time.daysAgo", { count: bucket.value });
    case "date":
      return new Date(bucket.value).toLocaleDateString(locale.value, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
  }
}
