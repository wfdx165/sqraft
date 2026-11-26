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
import type { VectorContour } from "./vector";

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
  // 6：图片新增可选的 `sourceUrl`（链接图），`crop` 变为可选。缺省即嵌入图，不需要改数据。
  if (version < 6) version = 6;
  // 7：样式/布局新增可选的数值 Token 引用（fontSizeToken / cornerRadiusTokens / gapToken …）。
  //    缺省即字面量，不需要改数据。
  if (version < 7) version = 7;
  // 8：节点新增可选的 `interactions`（原型链接）与页面 `scrollDirection`。
  //    缺省即「没有链接 / 不滚动」，不需要改数据。
  if (version < 8) version = 8;
  // 9：文档新增 `strictTokens`（Token 严格模式，ADR-0035）。
  //    缺省 false = 宽松，老文件打开即 v0.0.6 的行为；这里顺手归一成布尔，读的时候不用再兜。
  if (version < 9) {
    state.strictTokens = state.strictTokens === true;
    version = 9;
  }
  // 10：Paint 新增可选的渐变形态（linear/radial/angular/diamond）。
  //     纯色结构与旧文件一致，渐变缺省即"没有"，不需要改数据。
  if (version < 10) version = 10;
  // 11：Token 新增可选的渐变类型（ADR-0039）。旧文件的 color / number Token 结构不变，
  //     不需要改数据；旧版本读到渐变 Token 会把值当颜色画，所以必须靠版本号拒开。
  if (version < 11) version = 11;
  // 12：VectorPath 从 `{ closed, anchors }` 升级为多轮廓 `{ contours, fillRule }`（ADR-0040）。
  //     旧路径包成单条轮廓；旧版本读到新结构会把带洞形状画成实心，因此必须靠版本号拒开。
  if (version < 12) {
    migrateV11to12(state);
    version = 12;
  }
  state.formatVersion = CURRENT_FORMAT_VERSION;
  return state;
}

/** 11 → 12：单轮廓路径包成 `contours`，填充规则缺省 `nonzero`。 */
function migrateV11to12(state: DocState): void {
  for (const node of Object.values(state.nodes)) {
    if (!node.vector) continue;
    const legacy = node.vector as unknown as {
      closed?: unknown;
      anchors?: unknown;
      contours?: unknown;
      fillRule?: unknown;
    };
    if (Array.isArray(legacy.contours)) {
      // 兜底：结构已经是新形状，只补 fillRule
      node.vector = {
        contours: legacy.contours as VectorContour[],
        fillRule: legacy.fillRule === "evenodd" ? "evenodd" : "nonzero",
      };
      continue;
    }
    const anchors = Array.isArray(legacy.anchors) ? legacy.anchors : [];
    node.vector = {
      contours: [{ closed: legacy.closed === true, anchors }],
      fillRule: "nonzero",
    } as DocNode["vector"];
  }
}
