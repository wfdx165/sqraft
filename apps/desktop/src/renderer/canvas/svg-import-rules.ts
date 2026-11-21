/**
 * SVG 导入的纯判断：哪些标签忽略 / 当透明容器，`use` 与嵌套 `svg` 的视口变换。
 *
 * 这里不碰 DOM——只处理标签名与数字，便于在 Node 下测试；
 * DOM 遍历、坐标落点与栅格化留在 `svg-import.ts`。
 */

import { DROP_SVG_TAGS } from "./svg-sanitize";

/** 2×3 仿射矩阵：[a b c d e f]，与 SVG matrix() 同序。 */
export type Mat = [number, number, number, number, number, number];

/**
 * 只丢弃、不报错：可执行内容、外部嵌入与动画。
 * 直接复用净化阶段的名单——解析与净化必须对同一批标签达成一致。
 */
export const IGNORED_SVG_TAGS: ReadonlySet<string> = DROP_SVG_TAGS;

/** 透明容器：内容照常解析，外壳本身丢弃（`switch` 只取第一个可渲染分支）。 */
export const TRANSPARENT_SVG_TAGS: ReadonlySet<string> = new Set(["a", "switch"]);

export function multiplyMat(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContentBox {
  /** SVG 的 viewBox 四元组（x y width height）；无效或缺省时按 1:1 平移 */
  viewBox?: readonly number[] | null;
  /** 默认 xMidYMid meet；支持 none 与 xMin/xMid/xMax + YMin/YMid/YMax */
  preserveAspectRatio?: string | null;
  /** 宿主没有 viewBox 时，用 width/height 与视口一致（symbol 的固有尺寸） */
  width?: number | null;
  height?: number | null;
}

function finite(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 把内容盒装进视口：`<use>` 指向 `<symbol>`、嵌套 `<svg>` 共用这套规则。
 * 没有 viewBox 时只平移——坐标与父级同一坐标系（规范里 nested svg 的宽高只建立视口，不改坐标）。
 */
export function viewportTransform(viewport: Viewport, content: ContentBox): Mat {
  const x = finite(viewport.x, 0);
  const y = finite(viewport.y, 0);
  const box = content.viewBox;
  const hasBox = !!box && box.length >= 4 && finite(box[2], 0) > 0 && finite(box[3], 0) > 0;
  if (!hasBox) return [1, 0, 0, 1, x, y];

  const [boxX = 0, boxY = 0, boxWidth = 1, boxHeight = 1] = box;
  // 视口宽高缺省时用内容尺寸，等价于 1:1
  const width = viewport.width > 0 ? viewport.width : boxWidth;
  const height = viewport.height > 0 ? viewport.height : boxHeight;

  const tokens = (content.preserveAspectRatio ?? "xMidYMid meet").trim().split(/\s+/);
  const align = tokens[0] ?? "xMidYMid";
  const mode = tokens[1] === "slice" ? "slice" : "meet";
  const none = align === "none";

  let scaleX = width / boxWidth;
  let scaleY = height / boxHeight;
  if (!none) {
    const scale = mode === "slice" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    scaleX = scale;
    scaleY = scale;
  }
  const leftoverX = width - boxWidth * scaleX;
  const leftoverY = height - boxHeight * scaleY;
  const fx = align.startsWith("xMin") ? 0 : align.startsWith("xMax") ? 1 : 0.5;
  const fy = align.includes("YMin") ? 0 : align.includes("YMax") ? 1 : 0.5;
  const offsetX = none ? 0 : leftoverX * fx;
  const offsetY = none ? 0 : leftoverY * fy;

  return [
    scaleX,
    0,
    0,
    scaleY,
    x + offsetX - boxX * scaleX,
    y + offsetY - boxY * scaleY,
  ];
}

/** `<use>` → `<symbol>`：视口是 use 的 x/y/宽高，内容尺寸回落到 symbol 自身。 */
export function symbolTransform(
  use: { x?: number | null; y?: number | null; width?: number | null; height?: number | null },
  symbol: ContentBox,
): Mat {
  return viewportTransform(
    {
      x: finite(use.x, 0),
      y: finite(use.y, 0),
      width: finite(use.width, finite(symbol.width, 0)),
      height: finite(use.height, finite(symbol.height, 0)),
    },
    symbol,
  );
}
