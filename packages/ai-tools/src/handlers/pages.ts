// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import type { Interaction, NodeId } from "../shared";
import { DEFAULT_DISSOLVE_MS, DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH, createNode, getPages, newId, nextPageName, nextPagePosition, walkSubtree } from "../shared";
import type { Handler } from "../types";

/** `set_interaction` */
export const handleSetInteraction: Handler = async (ctx, args) => {
    const nodeId = args.nodeId as NodeId;
    const node = ctx.store.doc.nodes[nodeId];
    if (!node) throw new Error(`节点 ${nodeId} 不存在`);
    const action = String(args.action);
    if (action !== "navigate" && action !== "back") throw new Error("action 只能是 navigate 或 back");

    let targetId: NodeId | undefined;
    if (action === "navigate") {
      targetId = String(args.targetPageId ?? "");
      if (!targetId) throw new Error("action=navigate 需要 targetPageId");
      const target = ctx.store.doc.nodes[targetId];
      if (!target) throw new Error(`目标页面 ${targetId} 不存在`);
      if (target.type !== "page") throw new Error(`节点 ${targetId} 不是页面，链接只能跳到页面`);
    }

    const type = action === "back" ? "instant" : args.transition === "instant" ? "instant" : "dissolve";
    const raw = args.durationMs === undefined ? DEFAULT_DISSOLVE_MS : Number(args.durationMs);
    if (!Number.isFinite(raw)) throw new Error("durationMs 必须是数字");
    const link: Interaction = {
      // 复用第一条交互的 id：外部按 id 记账时不会因为改目标而失效
      id: node.interactions?.[0]?.id ?? newId(),
      trigger: "click",
      action,
      ...(targetId ? { targetId } : {}),
      transition: { type, durationMs: type === "instant" ? 0 : raw },
    };
    // 只替换第一条点击交互，agent 写入的其余交互保持不动
    const rest = (node.interactions ?? []).slice(1);
    ctx.store.apply(
      { type: "node.update", params: { nodeId, patch: { interactions: [link, ...rest] } } },
      "ai:interaction",
    );
    return JSON.stringify({
      ok: true,
      id: link.id,
      nodeId,
      action,
      ...(targetId ? { targetPageId: targetId } : {}),
      transition: link.transition.type,
      durationMs: link.transition.durationMs,
    });
};

/** `remove_interaction` */
export const handleRemoveInteraction: Handler = async (ctx, args) => {
    const nodeId = args.nodeId as NodeId;
    if (!ctx.store.doc.nodes[nodeId]) throw new Error(`节点 ${nodeId} 不存在`);
    ctx.store.apply({ type: "node.update", params: { nodeId, patch: { interactions: undefined } } }, "ai:interaction");
    return JSON.stringify({ ok: true, nodeId });
};

/** `list_interactions` */
export const handleListInteractions: Handler = async (ctx, args) => {
    const pages = getPages(ctx.store.doc).map((page) => {
      const links: unknown[] = [];
      walkSubtree(ctx.store.doc, page.id, (n) => {
        for (const link of n.interactions ?? []) {
          const target = link.targetId ? ctx.store.doc.nodes[link.targetId] : null;
          links.push({
            nodeId: n.id,
            name: n.name,
            action: link.action,
            ...(target ? { target: { pageId: target.id, name: target.name } } : {}),
            transition: link.transition.type,
            durationMs: link.transition.durationMs,
          });
        }
      });
      return { pageId: page.id, name: page.name, scroll: page.scrollDirection ?? "none", links };
    });
    return JSON.stringify({ pages });
};

/** `create_page` */
export const handleCreatePage: Handler = async (ctx, args) => {
    const position = nextPagePosition(ctx.store.doc);
    const name = args.name === undefined ? nextPageName(ctx.store.doc, ctx.defaultName?.("page") ?? "页面") : String(args.name).trim();
    if (!name) throw new Error("页面名不能为空");
    const width = args.width === undefined ? DEFAULT_PAGE_WIDTH : Number(args.width);
    const height = args.height === undefined ? DEFAULT_PAGE_HEIGHT : Number(args.height);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error("页面宽高必须是正数");
    }
    const page = createNode("page", {
      name,
      x: typeof args.x === "number" ? args.x : position.x,
      y: typeof args.y === "number" ? args.y : position.y,
      width,
      height,
    });
    ctx.store.apply({ type: "node.create", params: { nodes: [page], parentId: null } }, "ai:create_page");
    // 让后续不带 parentId 的操作默认落到新页（与左栏「+」一致）
    ctx.host?.activatePage?.(page.id);
    return JSON.stringify({ ok: true, pageId: page.id, name });
};
