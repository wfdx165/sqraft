// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { AlignEdge, Command, DistributeAxis, DocNode, NodeId, NodeStyle, ReorderAction, TextAutoResize } from "../shared";
import { applyNodeArgs, applyStyleArgs, assertEffectTokens, assertImageUrl, assertNumericTokenArgs, assertToken, clampSides, createNode, defaultLayoutFor, effectsFrom, ensurePage, firstPageId, newId, nextComponentName, nextComponentPosition, planDuplicate, readPoints, resolveNumericStyle, validateVector, walkSubtree, worldRect } from "../shared";
import type { Handler } from "../types";

/** `create_node` */
export const handleCreateNode: Handler = async (ctx, args) => {
    const kind = String(args.kind) as
      | "frame" | "rect" | "ellipse" | "polygon" | "line" | "path" | "text" | "image"
      | "component" | "slot";
    const isImage = kind === "image";
    const isPath = kind === "path";
    const isPolygon = kind === "polygon";
    const isComponent = kind === "component";
    const isSlot = kind === "slot";
    assertToken(ctx.store, args.fillToken as string | undefined, "fillToken");
    assertToken(ctx.store, args.strokeToken as string | undefined, "strokeToken");
    if (Array.isArray(args.effects)) assertEffectTokens(ctx.store, effectsFrom(args.effects));
    // 主组件是文档根节点（ADR-0025）：挂在哪个页面下都是错的，直接拒绝
    if (isComponent && args.parentId !== undefined && args.parentId !== null) {
      throw new Error("主组件是文档根节点，不接受 parentId");
    }
    // 空文档没有页面：先建一页再画（与人工"新建页面"同一套命令，仍是一次撤销）
    let parentId: NodeId | null = isComponent
      ? null
      : ((args.parentId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc));
    if (!isComponent) {
      if (!parentId && args.parentId === undefined) parentId = ensurePage(ctx.store, ctx.defaultName?.("page") ?? "页面");
      if (!parentId || !ctx.store.doc.nodes[parentId]) throw new Error("parentId 不存在");
    }

    let name = args.name as string | undefined;
    if (isComponent) name = name ?? nextComponentName(ctx.store.doc, ctx.defaultName?.("component") ?? "组件");
    // 省略坐标时：主组件排到组件区末尾，其余落在父容器左上角
    const defaultPosition = isComponent ? nextComponentPosition(ctx.store.doc) : { x: 0, y: 0 };
    if (isSlot) {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) throw new Error("kind=slot 必须提供唯一的 name");
      name = trimmed;
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
    assertNumericTokenArgs(ctx.store, args);
    const style = applyStyleArgs({}, args);
    if (isPath) {
      // 与 GUI 一致：未显式给颜色时，闭合默认填充、开放默认描边
      if (!style.fill && !style.stroke) {
        if (closed) style.fill = { value: "#3366ff" };
        else style.stroke = { value: "#1a1a1a" };
      }
      if (style.stroke && style.strokeWidth === undefined) style.strokeWidth = 2;
    }
    if (isPolygon && !style.fill && !style.stroke) style.fill = { value: "#3366ff" };
    // 画板与 GUI 工具一致：默认白底
    if (kind === "frame" && !style.fill && !style.stroke) style.fill = { value: "#ffffff" };

    let imageRef: DocNode["image"];
    if (isImage) {
      const spec = args.image as { data?: unknown; mimeType?: unknown; url?: unknown } | undefined;
      const url = typeof spec?.url === "string" ? spec.url.trim() : "";
      const data = typeof spec?.data === "string" ? spec.data : "";
      if (url && data) throw new Error("image 的 data 与 url 只能给一个");
      if (!url && !data) {
        throw new Error("kind=image 需要 image.data（base64）或 image.url（http/https 链接）");
      }
      if (url) {
        assertImageUrl(url);
        // 链接图懒加载：尺寸未知，抓到时由渲染层用实际尺寸补齐
        imageRef = { sourceUrl: url, naturalWidth: 0, naturalHeight: 0 };
      } else {
        if (!ctx.host?.addImage) throw new Error("当前宿主不支持插入图片");
        // base64 长度换算出字节数：5MB 上限，避免把一条 JSON-RPC 撑爆
        if (Math.ceil((data.length * 3) / 4) > 5 * 1024 * 1024) {
          throw new Error("图片超过 5MB 上限（GUI 拖入可到 20MB）");
        }
        const asset = await ctx.host.addImage(data, String(spec?.mimeType ?? "image/png"));
        imageRef = {
          assetId: asset.assetId,
          naturalWidth: asset.width,
          naturalHeight: asset.height,
          crop: { x: 0, y: 0, width: asset.width, height: asset.height },
        };
      }
    }

    const node = createNode(kind, {
      name: name ?? (isPolygon ? (clampSides(args.sides as number) === 3 ? "三角形" : "多边形") : kind),
      // 路径的 points 是父容器坐标：先放在 0,0，由 ctx.store 归一化并推导节点框
      x: isPath ? 0 : ((args.x as number) ?? defaultPosition.x),
      y: isPath ? 0 : ((args.y as number) ?? defaultPosition.y),
      width: isPath ? 1 : ((args.width as number) ?? (imageRef?.naturalWidth || 100)),
      height: isPath ? 1 : ((args.height as number) ?? (imageRef?.naturalHeight || 100)),
      text: args.text as string | undefined,
      vector: isPath ? { closed, anchors: points! } : undefined,
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
    ctx.store.apply({ type: "node.create", params: { nodes: [node], parentId } }, "ai:create");
    return JSON.stringify({ ok: true, nodeId: node.id });
};

/** `update_node` */
export const handleUpdateNode: Handler = async (ctx, args) => {
    const nodeId = args.nodeId as NodeId;
    const node = ctx.store.doc.nodes[nodeId];
    if (!node) throw new Error(`节点 ${nodeId} 不存在`);
    assertToken(ctx.store, args.fillToken as string | undefined, "fillToken");
    assertToken(ctx.store, args.strokeToken as string | undefined, "strokeToken");
    assertNumericTokenArgs(ctx.store, args);
    if (Array.isArray(args.effects)) assertEffectTokens(ctx.store, effectsFrom(args.effects));

    if (args.layout !== undefined && node.type !== "frame" && node.type !== "component" && node.type !== "instance") {
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
