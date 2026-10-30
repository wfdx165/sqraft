/**
 * 图片裁切拖拽：手势状态 + 事务收尾。
 *
 * 纯几何在 `image-crop.ts`（`panCrop` / `scaleCrop`），这里只负责一件事：
 * 整个拖拽合并成**一条**撤销记录——移动中每次 `apply`，松手才提交。
 */
import { imageCropOf, type DocNode, type NodeId } from "@sqraft/core";
import { docStore } from "../store";
import { panCrop, scaleCrop, type CropCorner, type CropRect } from "./image-crop";
import type { ResizeHandle } from "./selection";

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
    cropStart: imageCropOf(node),
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
  const natural = { width: ref.naturalWidth, height: ref.naturalHeight };
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
  docStore.apply(
    { type: "node.update", params: { nodeId: node.id, patch: { image: { ...ref, crop: next } } } },
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
