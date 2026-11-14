// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { DocNode, MatchField, NodeId } from "../shared";
import { PADDING_SIDE_KEYS, READ_DEPTH_DEFAULT, READ_DEPTH_MAX, READ_LIMIT_DEFAULT, READ_LIMIT_MAX, SEARCH_TYPES, clampIntArg, collectSlice, countSubtree, diagnose, firstPageId, getPages, getRootComponents, pageOfNode, pathOf, resolveNumericLayout, snippetOf, worldRect } from "../shared";
import type { Handler } from "../types";

/** `read_document` */
export const handleReadDocument: Handler = async (ctx, args) => {
    const scope = typeof args.scope === "string" ? args.scope : "page";
    if (scope !== "page" && scope !== "subtree" && scope !== "document") {
      throw new Error("scope 只能是 page / subtree / document");
    }
    const tokenCount = Object.keys(ctx.store.doc.tokens).length;
    const deprecatedHint =
      args.includeComponentTrees === true
        ? 'includeComponentTrees is deprecated: use read_document({scope:"subtree", subtreeId:<componentId>}) instead.'
        : undefined;
    if (scope === "document") {
      const pages = getPages(ctx.store.doc).map((page) => ({
        pageId: page.id,
        name: page.name,
        width: page.width,
        height: page.height,
        nodeCount: countSubtree(ctx.store, page.id),
      }));
      // 主组件是文档根节点，不在任何页面里：只给摘要，看内部用 scope=subtree
      const components = getRootComponents(ctx.store.doc).map((c) => ({
        componentId: c.id,
        name: c.name,
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        nodeCount: countSubtree(ctx.store, c.id),
        ...(c.propertyDefs?.length
          ? { propertyDefs: c.propertyDefs.map((d) => ({ id: d.id, type: d.type, name: d.name })) }
          : {}),
      }));
      return JSON.stringify({
        scope,
        pages,
        components,
        tokenCount,
        truncated: false,
        hasMore: false,
        ...(deprecatedHint ? { hint: deprecatedHint } : {}),
      });
    }
    const depth = clampIntArg(args.depth, READ_DEPTH_DEFAULT, 0, READ_DEPTH_MAX, "depth");
    const limit = clampIntArg(args.limit, READ_LIMIT_DEFAULT, 1, READ_LIMIT_MAX, "limit");
    let rootId: NodeId | null = null;
    if (scope === "subtree") {
      const id = typeof args.subtreeId === "string" ? args.subtreeId : "";
      if (!id) throw new Error("scope=subtree 需要 subtreeId");
      if (!ctx.store.doc.nodes[id]) throw new Error(`节点 ${id} 不存在`);
      rootId = id;
    } else {
      const requested = typeof args.pageId === "string" ? args.pageId : undefined;
      const active = requested ?? ctx.getActivePageId?.() ?? undefined;
      if (active) {
        const page = ctx.store.doc.nodes[active];
        if (!page) throw new Error(`页面 ${active} 不存在`);
        if (page.type !== "page") throw new Error(`节点 ${active} 不是页面`);
        rootId = page.id;
      } else {
        rootId = getPages(ctx.store.doc)[0]?.id ?? null;
      }
    }
    if (!rootId) {
      // 空文档：不给页面、也不替 agent 建页（读工具没有副作用）
      return JSON.stringify({
        scope,
        pageId: null,
        rootId: null,
        depth,
        nodes: [],
        tokenCount,
        truncated: false,
        hasMore: false,
        hint: "This document has no pages yet.",
      });
    }
    const slice = collectSlice(ctx.store, rootId, depth, limit);
    const hints: string[] = [];
    if (slice.truncated) {
      hints.push(
        `Truncated at ${limit} nodes: raise limit (max ${READ_LIMIT_MAX}), lower depth, or read a child subtree with scope:"subtree".`,
      );
    }
    if (deprecatedHint) hints.push(deprecatedHint);
    return JSON.stringify({
      scope,
      pageId: pageOfNode(ctx.store.doc, rootId),
      rootId,
      depth,
      nodes: slice.nodes,
      tokenCount,
      truncated: slice.truncated,
      hasMore: slice.truncated,
      ...(hints.length ? { hint: hints.join(" ") } : {}),
    });
};

/** `search_nodes` */
export const handleSearchNodes: Handler = async (ctx, args) => {
    const pick = (key: string): string | undefined => {
      const raw = args[key];
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim();
      return trimmed ? trimmed : undefined;
    };
    const name = pick("name");
    const text = pick("text");
    const fillToken = pick("fillToken");
    const strokeToken = pick("strokeToken");
    const componentId = pick("componentId");
    const pageFilter = pick("pageId");
    let types: Set<string> | null = null;
    if (args.type !== undefined && args.type !== null) {
      const rawTypes = Array.isArray(args.type) ? args.type : [args.type];
      if (rawTypes.length === 0) throw new Error("type 不能是空数组");
      types = new Set(
        rawTypes.map((raw) => {
          const value = String(raw).trim();
          if (!SEARCH_TYPES.has(value)) throw new Error(`未知节点类型: ${value}`);
          return value;
        }),
      );
    }
    if (!name && !text && !types && !fillToken && !strokeToken && !componentId) {
      throw new Error(
        "search_nodes 至少需要一个过滤条件：name / text / type / fillToken / strokeToken / componentId",
      );
    }
    const limit = clampIntArg(args.limit, 20, 1, 200, "limit");
    const includeHidden = args.includeHidden === true;
    let roots: Array<{ id: NodeId; kind: "page" | "component" }>;
    if (pageFilter) {
      const page = ctx.store.doc.nodes[pageFilter];
      if (!page) throw new Error(`页面 ${pageFilter} 不存在`);
      if (page.type !== "page") throw new Error(`节点 ${pageFilter} 不是页面`);
      roots = [{ id: page.id, kind: "page" }];
    } else {
      // 页面在前、组件母版在后：顺序稳定，命中行可复现
      roots = [
        ...getPages(ctx.store.doc).map((page) => ({ id: page.id, kind: "page" as const })),
        ...getRootComponents(ctx.store.doc).map((c) => ({ id: c.id, kind: "component" as const })),
      ];
    }
    const needleName = name?.toLowerCase() ?? "";
    const needleText = text?.toLowerCase() ?? "";
    const matchOf = (node: DocNode): { field: MatchField; snippet: string } | null => {
      // 全部条件都要通过；命中摘要按固定优先级挑第一个命中的字段
      let field: MatchField | null = null;
      let snippet = "";
      if (needleName) {
        if (!node.name.toLowerCase().includes(needleName)) return null;
        field = "name";
        snippet = snippetOf(node.name);
      }
      if (needleText) {
        if (node.type !== "text" || !(node.text ?? "").toLowerCase().includes(needleText)) return null;
        if (!field) {
          field = "text";
          snippet = snippetOf(node.text);
        }
      }
      if (types) {
        if (!types.has(node.type)) return null;
        if (!field) {
          field = "type";
          snippet = node.type;
        }
      }
      if (fillToken) {
        if (node.style.fill?.token !== fillToken) return null;
        if (!field) {
          field = "fillToken";
          snippet = fillToken;
        }
      }
      if (strokeToken) {
        if (node.style.stroke?.token !== strokeToken) return null;
        if (!field) {
          field = "strokeToken";
          snippet = strokeToken;
        }
      }
      if (componentId) {
        if (node.componentId !== componentId && node.id !== componentId) return null;
        if (!field) {
          field = "componentId";
          snippet = componentId;
        }
      }
      return field ? { field, snippet } : null;
    };
    const hits: Array<Record<string, unknown>> = [];
    let hasMore = false;
    const visit = (id: NodeId, root: { id: NodeId; kind: "page" | "component" }): boolean => {
      const node: DocNode | undefined = ctx.store.doc.nodes[id];
      if (!node) return true;
      // 隐藏节点整棵跳过：看不见的东西不该出现在搜索结果里
      if (!includeHidden && !node.visible) return true;
      const match = matchOf(node);
      if (match) {
        if (hits.length >= limit) {
          hasMore = true;
          return false;
        }
        hits.push({
          id: node.id,
          name: node.name,
          type: node.type,
          parentId: node.parentId,
          rootKind: root.kind,
          rootId: root.id,
          ...(node.componentId ? { componentId: node.componentId } : {}),
          path: pathOf(ctx.store.doc, node.id),
          match,
        });
      }
      for (const child of node.children) {
        if (!visit(child, root)) return false;
      }
      return true;
    };
    for (const root of roots) {
      if (!visit(root.id, root)) break;
    }
    return JSON.stringify({
      hits,
      hasMore,
      ...(hasMore
        ? { hint: `More matches exist: raise limit (max 200) or add a filter such as pageId.` }
        : hits.length === 0
          ? { hint: "No matches. Try a shorter substring; use get_tokens to list token paths." }
          : {}),
    });
};

/** `get_selection` */
export const handleGetSelection: Handler = async (ctx, args) => {
    const ids = ctx.getSelection?.() ?? [];
    const nodes = ids
      .map((id) => ctx.store.doc.nodes[id])
      .filter((node): node is DocNode => Boolean(node))
      .map((node) => {
        const box = worldRect(ctx.store.doc, node.id);
        return {
          id: node.id,
          name: node.name,
          type: node.type,
          parentId: node.parentId,
          x: Math.round((box?.x ?? 0) * 100) / 100,
          y: Math.round((box?.y ?? 0) * 100) / 100,
          width: node.width,
          height: node.height,
          locked: node.locked,
          visible: node.visible,
          // 实例指回主组件；实例子孙指回母版里对应的那个节点
          ...(node.type === "instance" ? { componentId: node.componentId } : {}),
          ...(node.mainId ? { mainId: node.mainId } : {}),
        };
      });
    return JSON.stringify({
      // 明确叫 activePageId：根级主组件被选中时它仍然指向当前页面，不代表选区所属页面
      activePageId: ctx.getActivePageId?.() ?? null,
      nodeIds: nodes.map((node) => node.id),
      nodes,
      ...(nodes.length === 0 ? { hint: "画布上没有选中对象" } : {}),
    });
};

/** `inspect_layout` */
export const handleInspectLayout: Handler = async (ctx, args) => {
    const pageId = (args.pageId as NodeId | undefined) ?? ctx.getActivePageId?.() ?? firstPageId(ctx.store.doc);
    const page = pageId ? ctx.store.doc.nodes[pageId] : null;
    if (!page || page.type !== "page") throw new Error("pageId 不存在或不是页面");
    // nodeIds 是"根"：每棵都含整棵子树。被另一个 id 包含的后代去掉，避免重复输出。
    const only = Array.isArray(args.nodeIds) ? new Set(args.nodeIds as NodeId[]) : null;
    let roots: NodeId[];
    if (only) {
      roots = [...only].filter((id) => {
        if (!ctx.store.doc.nodes[id]) return false;
        let cur = ctx.store.doc.nodes[id];
        while (cur?.parentId) {
          if (only.has(cur.parentId)) return false;
          cur = ctx.store.doc.nodes[cur.parentId];
        }
        return true;
      });
    } else {
      roots = [...page.children];
    }
    const rows: unknown[] = [];
    const emitted = new Set<NodeId>();
    const visit = (id: NodeId, depth: number) => {
      const node = ctx.store.doc.nodes[id];
      if (!node || emitted.has(id)) return;
      emitted.add(id);
      const box = worldRect(ctx.store.doc, id);
      const resolved = node.layout ? resolveNumericLayout(ctx.store.doc, node.layout) : null;
      const layoutDiffers =
        Boolean(resolved && node.layout) &&
        (resolved!.gap !== node.layout!.gap ||
          resolved!.crossGap !== node.layout!.crossGap ||
          PADDING_SIDE_KEYS.some((side) => resolved!.padding[side] !== node.layout!.padding[side]));
      rows.push({
        id: node.id,
        name: node.name,
        type: node.type,
        depth,
        x: Math.round((box?.x ?? 0) * 100) / 100,
        y: Math.round((box?.y ?? 0) * 100) / 100,
        width: node.width,
        height: node.height,
        absolute: Boolean(node.layoutAbsolute),
        sizingW: node.layoutSizingW,
        sizingH: node.layoutSizingH,
        layout: node.layout ?? null,
        // 有数值 Token 时给出解析后的实际值；agent 不必自己拿 Token 表换算
        resolved: layoutDiffers && resolved
          ? { gap: resolved.gap, crossGap: resolved.crossGap, padding: resolved.padding }
          : undefined,
      });
      for (const childId of node.children) visit(childId, depth + 1);
    };
    for (const rootId of roots) visit(rootId, 0);
    // 只读查询：诊断描述的是「当前状态」，不是「本次改动」；几何行保持不变
    const diag = diagnose(ctx.store.doc, roots, { measure: ctx.measureLine });
    return JSON.stringify({
      pageId: page.id,
      nodes: rows,
      ...(diag.diagnostics.length ? { diagnostics: diag.diagnostics } : {}),
      ...(diag.truncated ? { diagnosticsTruncated: true } : {}),
    });
};
