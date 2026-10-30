/**
 * 文件格式迁移：按 manifest 的 formatVersion 顺序把旧文档归一化到当前模型。
 * 只有读入时调用；写回始终是当前版本。
 */

import {
  CURRENT_FORMAT_VERSION,
  ZERO_CORNER_RADIUS,
  createLayoutSpec,
  type CornerRadius,
  type DocNode,
  type DocState,
  type LayoutSpec,
  type NodeStyle,
  type Padding,
} from "./model";

export { CURRENT_FORMAT_VERSION };

function paddingOf(value: unknown): Padding {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  if (value && typeof value === "object") {
    const p = value as Partial<Padding>;
    return { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function cornerOf(value: unknown): CornerRadius {
  if (typeof value === "number") {
    return { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value };
  }
  if (value && typeof value === "object") {
    const c = value as Partial<CornerRadius>;
    return {
      topLeft: c.topLeft ?? 0,
      topRight: c.topRight ?? 0,
      bottomRight: c.bottomRight ?? 0,
      bottomLeft: c.bottomLeft ?? 0,
    };
  }
  return { ...ZERO_CORNER_RADIUS };
}

function migrateStyle(style: NodeStyle): NodeStyle {
  const next: NodeStyle = { ...style };
  if (style.cornerRadius !== undefined) next.cornerRadius = cornerOf(style.cornerRadius);
  // v1 的 lineHeight 从未参与渲染，一律回到 auto
  delete next.lineHeight;
  delete next.lineHeightUnit;
  return next;
}

function migrateLayout(layout: LayoutSpec | undefined): LayoutSpec | undefined {
  if (!layout) return layout;
  return createLayoutSpec({
    ...layout,
    padding: paddingOf(layout.padding),
    wrap: layout.wrap ?? false,
    crossGap: layout.crossGap ?? 0,
    alignContent: layout.alignContent ?? "start",
  });
}

function migrateNode(node: DocNode): DocNode {
  node.style = migrateStyle(node.style ?? {});
  node.layout = migrateLayout(node.layout);
  node.opacity = node.opacity ?? 1;
  // 旧文件没有裁剪设置：保持外观不变
  node.clip = node.clip ?? false;
  node.layoutSizingW = node.layoutSizingW ?? "fixed";
  node.layoutSizingH = node.layoutSizingH ?? "fixed";
  if (node.type === "text") {
    node.textAutoResize = node.textAutoResize ?? "auto-width";
    node.listType = node.listType ?? "none";
  }
  return node;
}

/** 1 → 2：字段形状归一化。 */
function migrateV1to2(state: DocState): void {
  for (const node of Object.values(state.nodes)) migrateNode(node);
}

/** 2 → 3：图片节点补齐原图尺寸与裁切区域（缺省整图）。 */
function migrateV2to3(state: DocState): void {
  for (const node of Object.values(state.nodes)) {
    if (node.type !== "image" || !node.image) continue;
    const ref = node.image;
    ref.naturalWidth = Math.max(1, ref.naturalWidth || node.width || 1);
    ref.naturalHeight = Math.max(1, ref.naturalHeight || node.height || 1);
    ref.crop = ref.crop ?? { x: 0, y: 0, width: ref.naturalWidth, height: ref.naturalHeight };
  }
}

/** 迁移入口：缺 formatVersion 视为 1；幂等。 */
export function migrateDoc(state: DocState, fromVersion = state.formatVersion ?? 1): DocState {
  let version = fromVersion || 1;
  if (version < 2) {
    migrateV1to2(state);
    version = 2;
  }
  if (version < 3) {
    migrateV2to3(state);
    version = 3;
  }
  // 4：页面新增可选的 `guides`（参考线）。缺省即"没有参考线"，不需要改数据。
  if (version < 4) version = 4;
  // 5：页面新增可选的 `backgroundImage`。缺省即"没有背景图"，不需要改数据。
  if (version < 5) version = 5;
  state.formatVersion = CURRENT_FORMAT_VERSION;
  return state;
}
