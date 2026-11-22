/**
 * 示例 C：日全食主题落地页（UMBRA）。
 *
 * 纯图形与文本，无图片、无 Token：背景、紫雾、日冕、月影、按钮与山脚渐隐都用
 * 原生渐变；两条山脊直接使用设计稿的 SVG 路径（单轮廓，导入成可编辑 path）。
 * 尺寸按 1440×900 还原，文案与配色取自同一张设计稿。
 */
import { createEmptyDoc } from "@sqraft/core";
import { ellipse, frame, glow, linear, page, pathFromD, put, radial, shadow, text } from "./kit";

export const UMBRA_TITLE = "Totality example";

const SANS = '"Geist Variable", "Inter", system-ui, sans-serif';
const SERIF = '"Playfair Display", Georgia, serif';

/** 背景星点：[x, y, 直径, 不透明度, 颜色]。 */
const STARS: ReadonlyArray<readonly [number, number, number, number, string]> = [
  [900, 400, 2, 0.8, "#ffffff"],
  [120, 160, 2, 0.6, "#ffffff"],
  [560, 90, 3, 0.7, "#ffffff"],
  [1320, 140, 2, 0.8, "#ffffff"],
  [1380, 420, 2, 0.5, "#ffffff"],
  [760, 230, 2, 0.6, "#cfe0ff"],
  [1230, 560, 3, 0.6, "#ffffff"],
  [680, 470, 2, 0.4, "#ffffff"],
  [1060, 120, 2, 0.7, "#ffffff"],
  [380, 60, 2, 0.5, "#ffffff"],
];

const NAV = [
  ["Itinerary", 552],
  ["Viewing Sites", 648],
  ["Science", 779],
  ["FAQ", 872],
] as const;

const STATS = [
  ["4m 12s", "of totality", 80],
  ["92%", "clear-sky odds", 210],
  ["24 seats", "per expedition", 350],
] as const;

/** 远山：设计稿里的原始路径（viewBox 0 600 1440 210.03）。 */
const RIDGE_FAR =
  "M0,770.03 L180,660.03 C225,675.03 282.81,714.84 330,710.03 C395.52,703.35 454.17,602.04 520,600.03 " +
  "C580.35,598.18 639.69,687.23 700,690.03 C757.88,692.72 822.08,618.66 880,620.03 " +
  "C939.08,621.43 1000.92,698.63 1060,700.03 C1117.92,701.4 1186,651.03 1240,630.03 " +
  "L1440,720.03 L1440,810.03 L0,810.03 L0,770.03 Z";

/** 近山（viewBox 0 680 1440 160.02）。 */
const RIDGE_NEAR =
  "M0,790.02 L240,700.02 C306,721.02 390.76,771.78 460,770.02 C536.87,768.07 623.12,681.44 700,680.02 " +
  "C775.88,678.62 864.12,758.58 940,760.02 C1014.99,761.44 1108,711.02 1180,690.02 " +
  "L1440,770.02 L1440,840.02 L0,840.02 L0,790.02 Z";

export function buildUmbraExample() {
  const doc = createEmptyDoc();
  const root = page(doc, "Totality", 900);
  // 页面底色：夜间渐层（顶部近黑 → 中段深蓝 → 底部带一点紫）
  root.style.fill = linear({ x: 0.5, y: 0 }, { x: 0.5, y: 1 }, [
    [0, "#05060b"],
    [0.5, "#0b0d1a"],
    [1, "#1a1022"],
  ]);

  /* ---------- 背景：紫雾、暖晕、星点 ---------- */

  put(
    doc,
    root,
    ellipse("Night haze", {
      x: 331,
      y: 0,
      width: 1296,
      height: 720,
      fill: radial({ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, [
        [0, "rgba(58, 42, 90, 0.55)"],
        [1, "rgba(58, 42, 90, 0)"],
      ]),
    }),
  );
  put(
    doc,
    root,
    ellipse("Warm halo", {
      x: 660,
      y: 40,
      width: 700,
      height: 700,
      fill: radial({ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, [
        [0, "rgba(255, 176, 112, 0.35)"],
        [0.35, "rgba(255, 122, 61, 0.12)"],
        [1, "rgba(58, 42, 90, 0)"],
      ]),
    }),
  );

  /* ---------- 日食：日冕、太阳、月影、钻石环 ---------- */

  put(
    doc,
    root,
    ellipse("Corona", {
      x: 810,
      y: 190,
      width: 400,
      height: 400,
      fill: radial({ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, [
        [0, "#ffffff"],
        [0.6, "rgba(255, 241, 214, 0.9)"],
        [0.72, "rgba(255, 198, 128, 0.45)"],
        [1, "rgba(255, 138, 74, 0)"],
      ]),
    }),
  );
  put(
    doc,
    root,
    ellipse("Sun", {
      x: 870,
      y: 250,
      width: 280,
      height: 280,
      fill: "#fff6e6",
      effects: [glow("#ffe2b0", 30)],
    }),
  );
  put(
    doc,
    root,
    ellipse("Moon", {
      x: 873,
      y: 253,
      width: 274,
      height: 274,
      fill: radial({ x: 0.4, y: 0.35 }, { x: 1, y: 0.35 }, [
        [0, "#0b0c14"],
        [1, "#020205"],
      ]),
    }),
  );
  put(
    doc,
    root,
    ellipse("Diamond ring", {
      x: 1112,
      y: 262,
      width: 18,
      height: 18,
      fill: "#ffffff",
      effects: [glow("#ffffff", 24), glow("#ffd6a0", 60)],
    }),
  );

  for (const [x, y, size, opacity, color] of STARS) {
    put(doc, root, ellipse(`Star ${x},${y}`, { x, y, width: size, height: size, fill: color, opacity }));
  }

  /* ---------- 地形 ---------- */

  put(
    doc,
    root,
    pathFromD("Ridge far", RIDGE_FAR, {
      fill: linear({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, "#1c1630"],
        [1, "#0a0912"],
      ]),
    }),
  );
  put(
    doc,
    root,
    pathFromD("Ridge near", RIDGE_NEAR, {
      fill: linear({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, "#0e0b18"],
        [1, "#040408"],
      ]),
    }),
  );
  put(
    doc,
    root,
    frame("Horizon scrim", {
      x: 0,
      y: 700,
      width: 1440,
      height: 200,
      fill: linear({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, "rgba(5, 6, 11, 0)"],
        [1, "#05060b"],
      ]),
    }),
  );

  /* ---------- 顶栏 ---------- */

  put(
    doc,
    root,
    ellipse("Logo dot", {
      x: 80,
      y: 41,
      width: 18,
      height: 18,
      fill: "#05060b",
      stroke: "#ffe2b0",
      effects: [glow("#ffc680", 10)],
    }),
  );
  put(
    doc,
    root,
    text("Brand", "UMBRA", {
      x: 108,
      y: 40,
      width: 90,
      height: 20,
      fontSize: 16,
      fontWeight: 700,
      fill: "#f4eee6",
      letterSpacing: 4,
      fontFamily: SANS,
    }),
  );
  for (const [label, x] of NAV) {
    put(doc, root, text(`Nav · ${label}`, label, {
      x,
      y: 42,
      width: 120,
      height: 18,
      fontSize: 14,
      fontWeight: 500,
      fill: "#b9b3c9",
      fontFamily: SANS,
    }));
  }
  // Reserve 胶囊：只要描边，不填底
  put(doc, root, frame("Reserve pill", {
    x: 1264,
    y: 32,
    width: 96,
    height: 37,
    stroke: "#ffe2b0",
    radius: 18.5,
    clip: false,
  }));
  put(doc, root, text("Reserve label", "Reserve", {
    x: 1284,
    y: 41,
    width: 60,
    height: 18,
    fontSize: 14,
    fontWeight: 600,
    fill: "#ffe2b0",
    fontFamily: SANS,
  }));

  /* ---------- 主视觉 ---------- */

  put(doc, root, frame("Eyebrow rule", { x: 80, y: 237, width: 32, height: 1, fill: "#ffc680", clip: false }));
  put(
    doc,
    root,
    text("Eyebrow", "TOTALITY · AUGUST 12, 2026 · NORTHERN SPAIN", {
      x: 124,
      y: 230,
      width: 420,
      height: 16,
      fontSize: 12,
      fontWeight: 600,
      fill: "#ffc680",
      letterSpacing: 3,
      fontFamily: SANS,
    }),
  );
  put(
    doc,
    root,
    text("Headline", "Four minutes\nwhen day\nturns to night.", {
      x: 80,
      y: 273,
      width: 620,
      height: 234,
      fontSize: 76,
      fontWeight: 700,
      fill: "#f7f1e8",
      lineHeightPercent: 102,
      fontFamily: SERIF,
    }),
  );
  put(
    doc,
    root,
    text(
      "Body",
      "Seven nights in the high plains of Castilla, chasing the moon's shadow with astronomers, dark-sky camps and front-row viewing at the centerline.",
      {
        x: 80,
        y: 533,
        width: 520,
        height: 84,
        fontSize: 18,
        fill: "#a9a3b8",
        lineHeightPercent: 155,
        fontFamily: SANS,
      },
    ),
  );

  put(
    doc,
    root,
    frame("Reserve button", {
      x: 80,
      y: 645,
      width: 228,
      height: 55,
      radius: 27.5,
      clip: false,
      fill: linear({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, [
        [0, "#ffe2b0"],
        [1, "#ffa866"],
      ]),
      effects: [shadow(0, 8, 32, "rgba(255, 154, 80, 0.4)")],
    }),
  );
  put(
    doc,
    root,
    text("Reserve button label", "Reserve your spot", {
      x: 110,
      y: 663,
      width: 150,
      height: 20,
      fontSize: 16,
      fontWeight: 600,
      fill: "#1a0f08",
      fontFamily: SANS,
    }),
  );
  put(
    doc,
    root,
    text("Reserve button arrow", "→", {
      x: 258,
      y: 661,
      width: 20,
      height: 24,
      fontSize: 18,
      fontWeight: 600,
      fill: "#1a0f08",
      fontFamily: SANS,
    }),
  );

  put(doc, root, frame("Watch button", {
    x: 324,
    y: 645,
    width: 198,
    height: 56,
    stroke: "rgba(255, 255, 255, 0.25)",
    radius: 28,
    clip: false,
  }));
  put(doc, root, ellipse("Watch icon ring", {
    x: 350,
    y: 663,
    width: 20,
    height: 20,
    stroke: "#f4eee6",
    strokeWidth: 1.5,
  }));
  put(doc, root, pathFromD("Watch icon play", "M358,668 L358,678 L367,673 Z", { fill: "#f4eee6" }));
  put(
    doc,
    root,
    text("Watch button label", "Watch the path", {
      x: 380,
      y: 663,
      width: 130,
      height: 20,
      fontSize: 16,
      fontWeight: 500,
      fill: "#f4eee6",
      fontFamily: SANS,
    }),
  );

  /* ---------- 底部数据 ---------- */

  for (const [value, label, x] of STATS) {
    put(doc, root, text(`Stat value · ${value}`, value, {
      x,
      y: 800,
      width: 130,
      height: 30,
      fontSize: 24,
      fontWeight: 700,
      fill: "#f7f1e8",
      fontFamily: SANS,
    }));
    put(doc, root, text(`Stat label · ${label}`, label, {
      x,
      y: 833,
      width: 130,
      height: 16,
      fontSize: 13,
      fill: "#8e88a0",
      fontFamily: SANS,
    }));
  }

  return { title: UMBRA_TITLE, state: doc };
}
