/**
 * 旋转：单选绕自身中心，多选绕选区包围盒中心（位置与角度一起变）。
 * 只改 `rotation` 与位置，不改尺寸。
 */
import { worldRect, type DocState, type NodeId } from "./model";
import type { Command } from "./store";
import { topLevelIds } from "./duplicate";
import { movableIds } from "./arrange";

export interface RotateParams {
  nodeIds: NodeId[];
  /** 旋转中心（世界坐标） */
  centerX: number;
  centerY: number;
  /** 本次增量（度，顺时针为正） */
  angle: number;
}

export function expandRotate(doc: DocState, params: RotateParams): Command[] {
  const ids = movableIds(doc, topLevelIds(doc, params.nodeIds));
  if (ids.length === 0 || !Number.isFinite(params.angle) || params.angle === 0) return [];
  const rad = (params.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const out: Command[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    const box = worldRect(doc, id);
    if (!box) continue;
    const parentWorld = node.parentId ? worldRect(doc, node.parentId) : null;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const nx = params.centerX + (cx - params.centerX) * cos - (cy - params.centerY) * sin;
    const ny = params.centerY + (cx - params.centerX) * sin + (cy - params.centerY) * cos;
    out.push({
      type: "node.update",
      params: {
        nodeId: id,
        patch: {
          x: nx - box.width / 2 - (parentWorld?.x ?? 0),
          y: ny - box.height / 2 - (parentWorld?.y ?? 0),
          rotation: normalizeAngle(node.rotation + params.angle),
        },
      },
    });
  }
  return out;
}

/** 归一到 (-180, 180]，检查器显示的角度不会越滚越大。 */
export function normalizeAngle(angle: number): number {
  let value = angle % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return Math.round(value * 1000) / 1000;
}
