/**
 * AI 工具定义：内置对话面板与 MCP Server 的唯一真源（ADR-0004）。
 * 纪律：样式只接受 Token 引用，字面量色值在工具层直接拒绝。
 */

import type { Command, DocNode, DocStore, NodeId, NodeStyle, VectorAnchor } from "@sqraft/core";
import {
  clampSides,
  createLayoutSpec,
  createNode,
  defaultLayoutFor,
  firstPageId,
  makeAnchor,
  newId,
  nextComponentName,
  validateVector,
  walkSubtree,
  type CornerRadius,
  type LayoutSpec,
  type Padding,
  type TextAutoResize,
} from "@sqraft/core";

/** create_node / update_node 共用的排版与外观字段。 */
const STYLE_SCHEMA: Record<string, unknown> = {
  fillToken: { type: "string", description: "填充色的 Token 名，如 color/primary" },
  strokeToken: { type: "string", description: "描边色的 Token 名；开放路径默认 color/text" },
  strokeWidth: { type: "number", description: "描边线宽" },
  cornerRadius: {
    description: "圆角：数字表示四角统一；也可传 { topLeft, topRight, bottomRight, bottomLeft }",
    oneOf: [
      { type: "number" },
      {
        type: "object",
        properties: {
          topLeft: { type: "number" },
          topRight: { type: "number" },
          bottomRight: { type: "number" },
          bottomLeft: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  fontFamily: { type: "string", description: "受控字体栈，如 'Geist Variable', 'PingFang SC', sans-serif" },
  fontWeight: { type: "number", description: "100–900" },
  fontStyle: { type: "string", enum: ["normal", "italic"] },
  fontSize: { type: "number" },
  lineHeight: { type: "number" },
  lineHeightUnit: { type: "string", enum: ["auto", "px", "percent"] },
  letterSpacing: { type: "number" },
  letterSpacingUnit: { type: "string", enum: ["px", "percent"] },
  paragraphSpacing: { type: "number" },
  textAlign: { type: "string", enum: ["left", "center", "right", "justify"] },
  textVerticalAlign: { type: "string", enum: ["top", "middle", "bottom"] },
  textCase: { type: "string", enum: ["none", "upper", "lower", "title"] },
  textDecoration: { type: "string", enum: ["none", "underline", "strikethrough"] },
  textAutoResize: { type: "string", enum: ["auto-width", "auto-height", "fixed"] },
  listType: { type: "string", enum: ["none", "bulleted", "numbered"] },
  truncate: { type: "boolean" },
};

/** 节点几何/布局字段。 */
const NODE_SCHEMA: Record<string, unknown> = {
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" },
  rotation: { type: "number", description: "旋转角度（度）" },
  opacity: { type: "number", description: "0–1" },
  visible: { type: "boolean" },
  locked: { type: "boolean" },
  clip: { type: "boolean", description: "仅 frame/component：裁剪子节点" },
  layoutSizingW: { type: "string", enum: ["fixed", "hug", "fill"] },
  layoutSizingH: { type: "string", enum: ["fixed", "hug", "fill"] },
  layoutMinW: { type: "number" },
  layoutMinH: { type: "number" },
  layoutMaxW: { type: "number" },
  layoutMaxH: { type: "number" },
  layoutAbsolute: { type: "boolean" },
  layout: {
    type: "object",
    description: "自动布局：只允许 frame/component。padding 支持数字或四边对象。",
    properties: {
      direction: { type: "string", enum: ["horizontal", "vertical"] },
      gap: { type: "number" },
      padding: {
        oneOf: [
          { type: "number" },
          {
            type: "object",
            properties: {
              top: { type: "number" },
              right: { type: "number" },
              bottom: { type: "number" },
              left: { type: "number" },
            },
            additionalProperties: false,
          },
        ],
      },
      mainAlign: { type: "string", enum: ["start", "center", "end", "space-between"] },
      crossAlign: { type: "string", enum: ["start", "center", "end", "stretch"] },
      wrap: { type: "boolean" },
      crossGap: { type: "number" },
      alignContent: { type: "string", enum: ["start", "center", "end", "space-between", "stretch"] },
    },
    additionalProperties: false,
  },
};

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  readonly?: boolean;
}

export const tools: ToolDefinition[] = [
  {
    name: "read_document",
    description:
      "读取当前文档的页面与节点树紧凑摘要。组件节点带 propertyDefs，实例带 componentId / propValues / overrides，插槽带 slotFilled。返回 JSON 字符串。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_tokens",
    description: "读取设计 Token 集合及当前模式下的取值。样式必须引用这些 Token。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_node",
    description:
      "在父节点下创建一个节点。kind 支持 frame/rect/ellipse/polygon/line/path/text/component/slot。component 只能建在页面顶层；slot 必须位于主组件内并提供唯一名字。polygon 是参数化多边形，用 sides 指定边数（3–12，默认 3，3 即三角形），顶点由 width/height 包围盒推导。path 用 points 描述锚点（父容器坐标，手柄为相对锚点的偏移），闭合路径至少 3 个锚点、开放路径至少 2 个。样式颜色必须用 fillToken / strokeToken（Token 名），不允许字面量色值。",
    input_schema: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "父节点 id；省略则建到当前页面" },
        kind: { type: "string", enum: ["frame", "rect", "ellipse", "polygon", "line", "path", "text", "component", "slot"] },
        name: { type: "string", description: "slot 必填且组件内唯一" },
        sides: { type: "number", description: "kind=polygon 的边数，3–12，默认 3" },
        text: { type: "string", description: "kind=text 时的文案" },
        closed: { type: "boolean", description: "kind=path 时是否闭合，默认 false" },
        points: {
          type: "array",
          minItems: 2,
          description: "kind=path 的锚点，父容器坐标；x/y 必填，inX/inY/outX/outY 为相对锚点的手柄偏移",
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              inX: { type: "number" },
              inY: { type: "number" },
              outX: { type: "number" },
              outY: { type: "number" },
            },
            required: ["x", "y"],
            additionalProperties: false,
          },
        },
        ...NODE_SCHEMA,
        ...STYLE_SCHEMA,
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "create_instance",
    description:
      "插入一个组件实例，自动物化整棵子树。parentId 省略时放到当前页面；x/y 是相对父容器的坐标。",
    input_schema: {
      type: "object",
      properties: {
        componentId: { type: "string" },
        parentId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        name: { type: "string" },
      },
      required: ["componentId"],
      additionalProperties: false,
    },
  },
  {
    name: "define_property",
    description:
      "在组件母版的图层上创建组件属性。type=text 要求目标为文本图层，boolean 控制可见性，instance 控制嵌套实例替换成哪个组件。返回 propertyId。",
    input_schema: {
      type: "object",
      properties: {
        componentId: { type: "string" },
        targetNodeId: { type: "string" },
        type: { type: "string", enum: ["text", "boolean", "instance"] },
        name: { type: "string", description: "显示名；省略则用图层名" },
      },
      required: ["componentId", "targetNodeId", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "set_instance_prop",
    description:
      "设置或清除实例的属性值。文本用字符串、布尔用 true/false、实例替换用组件 id；null 表示清除并回落到母版值。",
    input_schema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        propertyId: { type: "string" },
        value: { description: "字符串 / 布尔 / 组件 id；null 清除" },
      },
      required: ["instanceId", "propertyId", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "fill_slot",
    description:
      "把已有节点填入实例的具名插槽。首次填充会整体替换默认内容；节点保持世界坐标。",
    input_schema: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        slotName: { type: "string" },
        nodeIds: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["instanceId", "slotName", "nodeIds"],
      additionalProperties: false,
    },
  },
  {
    name: "swap_instance",
    description: "把实例替换成另一个组件；位置不变，同名已填充插槽内容保留。",
    input_schema: {
      type: "object",
      properties: { instanceId: { type: "string" }, componentId: { type: "string" } },
      required: ["instanceId", "componentId"],
      additionalProperties: false,
    },
  },
  {
    name: "detach_instance",
    description: "把实例脱离为普通画板，不再受母版影响。",
    input_schema: {
      type: "object",
      properties: { instanceId: { type: "string" } },
      required: ["instanceId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_node",
    description:
      "更新节点属性。fill 仅接受 Token 引用（fillToken）。polygon 可用 sides 改边数（3–12）。path 可用 points（父容器坐标）整体替换锚点、用 closed 切换闭合；只改 width/height 时锚点会按比例缩放。",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        text: { type: "string" },
        sides: { type: "number", description: "polygon 的边数，3–12" },
        closed: { type: "boolean" },
        points: {
          type: "array",
          minItems: 2,
          description: "path 的新锚点，父容器坐标；与 create_node 的 points 同构",
          items: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              inX: { type: "number" },
              inY: { type: "number" },
              outX: { type: "number" },
              outY: { type: "number" },
            },
            required: ["x", "y"],
            additionalProperties: false,
          },
        },
        ...NODE_SCHEMA,
        ...STYLE_SCHEMA,
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_node",
    description: "删除节点及其子树。",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "截取当前画布视口为 PNG（data URL），用于自检生成结果。",
    readonly: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

function serializeSubtree(store: DocStore, id: NodeId): string {
  const out: unknown[] = [];
  walkSubtree(store.doc, id, (n) =>
    out.push({
      id: n.id,
      type: n.type,
      name: n.name,
      parentId: n.parentId,
      children: n.children,
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
      text: n.text,
      rotation: n.rotation,
      opacity: n.opacity,
      visible: n.visible,
      locked: n.locked,
      clip: n.clip,
      style: n.style,
      ...(n.layout ? { layout: n.layout } : {}),
      ...(n.layoutSizingW ? { layoutSizingW: n.layoutSizingW } : {}),
      ...(n.layoutSizingH ? { layoutSizingH: n.layoutSizingH } : {}),
      ...(n.layoutAbsolute ? { layoutAbsolute: n.layoutAbsolute } : {}),
      ...(n.textAutoResize ? { textAutoResize: n.textAutoResize } : {}),
      ...(n.listType ? { listType: n.listType } : {}),
      ...(n.truncate ? { truncate: n.truncate } : {}),
      ...(n.type === "polygon" ? { sides: n.sides ?? 3 } : {}),
      ...(n.vector ? { vector: n.vector } : {}),
      ...(n.componentId ? { componentId: n.componentId } : {}),
      ...(n.mainId ? { mainId: n.mainId } : {}),
      ...(n.propValues ? { propValues: n.propValues } : {}),
      ...(n.overrides ? { overrides: n.overrides } : {}),
      ...(n.slotFilled !== undefined ? { slotFilled: n.slotFilled } : {}),
      ...(n.propertyDefs ? { propertyDefs: n.propertyDefs } : {}),
    }),
  );
  return JSON.stringify(out);
}

/** 读取 points：父容器坐标，x/y 必填，手柄缺省为 0。 */
function readPoints(value: unknown): VectorAnchor[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("points 必须是锚点数组");
  return value.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`points[${i}] 必须是对象`);
    const p = raw as Record<string, unknown>;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`points[${i}] 的 x/y 必须是数值`);
    const offset = (key: string): number => {
      const v = p[key];
      if (v === undefined) return 0;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`points[${i}].${key} 必须是数值`);
      return n;
    };
    return makeAnchor(x, y, { inX: offset("inX"), inY: offset("inY"), outX: offset("outX"), outY: offset("outY") });
  });
}

function applyStyleTokens(style: NodeStyle, args: Record<string, unknown>): void {
  if (args.fillToken !== undefined) style.fill = { token: String(args.fillToken) };
  if (args.strokeToken !== undefined) style.stroke = { token: String(args.strokeToken) };
  if (args.strokeWidth !== undefined) style.strokeWidth = Math.max(0, Number(args.strokeWidth));
}

export function assertToken(store: DocStore, token: string | undefined, field: string): void {
  if (token === undefined) return;
  if (!store.doc.tokens[token]) {
    throw new Error(`${field} 引用了不存在的 Token "${token}"；调用 get_tokens 查看可用 Token。禁止使用字面量色值。`);
  }
}

function findSlotByName(store: DocStore, instanceId: NodeId, name: string): NodeId | null {
  let found: NodeId | null = null;
  walkSubtree(store.doc, instanceId, (n) => {
    if (!found && n.type === "slot" && n.name === name) found = n.id;
  });
  return found;
}

function cornerFrom(value: unknown): CornerRadius | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value };
  }
  const c = value as Partial<CornerRadius>;
  return {
    topLeft: Number(c.topLeft ?? 0),
    topRight: Number(c.topRight ?? 0),
    bottomRight: Number(c.bottomRight ?? 0),
    bottomLeft: Number(c.bottomLeft ?? 0),
  };
}

function paddingFrom(value: unknown): Padding {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  const p = (value ?? {}) as Partial<Padding>;
  return { top: Number(p.top ?? 0), right: Number(p.right ?? 0), bottom: Number(p.bottom ?? 0), left: Number(p.left ?? 0) };
}

function layoutFrom(value: unknown): LayoutSpec | undefined {
  if (value === undefined) return undefined;
  const raw = value as Partial<LayoutSpec>;
  return createLayoutSpec({
    ...raw,
    padding: paddingFrom(raw.padding),
  });
}

/** 外观与排版字段（只在显式传入时覆盖）。 */
function applyStyleArgs(style: NodeStyle, args: Record<string, unknown>): NodeStyle {
  const next: NodeStyle = { ...style };
  const keys = [
    "fontFamily", "fontWeight", "fontStyle", "fontSize", "lineHeight", "lineHeightUnit",
    "letterSpacing", "letterSpacingUnit", "paragraphSpacing", "textAlign", "textVerticalAlign",
    "textCase", "textDecoration",
  ] as const;
  for (const key of keys) {
    if (args[key] !== undefined) (next as Record<string, unknown>)[key] = args[key];
  }
  const corner = cornerFrom(args.cornerRadius);
  if (corner) next.cornerRadius = corner;
  applyStyleTokens(next, args);
  return next;
}

/** 节点几何/布局字段（只在显式传入时覆盖）。 */
function applyNodeArgs(args: Record<string, unknown>): Partial<DocNode> {
  const patch: Partial<DocNode> = {};
  const keys = [
    "x", "y", "width", "height", "rotation", "opacity", "visible", "locked", "clip",
    "layoutSizingW", "layoutSizingH", "layoutMinW", "layoutMinH", "layoutMaxW", "layoutMaxH",
    "layoutAbsolute", "text", "textAutoResize", "listType", "truncate",
  ] as const;
  for (const key of keys) {
    if (args[key] !== undefined) (patch as Record<string, unknown>)[key] = args[key];
  }
  const layout = layoutFrom(args.layout);
  if (layout) patch.layout = layout;
  return patch;
}

export function makeExecutor(
  store: DocStore,
  getScreenshot: () => Promise<string>,
  getActivePageId?: () => NodeId | null,
  measureText?: (node: DocNode, style: NodeStyle, text: string) => { width: number; height: number },
): ToolExecutor {
  return async (name, args) => {
    switch (name) {
      case "read_document": {
        const pages = store.doc.rootIds.map((pid) => ({ pageId: pid, name: store.doc.nodes[pid]?.name, subtree: serializeSubtree(store, pid) }));
        return JSON.stringify({ pages });
      }
      case "get_tokens": {
        return JSON.stringify({ tokens: store.doc.tokens });
      }
      case "create_node": {
        const kind = String(args.kind) as
          | "frame" | "rect" | "ellipse" | "polygon" | "line" | "path" | "text" | "component" | "slot";
        const isPath = kind === "path";
        const isPolygon = kind === "polygon";
        const isComponent = kind === "component";
        const isSlot = kind === "slot";
        assertToken(store, args.fillToken as string | undefined, "fillToken");
        assertToken(store, args.strokeToken as string | undefined, "strokeToken");
        const parentId = (args.parentId as NodeId | undefined) ?? getActivePageId?.() ?? firstPageId(store.doc);
        if (!parentId || !store.doc.nodes[parentId]) throw new Error("parentId 不存在");

        let name = args.name as string | undefined;
        if (isComponent) {
          const parent = store.doc.nodes[parentId];
          if (!parent || parent.type !== "page") throw new Error("主组件必须位于页面顶层");
          name = name ?? nextComponentName(store.doc);
        }
        if (isSlot) {
          const trimmed = String(name ?? "").trim();
          if (!trimmed) throw new Error("kind=slot 必须提供唯一的 name");
          name = trimmed;
          let componentId: NodeId | null = null;
          let cur: DocNode | undefined = store.doc.nodes[parentId];
          while (cur) {
            if (cur.type === "instance" || cur.type === "slot") break;
            if (cur.type === "component") {
              componentId = cur.id;
              break;
            }
            cur = cur.parentId ? store.doc.nodes[cur.parentId] : undefined;
          }
          if (!componentId) throw new Error("插槽必须位于主组件内");
          let used = false;
          walkSubtree(store.doc, componentId, (n) => {
            if (n.type === "slot" && n.name === trimmed) used = true;
          });
          if (used) throw new Error(`插槽名 "${trimmed}" 已存在`);
        }

        const points = readPoints(args.points);
        const closed = Boolean(args.closed);
        if (args.sides !== undefined && !isPolygon) throw new Error("sides 仅适用于 kind=polygon");
        if (isPath) {
          if (!points) throw new Error("kind=path 必须提供 points");
          if (points.length < 2) throw new Error("路径至少需要 2 个锚点");
          if (closed && points.length < 3) throw new Error("闭合路径至少需要 3 个锚点");
          validateVector({ closed, anchors: points });
        }

        if (args.layout !== undefined && kind !== "frame" && kind !== "component") {
          throw new Error("layout 仅适用于 frame / component");
        }
        const style = applyStyleArgs({}, args);
        if (isPath) {
          // 与 GUI 一致：未显式给颜色时，闭合默认填充、开放默认描边
          if (!style.fill && !style.stroke) {
            if (closed) style.fill = { token: "color/primary" };
            else style.stroke = { token: "color/text" };
          }
          if (style.stroke && style.strokeWidth === undefined) style.strokeWidth = 2;
        }
        if (isPolygon && !style.fill && !style.stroke) style.fill = { token: "color/primary" };
        // 画板与 GUI 工具一致：默认白底
        if (kind === "frame" && !style.fill && !style.stroke) style.fill = { token: "color/surface" };

        const node = createNode(kind, {
          name: name ?? (isPolygon ? (clampSides(args.sides as number) === 3 ? "三角形" : "多边形") : kind),
          // 路径的 points 是父容器坐标：先放在 0,0，由 store 归一化并推导节点框
          x: isPath ? 0 : ((args.x as number) ?? 0),
          y: isPath ? 0 : ((args.y as number) ?? 0),
          width: isPath ? 1 : ((args.width as number) ?? 100),
          height: isPath ? 1 : ((args.height as number) ?? 100),
          text: args.text as string | undefined,
          vector: isPath ? { closed, anchors: points! } : undefined,
          sides: isPolygon ? clampSides(args.sides as number) : undefined,
          style,
          ...applyNodeArgs(args),
        });
        // 与 GUI 一致：新建画板 / 组件默认开启自动布局（AI 显式给了 layout 则以其为准）
        if ((kind === "frame" || kind === "component") && !node.layout) node.layout = defaultLayoutFor(kind);
        // 文本：自动尺寸由宿主注入的测量函数决定
        if (kind === "text" && measureText && (node.textAutoResize ?? "auto-width") !== "fixed") {
          const size = measureText(node, node.style, node.text ?? "");
          node.width = size.width;
          node.height = size.height;
        }
        store.apply({ type: "node.create", params: { nodes: [node], parentId } }, "ai:create");
        return JSON.stringify({ ok: true, nodeId: node.id });
      }
      case "create_instance": {
        const componentId = String(args.componentId);
        const master = store.doc.nodes[componentId];
        if (!master || master.type !== "component") throw new Error(`组件 ${componentId} 不存在`);
        const parentId = (args.parentId as NodeId | undefined) ?? getActivePageId?.() ?? firstPageId(store.doc);
        if (!parentId || !store.doc.nodes[parentId]) throw new Error("parentId 不存在");
        const nodeId = newId();
        store.apply(
          {
            type: "instance.create",
            params: {
              componentId,
              parentId,
              nodeId,
              x: Number(args.x ?? 0),
              y: Number(args.y ?? 0),
              name: args.name as string | undefined,
            },
          },
          "ai:instance",
        );
        return JSON.stringify({ ok: true, nodeId });
      }
      case "define_property": {
        const componentId = String(args.componentId);
        const targetNodeId = String(args.targetNodeId);
        const type = String(args.type);
        if (type !== "text" && type !== "boolean" && type !== "instance") {
          throw new Error("type 必须是 text / boolean / instance");
        }
        const id = newId();
        store.apply(
          {
            type: "property.define",
            params: {
              componentId,
              targetMainId: targetNodeId,
              id,
              type,
              name: args.name as string | undefined,
            },
          },
          "ai:property",
        );
        const def = store.doc.nodes[componentId]?.propertyDefs?.find((d) => d.id === id);
        return JSON.stringify({ ok: true, propertyId: id, name: def?.name });
      }
      case "set_instance_prop": {
        const instanceId = String(args.instanceId);
        const propertyId = String(args.propertyId);
        const value = args.value === undefined ? null : (args.value as string | boolean | null);
        store.apply(
          { type: "property.set", params: { instanceId, propertyId, value } },
          "ai:property",
        );
        return JSON.stringify({ ok: true });
      }
      case "fill_slot": {
        const instanceId = String(args.instanceId);
        const slotName = String(args.slotName);
        const slotId = findSlotByName(store, instanceId, slotName);
        if (!slotId) throw new Error(`实例里没有名为 "${slotName}" 的插槽`);
        const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : [];
        if (nodeIds.length === 0) throw new Error("nodeIds 不能为空");
        store.apply({ type: "slot.fill", params: { slotId, nodeIds } }, "ai:slot");
        return JSON.stringify({ ok: true, slotId });
      }
      case "swap_instance": {
        const instanceId = String(args.instanceId);
        const componentId = String(args.componentId);
        store.apply({ type: "instance.swap", params: { instanceId, componentId } }, "ai:swap");
        return JSON.stringify({ ok: true });
      }
      case "detach_instance": {
        const instanceId = String(args.instanceId);
        store.apply({ type: "component.detach", params: { instanceId } }, "ai:detach");
        return JSON.stringify({ ok: true });
      }
      case "update_node": {
        const nodeId = args.nodeId as NodeId;
        const node = store.doc.nodes[nodeId];
        if (!node) throw new Error(`节点 ${nodeId} 不存在`);
        assertToken(store, args.fillToken as string | undefined, "fillToken");
        assertToken(store, args.strokeToken as string | undefined, "strokeToken");

        if (args.layout !== undefined && node.type !== "frame" && node.type !== "component" && node.type !== "instance") {
          throw new Error("layout 仅适用于 frame / component / instance");
        }
        const patch: Partial<DocNode> = { ...applyNodeArgs(args) };

        const style = applyStyleArgs(node.style, args);
        if (JSON.stringify(style) !== JSON.stringify(node.style)) patch.style = style;

        const points = readPoints(args.points);
        const closedArg = args.closed !== undefined ? Boolean(args.closed) : undefined;
        if (args.sides !== undefined) {
          if (node.type !== "polygon") throw new Error("sides 仅适用于 polygon 节点");
          patch.sides = clampSides(Number(args.sides));
        }
        if (points) {
          if (node.type !== "path") throw new Error("points 仅适用于 path 节点");
          if (points.length < 2) throw new Error("路径至少需要 2 个锚点");
          const anchors = points.map((p) => ({ ...p, x: p.x - node.x, y: p.y - node.y }));
          patch.vector = { closed: closedArg ?? node.vector?.closed ?? false, anchors };
        } else if (closedArg !== undefined) {
          if (!node.vector) throw new Error("closed 仅适用于 path 节点");
          patch.vector = { ...node.vector, closed: closedArg };
        }

        // 文本自动尺寸：文本或排版变化后重算
        if (node.type === "text" && measureText) {
          const mode = (patch.textAutoResize ?? node.textAutoResize ?? "auto-width") as TextAutoResize;
          const text = (patch.text ?? node.text ?? "") as string;
          const style = (patch.style ?? node.style) as NodeStyle;
          if (mode !== "fixed") {
            const size = measureText({ ...node, ...patch, style }, style, text);
            if (mode === "auto-width") patch.width = size.width;
            patch.height = size.height;
          }
        }
        store.apply({ type: "node.update", params: { nodeId, patch } }, "ai:update");
        return JSON.stringify({ ok: true });
      }
      case "delete_node": {
        const nodeId = args.nodeId as NodeId;
        if (!store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
        store.apply({ type: "node.delete", params: { nodeId } }, "ai:delete");
        return JSON.stringify({ ok: true });
      }
      case "screenshot":
        return JSON.stringify({ ok: true, image: await getScreenshot() });
      default:
        throw new Error(`未知工具: ${name}`);
    }
  };
}

/** 供 OpenAI 兼容接口使用的 tools 字段格式。 */
export function toOpenAITools(): Array<{ type: "function"; function: ToolDefinition }> {
  return tools.map((t) => ({ type: "function" as const, function: t }));
}

/** 供 MCP Server 使用的扁平清单（骨架；M4 正式实现挂 @modelcontextprotocol/sdk）。 */
export function toMCPManifest(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}

export type { Command };
