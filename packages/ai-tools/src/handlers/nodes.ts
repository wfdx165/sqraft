// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { AlignEdge, Command, DistributeAxis, DocNode, NodeId, NodeStyle, ReorderAction, TextAutoResize } from "../shared";
import { AppError, CREATABLE_KINDS, applyNodeArgs, applyStyleArgs, assertEffectTokens, assertGradientTokens, assertImageUrl, assertNoLiteralColors, assertNumericTokenArgs, assertToken, clampSides, createNode, defaultLayoutFor, effectsFrom, ensurePage, firstPageId, newId, nextComponentName, nextComponentPosition, pathFromAnchors, planDuplicate, readContours, readPoints, replaceContour, resolveNumericStyle, validateVector, walkSubtree, worldRect, type CreatableKind } from "../shared";
import type { Handler, ToolContext } from "../types";

/** 单次 `create_nodes` 的节点总数上限（含子孙）：既撑爆事务，也给 agent 一个"分批"的理由。 */
const MAX_BATCH_NODES = 500;

/**
 * 节点类型白名单。schema 的 enum 只给客户端看，真正执行的校验在这里——
 * `createNode()` 不校验 type，漏一个就会把垃圾节点写进文档。
 * 与 schema 同源（`CREATABLE_KINDS`），别各写一份。
 */
const NODE_KINDS: ReadonlySet<string> = new Set(CREATABLE_KINDS);

/** 解析父节点：`create_node` 与 `create_nodes` 的顶层节点共用；空文档自动补一页。 */
function resolveParentId(ctx: ToolContext, args: Record<string, unknown>, componentRoot: boolean): NodeId | null {
  if (componentRoot) return null;
  let parentId = (args.parentId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
  // 空文档没有页面：先建一页再画（与人工"新建页面"同一套命令，仍是一次撤销）
  if (!parentId && args.parentId === undefined) parentId = ensurePage(ctx.store, ctx.defaultName?.("page") ?? "页面");
  if (!parentId || !ctx.store.doc.nodes[parentId]) throw new Error("parentId 不存在");
  return parentId;
}

/**
 * 节点构造：`create_node` 与 `create_nodes` 共用（入参字段完全一致，见 tools.ts 的 NODE_ARGS）。
 * `path` 只用于把错误定位到具体条目（如 `nodes[0].children[2]`），单建时传空串。
 */
async function buildNodeFromArgs(
  ctx: ToolContext,
  args: Record<string, unknown>,
  parentId: NodeId | null,
  path: string,
): Promise<DocNode> {
  try {
    return await buildNodeInner(ctx, args, parentId);
  } catch (err) {
    if (!path) throw err;
    throw new Error(`${path}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** kind 白名单：所有分支从它派生，避免到处比较字符串。 */
function readKind(args: Record<string, unknown>): CreatableKind {
  const kind = String(args.kind);
  if (!NODE_KINDS.has(kind)) {
    throw new Error(`kind 不支持：${kind}；可选 ${[...NODE_KINDS].join("/")}`);
  }
  return kind as CreatableKind;
}

/** 插槽：必须位于主组件内，且组件内名字唯一。返回去空格后的名字。 */
function resolveSlotName(ctx: ToolContext, name: string | undefined, parentId: NodeId | null): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("kind=slot 必须提供唯一的 name");
  let componentId: NodeId | null = null;
  let cur: DocNode | undefined = parentId ? ctx.store.doc.nodes[parentId] : undefined;
  while (cur) {
    if (cur.type === "instance" || cur.type === "slot") break;
    if (cur.type === "component") {
      componentId = cur.id;
      break;
    }
    cur = cur.parentId ? ctx.store.doc.nodes[cur.parentId] : undefined;
  }
  if (!componentId) throw new Error("插槽必须位于主组件内");
  let used = false;
  walkSubtree(ctx.store.doc, componentId, (n) => {
    if (n.type === "slot" && n.name === trimmed) used = true;
  });
  if (used) throw new Error(`插槽名 "${trimmed}" 已存在`);
  return trimmed;
}

/** path 的锚点、polygon 的边数、layout 的适用范围。错误顺序与 GUI 侧一致。 */
function readShapeArgs(kind: string, args: Record<string, unknown>, hasContours = false): {
  points: ReturnType<typeof readPoints>;
  closed: boolean;
} {
  const isPath = kind === "path";
  const points = readPoints(args.points);
  const closed = Boolean(args.closed);
  if (args.sides !== undefined && kind !== "polygon") throw new Error("sides 仅适用于 kind=polygon");
  if (isPath && !hasContours) {
    if (!points) throw new Error("kind=path 必须提供 points 或 contours");
    if (points.length < 2) throw new Error("路径至少需要 2 个锚点");
    if (closed && points.length < 3) throw new Error("闭合路径至少需要 3 个锚点");
    validateVector(pathFromAnchors(points, closed));
  }
  if (isPath && hasContours && args.closed !== undefined) {
    throw new Error("contours 与 closed 不能同时给；闭合写在每条轮廓的 closed 上");
  }
  if (args.layout !== undefined && kind !== "frame" && kind !== "component") {
    throw new Error("layout 仅适用于 frame / component");
  }
  return { points, closed };
}

/** 样式：入参优先，缺省值与 GUI 工具保持一致（闭合路径填充、开放路径描边、画板白底）。 */
function buildStyleFor(kind: string, args: Record<string, unknown>, closed: boolean): NodeStyle {
  const style = applyStyleArgs({}, args);
  if (kind === "path") {
    if (!style.fill && !style.stroke) {
      if (closed) style.fill = { value: "#3366ff" };
      else style.stroke = { value: "#1a1a1a" };
    }
    if (style.stroke && style.strokeWidth === undefined) style.strokeWidth = 2;
  }
  if (kind === "polygon" && !style.fill && !style.stroke) style.fill = { value: "#3366ff" };
  if (kind === "frame" && !style.fill && !style.stroke) style.fill = { value: "#ffffff" };
  return style;
}

/** 图片：base64 落宿主资源库；链接图只记 URL，尺寸等渲染层抓到后补齐。 */
async function resolveImageRef(
  ctx: ToolContext,
  args: Record<string, unknown>,
  isImage: boolean,
): Promise<DocNode["image"]> {
  if (!isImage) return undefined;
  const spec = args.image as { data?: unknown; mimeType?: unknown; url?: unknown } | undefined;
  const url = typeof spec?.url === "string" ? spec.url.trim() : "";
  const data = typeof spec?.data === "string" ? spec.data : "";
  if (url && data) throw new Error("image 的 data 与 url 只能给一个");
  if (!url && !data) {
    throw new Error("kind=image 需要 image.data（base64）或 image.url（http/https 链接）");
  }
  if (url) {
    assertImageUrl(url);
    return { sourceUrl: url, naturalWidth: 0, naturalHeight: 0 };
  }
  if (!ctx.host?.addImage) throw new Error("当前宿主不支持插入图片");
  // base64 长度换算出字节数：5MB 上限，避免把一条 JSON-RPC 撑爆
  if (Math.ceil((data.length * 3) / 4) > 5 * 1024 * 1024) {
    throw new Error("图片超过 5MB 上限（GUI 拖入可到 20MB）");
  }
  const asset = await ctx.host.addImage(data, String(spec?.mimeType ?? "image/png"));
  return {
    assetId: asset.assetId,
    naturalWidth: asset.width,
    naturalHeight: asset.height,
    crop: { x: 0, y: 0, width: asset.width, height: asset.height },
  };
}

/** 建一个节点（不含父子关系）：校验 → 取默认值 → `createNode` → 自动布局默认 → 文本测量。 */
async function buildNodeInner(
  ctx: ToolContext,
  args: Record<string, unknown>,
  parentId: NodeId | null,
): Promise<DocNode> {
  const kind = readKind(args);
  const isPath = kind === "path";
  const isPolygon = kind === "polygon";
  const isComponent = kind === "component";

  assertToken(ctx.store, args.fillToken as string | undefined, "fillToken");
  assertToken(ctx.store, args.strokeToken as string | undefined, "strokeToken");
  assertGradientTokens(ctx.store, args);
  if (Array.isArray(args.effects)) assertEffectTokens(ctx.store, effectsFrom(args.effects));

  let name = args.name as string | undefined;
  if (isComponent) name = name ?? nextComponentName(ctx.store.doc, ctx.defaultName?.("component") ?? "组件");
  if (kind === "slot") name = resolveSlotName(ctx, name, parentId);
  // 省略坐标时：主组件排到组件区末尾，其余落在父容器左上角
  const defaultPosition = isComponent ? nextComponentPosition(ctx.store.doc) : { x: 0, y: 0 };

  const { points, closed } = readShapeArgs(kind, args, args.contours !== undefined);
  const contoursArg = readContours(args.contours);
  if (contoursArg) {
    if (kind !== "path") throw new Error("contours 仅适用于 kind=path");
    if (args.points !== undefined) throw new Error("contours 与 points 不能同时给");
  }
  assertNumericTokenArgs(ctx.store, args);
  assertNoLiteralColors(ctx.store, args);
  const style = buildStyleFor(kind, args, closed);
  const imageRef = await resolveImageRef(ctx, args, kind === "image");

  const node = createNode(kind, {
    name: name ?? (isPolygon ? (clampSides(args.sides as number) === 3 ? "三角形" : "多边形") : kind),
    // 路径的 points 是父容器坐标：先放在 0,0，由 ctx.store 归一化并推导节点框
    x: isPath ? 0 : ((args.x as number) ?? defaultPosition.x),
    y: isPath ? 0 : ((args.y as number) ?? defaultPosition.y),
    width: isPath ? 1 : ((args.width as number) ?? (imageRef?.naturalWidth || 100)),
    height: isPath ? 1 : ((args.height as number) ?? (imageRef?.naturalHeight || 100)),
    text: args.text as string | undefined,
    vector: isPath
      ? contoursArg
        ? { contours: contoursArg, fillRule: args.fillRule === "evenodd" ? "evenodd" : "nonzero" }
        : pathFromAnchors(points!, closed)
      : undefined,
    sides: isPolygon ? clampSides(args.sides as number) : undefined,
    image: imageRef,
    style,
    ...applyNodeArgs(args),
  });
  // 与 GUI 一致：新建画板 / 组件默认开启自动布局（AI 显式给了 layout 则以其为准）
  if ((kind === "frame" || kind === "component") && !node.layout) node.layout = defaultLayoutFor(kind);
  // 文本：自动尺寸由宿主注入的测量函数决定
  if (kind === "text" && ctx.measureText && (node.textAutoResize ?? "auto-width") !== "fixed") {
    const size = ctx.measureText(node, resolveNumericStyle(ctx.store.doc, node.style), node.text ?? "");
    node.width = size.width;
    node.height = size.height;
  }
  return node;
}

/** `create_node` */
export const handleCreateNode: Handler = async (ctx, args) => {
    const kind = String(args.kind);
    // 主组件是文档根节点（ADR-0025）：挂在哪个页面下都是错的，直接拒绝
    if (kind === "component" && args.parentId !== undefined && args.parentId !== null) {
      throw new Error("主组件是文档根节点，不接受 parentId");
    }
    const parentId = resolveParentId(ctx, args, kind === "component");
    const node = await buildNodeFromArgs(ctx, args, parentId, "");
    ctx.store.apply({ type: "node.create", params: { nodes: [node], parentId } }, "ai:create");
    return JSON.stringify({ ok: true, nodeId: node.id });
};

/** 嵌套入参 → 前序扁平条目（父先于子），顺带带出路径与父条目 id。 */
interface SpecEntry {
  spec: Record<string, unknown>;
  path: string;
  /** 父条目的 id（顶层为 null）；父子关系由 spec 的 id 决定，不看 doc */
  parentSpecId: string | null;
}

function flattenSpecs(
  items: unknown[],
  path: string,
  parentSpecId: string | null,
  out: SpecEntry[],
): void {
  for (let i = 0; i < items.length; i++) {
    const spec = items[i] as Record<string, unknown> | null;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`INVALID_NODE：${path}[${i}] 必须是对象`);
    }
    // 上限在压栈前判：既限制总量，也把递归深度锁在 500 以内
    if (out.length >= MAX_BATCH_NODES) {
      throw new Error(`TOO_MANY_NODES：单次最多 ${MAX_BATCH_NODES} 个节点（含子孙），请分批调用`);
    }
    const here = `${path}[${i}]`;
    out.push({ spec, path: here, parentSpecId });
    const children = spec.children;
    if (children === undefined) continue;
    if (!Array.isArray(children)) throw new Error(`INVALID_NODE：${here}.children 必须是数组`);
    flattenSpecs(children, `${here}.children`, typeof spec.id === "string" ? spec.id : null, out);
  }
}

/** `create_nodes`：一次建一整棵子树——一个事务、一个撤销步。 */
export const handleCreateNodes: Handler = async (ctx, args) => {
    const raw = args.nodes;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("create_nodes 需要 nodes（非空数组）");

    // —— 阶段 1：纯结构校验，先全过再建（中途抛错时 transact 回滚，DocState 无变更）
    const specs: SpecEntry[] = [];
    flattenSpecs(raw, "nodes", null, specs);

    const seen = new Set<string>();
    for (const { spec, path } of specs) {
      const id = spec.id;
      if (typeof id !== "string" || !id.trim()) {
        throw new Error(`ID_REQUIRED：${path} 缺少 id（批量建树的 id 必须由调用方生成）`);
      }
      if (seen.has(id)) throw new Error(`DUPLICATE_ID：${path} 的 id ${id} 在本次调用内重复`);
      if (ctx.store.doc.nodes[id]) throw new Error(`DUPLICATE_ID：${path} 的 id ${id} 已存在于文档`);
      seen.add(id);
    }
    for (const { spec, path, parentSpecId } of specs) {
      const kind = String(spec.kind);
      if (!NODE_KINDS.has(kind)) {
        throw new Error(`INVALID_NODE：${path} 的 kind=${kind} 不支持；可选 ${[...NODE_KINDS].join("/")}`);
      }
      if (parentSpecId !== null && (kind === "component" || kind === "slot")) {
        throw new Error(`NESTED_SPECIAL_KIND：${path} 的 kind=${kind} 不能出现在 children 里，改用 create_node`);
      }
    }

    const top = specs.filter((s) => s.parentSpecId === null);
    const topComponents = top.filter((s) => String(s.spec.kind) === "component");
    let parentId: NodeId | null;
    if (topComponents.length > 0) {
      if (args.parentId !== undefined && args.parentId !== null) {
        throw new Error("主组件是文档根节点，不接受 parentId");
      }
      // validateOne 要求主组件是这一批里唯一的根节点
      if (top.length > 1) throw new Error("主组件必须单独一次调用，不能与其它顶层节点同批创建");
      parentId = null;
    } else {
      parentId = resolveParentId(ctx, args, false);
    }

    // —— 阶段 2：按前序建节点（异步：图片要落宿主资源库；失败同样被 transact 回滚）
    const built: DocNode[] = [];
    for (const { spec, path, parentSpecId } of specs) {
      const node = await buildNodeFromArgs(ctx, spec, parentSpecId ?? parentId, path);
      // id 由调用方生成（不变式 2）：createNode 内部先填了一个自己的 id，这里覆盖成调用方给的。
      // 阶段 1 已确认它是非空且全文档唯一的字符串。
      node.id = String(spec.id);
      // node.create 只把 nodes[0] 挂到 parentId：其余节点靠自带 parentId
      // + 父节点的 children 数组（与 duplicate 的 expandDuplicate 同一约定）
      if (Array.isArray(spec.children)) {
        node.children = spec.children.map((c) => String((c as { id?: unknown }).id));
      }
      if (parentSpecId !== null) node.parentId = parentSpecId;
      built.push(node);
    }

    // 前序数组里每个顶层节点的子树是连续一段；一个 node.create 只挂 nodes[0]，
    // 所以多个顶层根要像 duplicate 的 expandDuplicate 那样一条命令一个根。
    // 整批放在一次 store.apply 里 + 执行器的 transact，仍然只有一个撤销步。
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < specs.length; i++) {
      if (specs[i].parentSpecId !== null) continue;
      if (ranges.length > 0) ranges[ranges.length - 1].end = i;
      ranges.push({ start: i, end: specs.length });
    }
    const commands: Command[] = ranges.map((r) => ({
      type: "node.create",
      params: { nodes: built.slice(r.start, r.end), parentId },
    }));
    ctx.store.apply(commands, "ai:create");
    return JSON.stringify({ ok: true, created: built.map((n) => n.id), count: built.length });
};

/** `update_node` */
export const handleUpdateNode: Handler = async (ctx, args) => {
    const nodeId = args.nodeId as NodeId;
    const node = ctx.store.doc.nodes[nodeId];
    if (!node) throw new Error(`节点 ${nodeId} 不存在`);
    assertToken(ctx.store, args.fillToken as string | undefined, "fillToken");
    assertToken(ctx.store, args.strokeToken as string | undefined, "strokeToken");
    assertGradientTokens(ctx.store, args);
    assertNumericTokenArgs(ctx.store, args);
    assertNoLiteralColors(ctx.store, args);
    if (Array.isArray(args.effects)) assertEffectTokens(ctx.store, effectsFrom(args.effects));

    if (
      args.layout !== undefined &&
      node.type !== "frame" &&
      node.type !== "component" &&
      node.type !== "componentSet" &&
      node.type !== "instance"
    ) {
      throw new Error("layout 仅适用于 frame / component / instance");
    }
    const patch: Partial<DocNode> = { ...applyNodeArgs(args, node.layout ?? undefined) };
    if (args.name !== undefined) {
      const name = String(args.name).trim();
      if (!name) throw new Error("name 不能为空");
      patch.name = name;
    }

    if (args.backgroundImage !== undefined) {
      if (node.type !== "page") throw new Error("backgroundImage 仅适用于页面");
      const spec = args.backgroundImage as
        | { data?: string; mimeType?: string; assetId?: string; fit?: "cover" | "contain" | "tile" }
        | null;
      if (spec === null) {
        patch.backgroundImage = undefined;
      } else if (spec?.assetId) {
        // 尺寸由解码后的位图决定，不在模型里写伪值
        patch.backgroundImage = { assetId: spec.assetId, fit: spec.fit ?? "cover" };
      } else if (spec?.data) {
        if (!ctx.host?.addImage) throw new Error("当前宿主不支持图片");
        if (Math.ceil((spec.data.length * 3) / 4) > 5 * 1024 * 1024) {
          throw new Error("背景图超过 5MB 上限");
        }
        const asset = await ctx.host.addImage(spec.data, String(spec.mimeType ?? "image/png"));
        patch.backgroundImage = {
          assetId: asset.assetId,
          naturalWidth: asset.width,
          naturalHeight: asset.height,
          fit: spec.fit ?? "cover",
        };
      } else {
        throw new Error("backgroundImage 需要 data 或 assetId");
      }
    }

    const style = applyStyleArgs(node.style, args);
    if (JSON.stringify(style) !== JSON.stringify(node.style)) patch.style = style;

    if (args.mask !== undefined) patch.isMask = Boolean(args.mask);
    if (args.crop !== undefined) {
      if (node.type !== "image" || !node.image) throw new Error("crop 仅适用于图片节点");
      if (!(node.image.naturalWidth > 0) || !(node.image.naturalHeight > 0)) {
        throw new Error("这张链接图还没加载完，暂时无法裁切；先让它显示出来再改 crop");
      }
      const raw = args.crop as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
      const current = node.image.crop ?? {
        x: 0,
        y: 0,
        width: node.image.naturalWidth,
        height: node.image.naturalHeight,
      };
      patch.image = {
        ...node.image,
        crop: {
          x: Number(raw.x ?? current.x),
          y: Number(raw.y ?? current.y),
          width: Number(raw.width ?? current.width),
          height: Number(raw.height ?? current.height),
        },
      };
    }
    // 放在 crop 之后：换源会整体替换 image（裁切与尺寸都作废），不能被上一步覆盖回去
    if (args.imageUrl !== undefined) {
      if (node.type !== "image") throw new Error("imageUrl 仅适用于图片节点");
      const raw = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
      if (!raw) throw new Error("imageUrl 不能为空");
      assertImageUrl(raw);
      // 换源：尺寸与原图裁切都作废，抓到后由渲染层按实际尺寸铺满
      patch.image = { sourceUrl: raw, naturalWidth: 0, naturalHeight: 0 };
    }

    const points = readPoints(args.points);
    const contoursArg = readContours(args.contours);
    const fillRuleArg =
      args.fillRule === "evenodd" ? "evenodd" : args.fillRule === "nonzero" ? "nonzero" : undefined;
    const closedArg = args.closed !== undefined ? Boolean(args.closed) : undefined;
    if (args.sides !== undefined) {
      if (node.type !== "polygon") throw new Error("sides 仅适用于 polygon 节点");
      patch.sides = clampSides(Number(args.sides));
    }
    if (contoursArg) {
      if (node.type !== "path") throw new Error("contours 仅适用于 path 节点");
      if (points) throw new Error("contours 与 points 不能同时给");
      if (closedArg !== undefined) throw new Error("contours 与 closed 不能同时给；闭合写在每条轮廓的 closed 上");
      patch.vector = { contours: contoursArg, fillRule: fillRuleArg ?? node.vector?.fillRule ?? "nonzero" };
    } else if (fillRuleArg) {
      if (!node.vector) throw new Error("fillRule 仅适用于 path 节点");
      patch.vector = { contours: node.vector.contours, fillRule: fillRuleArg };
    } else if (points) {
      if (node.type !== "path") throw new Error("points 仅适用于 path 节点");
      if (!node.vector) throw new Error("path 节点缺少轮廓数据");
      // 多轮廓路径上写 points 会静默丢掉别的轮廓（洞），必须显式拒绝
      if (node.vector.contours.length > 1) throw new AppError("core.path.multiContour");
      if (points.length < 2) throw new Error("路径至少需要 2 个锚点");
      const anchors = points.map((p) => ({ ...p, x: p.x - node.x, y: p.y - node.y }));
      patch.vector = replaceContour(node.vector, 0, {
        closed: closedArg ?? node.vector.contours[0]?.closed ?? false,
        anchors,
      });
    } else if (closedArg !== undefined) {
      if (!node.vector) throw new Error("closed 仅适用于 path 节点");
      patch.vector = replaceContour(node.vector, 0, {
        closed: closedArg,
        anchors: node.vector.contours[0]?.anchors ?? [],
      });
    }

    // 文本自动尺寸：文本或排版变化后重算
    if (node.type === "text" && ctx.measureText) {
      const mode = (patch.textAutoResize ?? node.textAutoResize ?? "auto-width") as TextAutoResize;
      const text = (patch.text ?? node.text ?? "") as string;
      const style = (patch.style ?? node.style) as NodeStyle;
      if (mode !== "fixed") {
        const size = ctx.measureText(
          { ...node, ...patch, style },
          resolveNumericStyle(ctx.store.doc, style),
          text,
        );
        if (mode === "auto-width") patch.width = size.width;
        patch.height = size.height;
      }
    }
    ctx.store.apply({ type: "node.update", params: { nodeId, patch } }, "ai:update");
    return JSON.stringify({ ok: true });
};

/** `move_node` */
export const handleMoveNode: Handler = async (ctx, args) => {
    const nodeId = String(args.nodeId);
    const parentId = String(args.parentId);
    const node = ctx.store.doc.nodes[nodeId];
    if (!node) throw new Error(`节点 ${nodeId} 不存在`);
    const parent = ctx.store.doc.nodes[parentId];
    if (!parent) throw new Error(`父节点 ${parentId} 不存在`);
    if (node.type === "component") throw new Error("主组件固定在文档根节点，不能移动父级");
    if (node.type === "componentSet") throw new Error("组件集合固定在文档根节点，不能移动父级");
    const world = worldRect(ctx.store.doc, nodeId);
    const parentWorld = worldRect(ctx.store.doc, parentId);
    if (!world || !parentWorld) throw new Error("节点或父节点没有几何信息");
    // 进流与否跟画布拖动一致：自动布局容器默认进流，absolute 保留绝对定位
    const inFlow = Boolean(parent.layout) && args.absolute !== true;
    const commands: Command[] = [
      {
        type: "node.reparent",
        params: {
          nodeId,
          parentId,
          x: world.x - parentWorld.x,
          y: world.y - parentWorld.y,
          ...(inFlow ? { index: typeof args.index === "number" ? args.index : parent.children.length } : {}),
        },
      },
    ];
    if (parent.layout) {
      const wantAbsolute = !inFlow;
      if (Boolean(node.layoutAbsolute) !== wantAbsolute) {
        commands.push({ type: "node.update", params: { nodeId, patch: { layoutAbsolute: wantAbsolute } } });
      }
    }
    ctx.store.apply(commands, "ai:move");
    return JSON.stringify({ ok: true, nodeId, parentId, inFlow });
};

/** `delete_node` */
export const handleDeleteNode: Handler = async (ctx, args) => {
    const nodeId = args.nodeId as NodeId;
    if (!ctx.store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
    ctx.store.apply({ type: "node.delete", params: { nodeId } }, "ai:delete");
    return JSON.stringify({ ok: true });
};

/** `group_nodes` */
export const handleGroupNodes: Handler = async (ctx, args) => {
    const nodeIds = args.nodeIds as NodeId[];
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) throw new Error("group_nodes 需要 nodeIds");
    const groupId = newId();
    ctx.store.apply(
      { type: "node.group", params: { nodeIds, groupId, name: args.name as string | undefined } },
      "ai:group",
    );
    return JSON.stringify({ ok: true, groupId });
};

/** `arrange_nodes` */
export const handleArrangeNodes: Handler = async (ctx, args) => {
    const nodeIds = args.nodeIds as NodeId[];
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) throw new Error("arrange_nodes 需要 nodeIds");
    const action = String(args.action ?? "");
    const ALIGN: Record<string, AlignEdge> = {
      "align-left": "left",
      "align-h-center": "h-center",
      "align-right": "right",
      "align-top": "top",
      "align-v-center": "v-center",
      "align-bottom": "bottom",
    };
    const DISTRIBUTE: Record<string, DistributeAxis> = {
      "distribute-h": "horizontal",
      "distribute-v": "vertical",
    };
    const REORDER: Record<string, ReorderAction> = {
      "bring-forward": "forward",
      "send-backward": "backward",
      "bring-to-front": "front",
      "send-to-back": "back",
    };
    if (ALIGN[action]) {
      ctx.store.apply({ type: "node.align", params: { nodeIds, align: ALIGN[action] } }, "ai:align");
    } else if (DISTRIBUTE[action]) {
      ctx.store.apply({ type: "node.distribute", params: { nodeIds, axis: DISTRIBUTE[action] } }, "ai:distribute");
    } else if (REORDER[action]) {
      ctx.store.apply({ type: "node.reorder", params: { nodeIds, action: REORDER[action] } }, "ai:reorder");
    } else {
      throw new Error(`arrange_nodes 不支持的动作: ${action}`);
    }
    return JSON.stringify({ ok: true });
};

/** `duplicate_node` */
export const handleDuplicateNode: Handler = async (ctx, args) => {
    const nodeId = args.nodeId as NodeId;
    if (!ctx.store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
    const plan = planDuplicate(ctx.store.doc, [nodeId], {
      dx: typeof args.offsetX === "number" ? args.offsetX : 10,
      dy: typeof args.offsetY === "number" ? args.offsetY : 10,
      makeId: newId,
    });
    ctx.store.apply(plan.command, "ai:duplicate");
    return JSON.stringify({ ok: true, nodeIds: plan.rootIds });
};
