/**
 * 示例 C：日全食主题落地页。纯图形与文本，无图片、无 Token。
 *
 * 文档模型没有渐变（`Paint` 只有 token / value），所以径向光晕用「低透明度椭圆 +
 * 图层模糊 / 无偏移投影」近似；底部山脊用两块被裁剪的大椭圆。文案与配色取自
 * 一张「UMBRA / totality」落地页设计稿，尺寸按 1440×900 还原。
 */
import { createEmptyDoc } from "@sqraft/core";
import { ellipse, frame, glow, page, put, softBlur, text } from "./kit";

export const UMBRA_TITLE = "Totality example";

/** 背景星点：坐标来自设计稿，去掉最密的几颗以免抢主体。 */
const STARS: ReadonlyArray<readonly [number, number, number, number]> = [
  [900, 400, 2, 0.8],
  [120, 160, 2, 0.6],
  [560, 90, 3, 0.7],
  [1320, 140, 2, 0.8],
  [1380, 420, 2, 0.5],
  [760, 230, 2, 0.6],
  [1230, 560, 3, 0.6],
  [1060, 120, 2, 0.7],
  [380, 60, 2, 0.5],
];

const NAV = [
  ["Itinerary", 553, 80],
  ["Viewing Sites", 649, 110],
  ["Science", 779, 70],
  ["FAQ", 872, 40],
] as const;

const STATS = [
  ["4m 12s", "of totality", 80],
  ["92%", "clear-sky odds", 210.73],
  ["24 seats", "per expedition", 350.21],
] as const;

export function buildUmbraExample() {
  const doc = createEmptyDoc();
  const root = page(doc, "Totality", 900, "#070810");

  /* ---------- 背景：山脊、光晕、月亮、星点 ---------- */

  // 底部山脊：两块大椭圆放进裁剪画板，只露出顶部弧线当山丘
  const horizon = put(doc, root, frame("Horizon", { x: 0, y: 600, width: 1440, height: 300, clip: true }));
  put(doc, horizon, ellipse("Ridge far", { x: -180, y: 40, width: 1800, height: 420, fill: "#1c1630" }));
  put(doc, horizon, ellipse("Ridge near", { x: -180, y: 120, width: 1800, height: 360, fill: "#0e0b18" }));

  put(
    doc,
    root,
    ellipse("Warm glow", {
      x: 560,
      y: -60,
      width: 900,
      height: 900,
      fill: "#3a2a5a",
      opacity: 0.55,
      effects: [softBlur(70)],
    }),
  );
  put(
    doc,
    root,
    ellipse("Corona", {
      x: 760,
      y: 140,
      width: 500,
      height: 500,
      fill: "#ffb070",
      opacity: 0.3,
      effects: [softBlur(45)],
    }),
  );

  // 月亮：亮边圆 + 略小的暗盘，留出细环；右下一点高光
  put(
    doc,
    root,
    ellipse("Moon rim", {
      x: 870,
      y: 250,
      width: 280,
      height: 280,
      fill: "#fff6e6",
      effects: [glow("#ffd6a0", 38, 4)],
    }),
  );
  put(doc, root, ellipse("Moon body", { x: 876, y: 256, width: 268, height: 268, fill: "#0a0b13" }));
  put(doc, root, ellipse("Moon inner shade", { x: 906, y: 286, width: 208, height: 208, fill: "#070810" }));
  put(
    doc,
    root,
    ellipse("Diamond ring", {
      x: 1112,
      y: 262,
      width: 18,
      height: 18,
      fill: "#ffffff",
      effects: [glow("#ffffff", 20, 3)],
    }),
  );

  for (const [x, y, size, opacity] of STARS) {
    put(doc, root, ellipse(`Star ${x},${y}`, { x, y, width: size, height: size, fill: "#ffffff", opacity }));
  }

  /* ---------- 顶栏 ---------- */

  const header = put(doc, root, frame("Header", { x: 0, y: 0, width: 1440, height: 101, clip: false }));
  put(
    doc,
    header,
    ellipse("Logo dot", { x: 80, y: 41, width: 18, height: 18, fill: "#05060b", stroke: "#ffe2b0", effects: [glow("#ffc680", 10, 1)] }),
  );
  put(
    doc,
    header,
    text("Brand", "UMBRA", { x: 108, y: 40, width: 130, height: 20, fontSize: 16, fontWeight: 700, fill: "#f4eee6", letterSpacing: 4 }),
  );
  for (const [label, x, width] of NAV) {
    put(doc, header, text(`Nav · ${label}`, label, { x, y: 42, width, height: 18, fontSize: 14, fill: "#b9b3c9" }));
  }
  const reservePill = put(
    doc,
    header,
    frame("Reserve pill", { x: 1264, y: 32, width: 96, height: 37, stroke: "#ffe2b0", radius: 999, clip: false }),
  );
  put(
    doc,
    reservePill,
    text("Reserve label", "Reserve", { x: 0, y: 9, width: 96, height: 18, fontSize: 14, fontWeight: 600, fill: "#ffe2b0", align: "center" }),
  );

  /* ---------- 主视觉 ---------- */

  const hero = put(doc, root, frame("Hero", { x: 80, y: 230, width: 600, height: 500, clip: false }));
  put(doc, hero, frame("Eyebrow rule", { x: 0, y: 7, width: 32, height: 1, fill: "#ffc680", clip: false }));
  put(
    doc,
    hero,
    text("Eyebrow", "TOTALITY · AUGUST 12, 2026 · NORTHERN SPAIN", {
      x: 44,
      y: 0,
      width: 436,
      height: 16,
      fontSize: 12,
      fontWeight: 600,
      fill: "#ffc680",
      letterSpacing: 3,
    }),
  );
  put(
    doc,
    hero,
    text("Headline", "Four minutes\nwhen day\nturns to night.", {
      x: 0,
      y: 43,
      width: 600,
      height: 234,
      fontSize: 76,
      fontWeight: 700,
      fill: "#f7f1e8",
      lineHeightPercent: 102,
    }),
  );
  put(
    doc,
    hero,
    text(
      "Body",
      "Seven nights in the high plains of Castilla, chasing the moon's shadow with astronomers, dark-sky camps and front-row viewing at the centerline.",
      { x: 0, y: 300, width: 520, height: 84, fontSize: 18, fill: "#a9a3b8", lineHeightPercent: 155 },
    ),
  );

  const primary = put(
    doc,
    hero,
    frame("Reserve button", {
      x: 0,
      y: 415,
      width: 228,
      height: 55,
      fill: "#ffb45f",
      radius: 999,
      clip: false,
    }),
  );
  primary.style.effects = [glow("#ff9a50", 26, 0)];
  put(
    doc,
    primary,
    text("Reserve button label", "Reserve your spot", { x: 30, y: 16, width: 160, height: 20, fontSize: 16, fontWeight: 600, fill: "#1a0f08" }),
  );
  put(
    doc,
    primary,
    text("Reserve button arrow", "→", { x: 176, y: 13, width: 28, height: 26, fontSize: 20, fill: "#1a0f08", align: "center" }),
  );

  const secondary = put(
    doc,
    hero,
    frame("Watch button", { x: 244, y: 415, width: 198, height: 56, stroke: "#6b6478", strokeWidth: 1, radius: 999, clip: false }),
  );
  put(
    doc,
    secondary,
    text("Watch button icon", "▶", { x: 22, y: 14, width: 24, height: 26, fontSize: 15, fill: "#f4eee6", align: "center" }),
  );
  put(
    doc,
    secondary,
    text("Watch button label", "Watch the path", { x: 52, y: 17, width: 130, height: 20, fontSize: 16, fontWeight: 500, fill: "#f4eee6" }),
  );

  /* ---------- 底部数据 ---------- */

  for (const [value, label, x] of STATS) {
    put(doc, root, text(`Stat value · ${value}`, value, { x, y: 800, width: 130, height: 30, fontSize: 24, fontWeight: 700, fill: "#f7f1e8" }));
    put(doc, root, text(`Stat label · ${label}`, label, { x, y: 834, width: 130, height: 16, fontSize: 13, fill: "#8e88a0" }));
  }

  return { title: UMBRA_TITLE, state: doc };
}
