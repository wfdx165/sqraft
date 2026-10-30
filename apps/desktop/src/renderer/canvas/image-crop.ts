/**
 * 图片裁切：`crop` 是原图像素坐标下的可见区域，节点框只是外框。
 * 这里只放纯计算，交互与渲染各自读它。
 */

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropCorner = "nw" | "ne" | "se" | "sw";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 夹回图片范围：宽高至少 1px，位置不越界。 */
export function clampCrop(crop: CropRect, natural: { width: number; height: number }): CropRect {
  const width = clamp(crop.width, 1, natural.width);
  const height = clamp(crop.height, 1, natural.height);
  return {
    x: clamp(crop.x, 0, natural.width - width),
    y: clamp(crop.y, 0, natural.height - height),
    width,
    height,
  };
}

/**
 * 框内拖动图片：改的是 crop 的起点。
 * `dx`/`dy` 是节点框坐标下的位移（世界像素），按 crop→框的映射换算回原图像素。
 */
export function panCrop(
  crop: CropRect,
  natural: { width: number; height: number },
  box: { width: number; height: number },
  dx: number,
  dy: number,
): CropRect {
  const scaleX = box.width > 0 ? crop.width / box.width : 1;
  const scaleY = box.height > 0 ? crop.height / box.height : 1;
  // 手指往右拖 = 看图片更左边的部分
  return clampCrop({ ...crop, x: crop.x - dx * scaleX, y: crop.y - dy * scaleY }, natural);
}

/**
 * 拖角改裁切范围：以对角为锚点缩放，等同于"把框往里收 = 裁掉更多"。
 * `box` 是节点框，`next` 是拖动后的框（未落盘，只用来算比例）。
 */
export function scaleCrop(
  crop: CropRect,
  natural: { width: number; height: number },
  box: { width: number; height: number },
  next: { width: number; height: number },
  corner: CropCorner,
): CropRect {
  const scaleX = box.width > 0 ? Math.max(0.02, next.width / box.width) : 1;
  const scaleY = box.height > 0 ? Math.max(0.02, next.height / box.height) : 1;
  const width = crop.width * scaleX;
  const height = crop.height * scaleY;
  // 拖哪个角，哪个角就在动；锚点是对角。
  // 例：拖 SE 往里收 = 右下在动、左上固定 → 锚点左上（x/y 不变，宽高变小）
  const anchorRight = corner === "nw" || corner === "sw";
  const anchorBottom = corner === "nw" || corner === "ne";
  // 锚点那一侧不能越过图片边界：往右放大最多到图片右边，往左最多到 0
  const maxWidth = anchorRight ? crop.x + crop.width : natural.width - crop.x;
  const maxHeight = anchorBottom ? crop.y + crop.height : natural.height - crop.y;
  const clampedWidth = clamp(width, 1, Math.max(1, maxWidth));
  const clampedHeight = clamp(height, 1, Math.max(1, maxHeight));
  const x = anchorRight ? crop.x + crop.width - clampedWidth : crop.x;
  const y = anchorBottom ? crop.y + crop.height - clampedHeight : crop.y;
  return clampCrop({ x, y, width: clampedWidth, height: clampedHeight }, natural);
}
