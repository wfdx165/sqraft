/**
 * 图片裁切拖拽：手势状态 + 事务收尾。
 *
 * 纯几何在 `image-crop.ts`（`panCrop` / `scaleCrop`），这里只负责一件事：
 * 整个拖拽合并成**一条**撤销记录——移动中每次 `apply`，松手才提交。
 */
import { imageCropOf, type DocNode, type NodeId } from "@sqraft/core";
import { docStore } from "../store";
import { linkedNaturalSize } from "../linked-images";
import { panCrop, scaleCrop, type CropCorner, type CropRect } from "./image-crop";
import type { ResizeHandle } from "./selection";

/** 原图尺寸：嵌入图直接读文档，链接图读解码缓存（抓取前为 0）。 */
export function naturalSizeOf(node: DocNode): { width: number; height: number } {
  const ref = node.image;
  if (!ref) return { width: 0, height: 0 };
  if (ref.naturalWidth > 0 && ref.naturalHeight > 0) {
    return { width: ref.naturalWidth, height: ref.naturalHeight };
  }
  return linkedNaturalSize(ref.sourceUrl) ?? { width: 0, height: 0 };
}

export interface CropDragState {
  mode: "crop";
  cropId: NodeId;
  cropHandle: ResizeHandle | null;
  /** 拖拽开始时的裁切区域（原图像素坐标） */
  cropStart: CropRect;
  startX: number;
  startY: number;
}

/** 进行中的裁切事务的提交函数；松手/取消时调用一次。 */
let commit: (() => void) | null = null;

/** 进入裁切拖拽：开一条事务，返回要并进画布 drag 状态的字段。 */
export function beginCropDrag(
  node: DocNode,
  world: { x: number; y: number },
  handle: ResizeHandle | null,
): CropDragState {
  const state: CropDragState = {
    mode: "crop",
    cropId: node.id,
    cropHandle: handle,
    cropStart: imageCropOf(node, naturalSizeOf(node)),
    startX: world.x,
    startY: world.y,
  };
  commit = null;
  void docStore.transact("裁切图片", () => new Promise<void>((resolve) => {
    commit = resolve;
  }));
  return state;
}

/** 拖动中：按指针位移算出新裁切区域并落库。返回是否真的移动过。 */
export function applyCropDrag(drag: CropDragState, world: { x: number; y: number }): boolean {
  const node = docStore.doc.nodes[drag.cropId];
  const ref = node?.image;
  if (!node || !ref) return false;
  const natural = naturalSizeOf(node);
  // 链接图还没抓到：没有原图尺寸，任何裁切都没有意义
  if (natural.width <= 0 || natural.height <= 0) return false;
  const box = { width: node.width, height: node.height };
  const dx = world.x - drag.startX;
  const dy = world.y - drag.startY;
  let next: CropRect;
  if (drag.cropHandle) {
    const h = drag.cropHandle;
    const signX = h.includes("e") ? 1 : h.includes("w") ? -1 : 0;
    const signY = h.includes("s") ? 1 : h.includes("n") ? -1 : 0;
    next = scaleCrop(
      drag.cropStart,
      natural,
      box,
      { width: box.width + signX * dx, height: box.height + signY * dy },
      cropCornerOf(h),
    );
  } else {
    next = panCrop(drag.cropStart, natural, box, dx, dy);
  }
  // 链接图首次裁切时顺手把真实尺寸写进文档：下次打开即使没抓完，裁切比例也算得出来
  const known = ref.naturalWidth > 0 && ref.naturalHeight > 0;
  const image = known
    ? { ...ref, crop: next }
    : { ...ref, naturalWidth: natural.width, naturalHeight: natural.height, crop: next };
  docStore.apply(
    { type: "node.update", params: { nodeId: node.id, patch: { image } } },
    "裁切图片",
  );
  return true;
}

/** 松手：提交事务（一次拖拽 = 一条撤销）。 */
export function endCropDrag(): void {
  commit?.();
  commit = null;
}

/** 取消（Esc / 窗口失焦）：回滚到拖拽前，且不留撤销记录。 */
export function abortCropDrag(): void {
  docStore.abortTransact();
  endCropDrag();
}

/** 角/边手柄 → 缩放的锚点方向。 */
export function cropCornerOf(handle: ResizeHandle): CropCorner {
  switch (handle) {
    case "nw":
    case "ne":
    case "se":
    case "sw":
      return handle;
    case "n":
      return "ne";
    case "s":
      return "se";
    case "e":
      return "se";
    default:
      return "sw";
  }
}
