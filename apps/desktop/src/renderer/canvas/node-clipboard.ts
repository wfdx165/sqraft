/**
 * 节点剪贴板：`⌘C` / `⌘X` / `⌘V` 的 sqraft 载荷。
 *
 * 走系统剪贴板的平台原始类型（主进程包装成 `electron application/osclipboard;format="com.sqraft.nodes"`，
 * 见 `main/mcp/index.ts`），所以同文档、跨页、跨文档都能粘；图片以 base64 内联，
 * `assetId` 是内容哈希，粘过去能直接复用。
 *
 * 与图片/文本的优先级由调用方决定：sqraft 节点 > 图片 > 文本。
 */
import {
  newId,
  remapNode,
  topLevelIds,
  walkSubtree,
  worldRect,
  type Command,
  type DocNode,
  type NodeId,
  type TokenEntry,
} from "@sqraft/core";
import { MAX_ASSET_BYTES, allAssets, hasAsset, putAsset } from "../assets";
import { docStore, select, ui } from "../store";
import { isLocked } from "./hit";

const PAYLOAD_VERSION = 1;

export interface ClipboardPayload {
  kind: "sqraft/nodes";
  version: number;
  /** 复制时的根节点顺序 */
  rootIds: NodeId[];
  /** 扁平节点表，含整棵子树 */
  nodes: DocNode[];
  /** 被引用到的 Token 定义（不整份复制设计系统） */
  tokens: Record<string, TokenEntry>;
  /** 被引用到的图片字节，按内容哈希做键 */
  assets: Record<string, { mime: string; base64: string }>;
}

/** 可复制的选区：跳过页面与锁定子树。 */
function copyableIds(): NodeId[] {
  return ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    return !!node && node.type !== "page" && !isLocked(id);
  });
}

/** 把选区序列化进系统剪贴板；没有可复制的节点时返回 false。 */
export async function copySelectionToClipboard(): Promise<boolean> {
  const ids = topLevelIds(docStore.doc, copyableIds());
  if (ids.length === 0) return false;
  const nodes: DocNode[] = [];
  for (const id of ids) walkSubtree(docStore.doc, id, (node) => nodes.push(node));
  const payload: ClipboardPayload = {
    kind: "sqraft/nodes",
    version: PAYLOAD_VERSION,
    rootIds: ids,
    nodes,
    tokens: collectTokens(nodes),
    assets: collectAssets(nodes),
  };
  try {
    await window.sqraft.app.writeClipboardNodes(JSON.stringify(payload));
  } catch (error) {
    // 写系统剪贴板失败（权限、超大载荷）不能装作复制成功：用户下一步粘贴会没反应
    await window.sqraft.dialog.error(`复制到剪贴板失败：${String(error)}`);
    return false;
  }
  return true;
}

/** 焦点在输入框里时，⌘C / ⌘X 必须走系统原生行为，不能复制节点。 */
function editableFocus(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** ⌘C：输入框内保持原生复制，画布焦点下复制节点。 */
export async function copySelectionAction(): Promise<void> {
  if (editableFocus() || !ui.docOpen) {
    document.execCommand("copy");
    return;
  }
  await copySelectionToClipboard();
}

/** ⌘X：复制后删除，仍是一条撤销。 */
export async function cutSelectionAction(): Promise<void> {
  if (editableFocus() || !ui.docOpen) {
    document.execCommand("cut");
    return;
  }
  if (!(await copySelectionToClipboard())) return;
  const ids = topLevelIds(docStore.doc, copyableIds());
  if (ids.length === 0) return;
  docStore.apply(
    ids.map((id) => ({ type: "node.delete" as const, params: { nodeId: id } })),
    "剪切",
  );
  select([]);
}

export interface PasteDeps {
  /** 指针在画布上时的世界坐标；不在画布上返回 null */
  pointerWorld(): { x: number; y: number } | null;
  activePageId(): NodeId | null;
  pageAt(x: number, y: number): NodeId | null;
  /** 指针下最深的可接收子节点的容器 */
  containerAt(x: number, y: number): DocNode | null;
}

/**
 * 从剪贴板粘节点。剪贴板里没有 sqraft 载荷时返回 false（调用方接着试图片/文本）。
 * 落点：指针在画布上 → 粘到指针处（父级=指针下的容器）；否则原位 +10px。
 */
export async function pasteNodesFromClipboard(deps: PasteDeps): Promise<boolean> {
  const raw = await window.sqraft.app.readClipboardNodes();
  if (!raw) return false;
  let payload: ClipboardPayload;
  try {
    payload = JSON.parse(raw) as ClipboardPayload;
  } catch {
    // 类型认出来了却读不懂：说清楚，别让它悄悄退化成"粘图片/文本"再无声失败
    await window.sqraft.dialog.error("剪贴板里的图层数据无法解析，粘贴已取消。");
    return true;
  }
  if (!isNodePayload(payload)) {
    // 载荷带着我们的 MIME 却读不懂：多半来自更新版本的 Sqraft，说清楚比静默强
    await window.sqraft.dialog.error("剪贴板里的内容来自更新版本的 Sqraft，无法粘贴。");
    return true;
  }
  const safe = sanitizePayload(payload);
  if (!safe) {
    await window.sqraft.dialog.error("剪贴板里的图层数据已损坏，无法粘贴。");
    return true;
  }

  // 图片先注册：失败就留占位，不阻断整次粘贴
  for (const [id, entry] of Object.entries(safe.assets)) {
    if (hasAsset(id)) continue;
    const bytes = fromBase64(entry.base64);
    if (bytes.length === 0) continue;
    try {
      await putAsset(bytes);
    } catch {
      // 解码失败：节点保留，渲染成占位块
    }
  }

  const anchor = deps.pointerWorld();
  const pageId = (anchor ? deps.pageAt(anchor.x, anchor.y) : null) ?? deps.activePageId();
  const sourceById = new Map(safe.nodes.map((node) => [node.id, node]));
  // 复制来的主组件要落回文档根，没有页面也照样能粘
  const hasComponentRoot = safe.rootIds.some((id) => sourceById.get(id)?.type === "component");
  if (!pageId && !hasComponentRoot) return false;
  const container = anchor ? deps.containerAt(anchor.x, anchor.y) : null;
  // 锁定的容器不能接收内容：回落到页面根
  const parentId = pageId && (!container || container.id === pageId || container.locked) ? pageId : container?.id ?? null;
  const parentWorld = parentId ? (worldRect(docStore.doc, parentId) ?? { x: 0, y: 0, width: 0, height: 0 }) : { x: 0, y: 0, width: 0, height: 0 };

  const idMap: Record<NodeId, NodeId> = {};
  for (const node of safe.nodes) idMap[node.id] = newId();
  const cloneById = new Map(safe.nodes.map((node) => [idMap[node.id], remapNode(node, idMap)]));

  detachOrphans(cloneById);

  const commands: Command[] = [];
  // Token：缺的补上定义，同名不同值保留目标文档的值（不覆盖设计系统）
  for (const [path, entry] of Object.entries(safe.tokens)) {
    if (docStore.doc.tokens[path]) continue;
    commands.push({ type: "token.define", params: { path, tokenType: entry.type, value: entry.value } });
  }
  const newRoots: NodeId[] = [];
  for (const rootId of safe.rootIds) {
    const source = sourceById.get(rootId);
    const clone = cloneById.get(idMap[rootId]);
    if (!source || !clone) continue;
    // 主组件是文档根节点（ADR-0025）：粘贴出来仍然是根级母版，落不进页面/容器
    const toRoot = clone.type === "component";
    const targetParent = toRoot ? null : parentId;
    // 没有页面可落的文档：只有母版能粘到根上，其余根节点跳过（别让整次粘贴抛错）
    if (!targetParent && !toRoot) continue;
    clone.parentId = targetParent;
    if (toRoot) {
      // 根节点坐标就是世界坐标：粘在原件旁边，不跟着指针走
      clone.x = source.x + (anchor ? 20 : 10);
      clone.y = source.y + (anchor ? 20 : 10);
    } else if (anchor) {
      // 指针处：根的本地坐标 = 世界坐标 - 新父级的世界原点
      clone.x = anchor.x - parentWorld.x;
      clone.y = anchor.y - parentWorld.y;
    } else {
      clone.x = source.x + 10;
      clone.y = source.y + 10;
    }
    const subtree: DocNode[] = [];
    const visit = (id: NodeId) => {
      const node = cloneById.get(id);
      if (!node) return;
      subtree.push(node);
      for (const child of node.children) visit(child);
    };
    visit(clone.id);
    commands.push({ type: "node.create", params: { nodes: subtree, parentId: targetParent } });
    newRoots.push(clone.id);
  }
  if (commands.length === 0) return false;

  docStore.apply(commands, "粘贴");
  if (pageId) ui.expandedPageId = pageId;
  select(newRoots);
  return true;
}

/**
 * 实例的母版既不在本次载荷里、也不在目标文档里：按脱离语义降级成画板。
 * 外观（几何/样式/子节点）保留，只是不再受母版影响。
 */
function detachOrphans(cloneById: Map<NodeId, DocNode>): void {
  for (const clone of cloneById.values()) {
    if (clone.type !== "instance") continue;
    const master = clone.componentId
      ? (cloneById.get(clone.componentId) ?? docStore.doc.nodes[clone.componentId])
      : null;
    if (master) continue;
    detachSubtree(cloneById, clone.id);
  }
}

function detachSubtree(cloneById: Map<NodeId, DocNode>, id: NodeId): void {
  const node = cloneById.get(id);
  if (!node) return;
  if (node.type === "instance") {
    node.type = "frame";
    delete node.componentId;
    delete node.propValues;
    delete node.overrides;
  }
  // 插槽是实例专属结构：脱离后按普通画板处理
  if (node.type === "slot") node.type = "frame";
  delete node.mainId;
  delete node.slotFilled;
  for (const child of node.children) detachSubtree(cloneById, child);
}

const MAX_NODES = 5000;
const NODE_TYPES = new Set([
  "frame", "group", "rect", "ellipse", "line", "polygon", "star", "path", "text", "image",
  "component", "instance", "slot", "page",
]);

/**
 * 载荷来自系统剪贴板——任何程序都能往里写。这里做结构校验：
 * 丢掉畸形节点、剪断指向缺失节点的引用，超过节点上限直接拒绝。
 */
function sanitizePayload(payload: ClipboardPayload): ClipboardPayload | null {
  if (payload.nodes.length > MAX_NODES) return null;
  const nodes: DocNode[] = [];
  const seen = new Set<NodeId>();
  for (const raw of payload.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Partial<DocNode>;
    if (typeof node.id !== "string" || seen.has(node.id)) continue;
    if (typeof node.type !== "string" || !NODE_TYPES.has(node.type)) continue;
    const numbers = [node.x, node.y, node.width, node.height];
    if (numbers.some((value) => typeof value !== "number" || !Number.isFinite(value))) continue;
    seen.add(node.id);
    nodes.push({
      ...(raw as DocNode),
      style: (node.style && typeof node.style === "object" ? node.style : {}) as DocNode["style"],
      children: Array.isArray(node.children) ? node.children.filter((id) => typeof id === "string") : [],
    });
  }
  if (nodes.length === 0) return null;
  // 剪断指向被丢弃节点的引用
  for (const node of nodes) node.children = node.children.filter((id) => seen.has(id));
  const rootIds = payload.rootIds.filter((id) => seen.has(id));
  if (rootIds.length === 0) return null;
  return {
    kind: "sqraft/nodes",
    version: payload.version,
    rootIds,
    nodes,
    tokens: payload.tokens && typeof payload.tokens === "object" ? payload.tokens : {},
    assets: payload.assets && typeof payload.assets === "object" ? payload.assets : {},
  };
}

function isNodePayload(value: unknown): value is ClipboardPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ClipboardPayload>;
  return (
    payload.kind === "sqraft/nodes" &&
    payload.version === PAYLOAD_VERSION &&
    Array.isArray(payload.rootIds) &&
    Array.isArray(payload.nodes)
  );
}

function collectTokens(nodes: readonly DocNode[]): Record<string, TokenEntry> {
  const out: Record<string, TokenEntry> = {};
  const add = (token?: string) => {
    if (token && docStore.doc.tokens[token]) out[token] = docStore.doc.tokens[token];
  };
  for (const node of nodes) {
    add(node.style.fill?.token);
    add(node.style.stroke?.token);
    for (const effect of node.style.effects ?? []) {
      if (effect.type === "drop-shadow" || effect.type === "inner-shadow") add(effect.color?.token);
    }
  }
  return out;
}

function collectAssets(nodes: readonly DocNode[]): Record<string, { mime: string; base64: string }> {
  const out: Record<string, { mime: string; base64: string }> = {};
  const records = new Map(allAssets().map((record) => [record.id, record]));
  for (const node of nodes) {
    const assetId = node.image?.assetId;
    if (!assetId || out[assetId]) continue;
    const record = records.get(assetId);
    // 超限的图片不内联：节点照常粘过去，图降级成占位
    if (!record || record.bytes.length > MAX_ASSET_BYTES) continue;
    out[assetId] = { mime: record.mime, base64: toBase64(record.bytes) };
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}
