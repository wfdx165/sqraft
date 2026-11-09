/**
 * 等比缩放（多选拖手柄 / 检查器改 W-H）。
 *
 * 世界坐标下的锚点 + 比例：位置、尺寸、圆角、字号、描边宽、效果半径、图片裁切一起变。
 * 分组没有自己的绘制内容，缩放组 = 递归缩放它的子节点。
 */
import { worldRect, type DocState, type ImageRef, type NodeId, type NodeStyle, type Rect } from "./model";
import type { Command } from "./store";
import { topLevelIds } from "./duplicate";
import { movableIds } from "./arrange";

export interface ScaleParams {
  nodeIds: NodeId[];
  /** 缩放锚点（世界坐标）：拖角时是不动的那个角 */
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
}

/** 最小尺寸：与单节点缩放手柄一致 */
const MIN_SIZE = 8;

export function expandScale(doc: DocState, params: ScaleParams): Command[] {
  const ids = movableIds(doc, topLevelIds(doc, params.nodeIds));
  const sx = clampScale(params.scaleX);
  const sy = clampScale(params.scaleY);
  if (ids.length === 0 || (sx === 1 && sy === 1)) return [];

  const out: Command[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    const box = worldRect(doc, id);
    if (!box) continue;
    const parentWorld = node.parentId ? worldRect(doc, node.parentId) : null;
    const originX = parentWorld?.x ?? 0;
    const originY = parentWorld?.y ?? 0;
    // 目标世界矩形 → 父级本地坐标
    const targetX = params.originX + (box.x - params.originX) * sx - originX;
    const targetY = params.originY + (box.y - params.originY) * sy - originY;
    out.push({
      type: "node.update",
      params: {
        nodeId: id,
        patch: {
          x: targetX,
          y: targetY,
          width: Math.max(MIN_SIZE, box.width * sx),
          height: Math.max(MIN_SIZE, box.height * sy),
          style: scaleStyle(node.style, sx, sy),
          ...(node.image ? { image: scaleImage(node.image, sx, sy) } : {}),
        },
      },
    });
    // 组：子节点坐标是组内局部坐标，递归按比例缩放
    if (node.type === "group") out.push(...scaleChildren(doc, id, sx, sy));
  }
  return out;
}

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(100, Math.max(0.01, value));
}

function scaleChildren(doc: DocState, parentId: NodeId, sx: number, sy: number): Command[] {
  const parent = doc.nodes[parentId];
  if (!parent) return [];
  const out: Command[] = [];
  for (const childId of parent.children) {
    const child = doc.nodes[childId];
    if (!child) continue;
    out.push({
      type: "node.update",
      params: {
        nodeId: childId,
        patch: {
          x: child.x * sx,
          y: child.y * sy,
          width: Math.max(1, child.width * sx),
          height: Math.max(1, child.height * sy),
          style: scaleStyle(child.style, sx, sy),
          ...(child.image ? { image: scaleImage(child.image, sx, sy) } : {}),
        },
      },
    });
    if (child.type === "group") out.push(...scaleChildren(doc, childId, sx, sy));
  }
  return out;
}

/** 圆角 / 字号 / 描边 / 效果跟着缩放；百分比单位不缩放。 */
function scaleStyle(style: NodeStyle, sx: number, sy: number): NodeStyle {
  const avg = Math.sqrt(sx * sy);
  const next: NodeStyle = { ...style };
  if (style.cornerRadius) {
    next.cornerRadius = {
      topLeft: style.cornerRadius.topLeft * avg,
      topRight: style.cornerRadius.topRight * avg,
      bottomRight: style.cornerRadius.bottomRight * avg,
      bottomLeft: style.cornerRadius.bottomLeft * avg,
    };
  }
  if (style.fontSize !== undefined) next.fontSize = style.fontSize * sy;
  if (style.strokeWidth !== undefined) next.strokeWidth = style.strokeWidth * avg;
  if (style.letterSpacing !== undefined && style.letterSpacingUnit !== "percent") {
    next.letterSpacing = style.letterSpacing * sx;
  }
  if (style.lineHeight !== undefined && style.lineHeightUnit === "px") next.lineHeight = style.lineHeight * sy;
  if (style.paragraphSpacing !== undefined) next.paragraphSpacing = style.paragraphSpacing * sy;
  if (style.effects) {
    next.effects = style.effects.map((effect) => {
      if (effect.type === "drop-shadow" || effect.type === "inner-shadow") {
        return {
          ...effect,
          x: effect.x * sx,
          y: effect.y * sy,
          blur: effect.blur * avg,
          spread: effect.spread * avg,
          color: { ...effect.color },
        };
      }
      return { ...effect, radius: (effect as { radius: number }).radius * avg };
    });
  }
  return next;
}

/** 缩放图片：裁切跟随，缺省裁切（整图）与尺寸未知的链接图都不需要改写。 */
function scaleImage(image: ImageRef, sx: number, sy: number): ImageRef {
  if (!image.crop || image.naturalWidth <= 0 || image.naturalHeight <= 0) return { ...image };
  return { ...image, crop: scaleCrop(image.crop, image, sx, sy) };
}

/** 裁切区域随框一起缩放，并夹回原图范围。 */
function scaleCrop(
  crop: Rect,
  image: { naturalWidth: number; naturalHeight: number },
  sx: number,
  sy: number,
): Rect {
  const width = Math.min(image.naturalWidth, Math.max(1, crop.width * sx));
  const height = Math.min(image.naturalHeight, Math.max(1, crop.height * sy));
  return {
    x: Math.min(Math.max(0, crop.x * sx), Math.max(0, image.naturalWidth - width)),
    y: Math.min(Math.max(0, crop.y * sy), Math.max(0, image.naturalHeight - height)),
    width,
    height,
  };
}

/** 检查器改 W/H 时用：把"目标尺寸"换算成锚定左上角的比例。 */
export function scaleFactorsTo(doc: DocState, ids: readonly NodeId[], width: number, height: number): {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
} | null {
  const boxes = ids.map((id) => worldRect(doc, id)).filter((box): box is Rect => Boolean(box));
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  return { originX: left, originY: top, scaleX: width / w, scaleY: height / h };
}
