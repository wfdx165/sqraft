/**
 * 多标签会话模型（ADR-0041）。
 *
 * 每个文档标签持有一套真实 `DocStore`（文档 + 撤销/重做 + 落盘修订号）、
 * 文件状态与视图状态；Home 是常驻、不可关的第 1 个标签。
 *
 * 这里只放**数据与纯操作**：不碰 `ui`、不碰画布、不广播。切标签的编排在
 * `store.ts` 的 `activateTab()`，因为那一步要搬 `ui` 字段并重绘画布。
 */
import { markRaw, reactive, shallowReactive } from "vue";
import { DocStore, createEmptyDoc, firstPageId, type DocState, type NodeId } from "@sqraft/core";

export type ToolKind = "select" | "frame" | "rect" | "ellipse" | "triangle" | "line" | "path" | "text";
export type PanelTab = "pages" | "tokens" | "components";
/** 画布模式：pan = 浏览/平移，edit = 编辑活动页 */
export type EditorMode = "pan" | "edit";
export type InspectorTab = "design" | "prototype";

/** 文档标签的上限（Home 不计）。超出只提示，不自动关。 */
export const MAX_DOC_TABS = 10;
export const HOME_TAB_ID = "home";

/** 每标签的文件状态；`dirty` 由保存点与文档修订号推出（`syncTitle` 写入）。 */
export interface TabFileState {
  path: string | null;
  name: string;
  /** 未命名文档的序号（创建时分配、单调递增、重启归零）；有名字的标签为 null */
  untitledIndex: number | null;
  mtimeMs: number;
  dirty: boolean;
  /** 磁盘上的文件在别的程序里被改过（只标记，不抢焦点） */
  externalChange: boolean;
  /** 磁盘上的文件已经不存在（删除后仍可保留内存里的版本，保存会重建） */
  missing: boolean;
  /** 「保留当前版本」忽略的那次 mtime：同一次改动不再反复提示 */
  ignoredMtime: number | null;
  /** 文件被删后用户选了「保留」：不再提示，直到文件重新出现 */
  ignoredMissing: boolean;
}

/** 每标签的视图状态：切回来像没离开过。 */
export interface TabViewState {
  activePageId: NodeId | null;
  expandedPageId: NodeId | null;
  expandedLayers: Record<NodeId, boolean>;
  selection: NodeId[];
  instanceContext: NodeId[];
  mode: EditorMode;
  tool: ToolKind;
  cropNodeId: NodeId | null;
  panelTab: PanelTab;
  inspectorTab: InspectorTab;
  /** 首次激活前为 null：那时走「切页即适配」 */
  viewport: { x: number; y: number; zoom: number } | null;
  /** agent 变更清单的内存快照；切回来时恢复 */
  agentReport: {
    changes: unknown[];
    diagnostics: unknown[];
    total: number;
  };
}

export interface TabSession {
  id: string;
  kind: "home" | "doc";
  /** Home 也有一份空 store：门面的写操作在 Home 上直接抛错，类型上不需要到处判空 */
  store: DocStore;
  file: TabFileState;
  view: TabViewState;
}

function emptyView(state: DocState | null): TabViewState {
  const pageId = state ? firstPageId(state) : null;
  return {
    activePageId: pageId,
    expandedPageId: pageId,
    expandedLayers: {},
    selection: [],
    instanceContext: [],
    mode: "edit",
    tool: "select",
    cropNodeId: null,
    panelTab: "pages",
    inspectorTab: "design",
    viewport: null,
    agentReport: { changes: [], diagnostics: [], total: 0 },
  };
}

function makeTab(kind: TabSession["kind"], id: string, store: DocStore, file: Partial<TabFileState>, state: DocState | null): TabSession {
  return {
    id,
    kind,
    store: markRaw(store),
    file: reactive({
      path: null,
      name: "",
      untitledIndex: null,
      mtimeMs: 0,
      dirty: false,
      externalChange: false,
      missing: false,
      ignoredMtime: null,
      ignoredMissing: false,
      ...file,
    }),
    view: reactive(emptyView(state)),
  };
}

const home = makeTab("home", HOME_TAB_ID, new DocStore(createEmptyDoc()), { name: "Home" }, null);

/** 标签列表与活动标签：UI（TopBar / 状态点）直接读这份响应式状态。
 * 用 shallowReactive：深层代理会把 `DocStore` 类的私有字段抹成结构类型，
 * 而每个标签的 `file` / `view` 本身已经是 reactive。 */
export const sessionState = shallowReactive({
  activeId: HOME_TAB_ID,
  /**
   * 结构版本：`shallowReactive` 只让顶层属性响应式，`tabs` 本身是普通数组，
   * 就地 `push` / `splice` 不会触发依赖。所以增删与排序都要 bump 它，
   * 而 `docTabs()` 会读一次——凡是读标签列表的 computed 都靠这条线刷新。
   */
  rev: 0,
  tabs: [home] as TabSession[],
});

let seq = 0;
/** 未命名文档的编号：创建时分配、不复用，只在 `resetSessions()` 归零（应用重启即新进程）。 */
let untitledSeq = 0;

export function activeSession(): TabSession {
  return sessionState.tabs.find((tab) => tab.id === sessionState.activeId) ?? home;
}

export function findTab(id: string): TabSession | undefined {
  return sessionState.tabs.find((tab) => tab.id === id);
}

export function findDocTabByPath(path: string): TabSession | undefined {
  return sessionState.tabs.find((tab) => tab.kind === "doc" && tab.file.path === path);
}

export function isDocActive(): boolean {
  return activeSession().kind === "doc";
}

/** 门面转发用的真实例：Home 也返回一个（写操作由门面拦截）。 */
export function activeStore(): DocStore {
  return activeSession().store;
}

export function docTabs(): TabSession[] {
  void sessionState.rev;
  return sessionState.tabs.filter((tab) => tab.kind === "doc");
}

/** 新建一个文档标签并放到末尾；调用方负责激活它。 */
export function createDocTab(state: DocState, file: Partial<TabFileState> = {}): TabSession {
  seq += 1;
  // 有名字的（示例稿、从磁盘打开）不占编号；未命名的按创建顺序编号，关掉不回收
  const untitledIndex = file.name ? null : ++untitledSeq;
  const tab = makeTab("doc", `t${seq}`, new DocStore(state), { untitledIndex, ...file }, state);
  sessionState.tabs.push(tab);
  sessionState.rev += 1;
  return tab;
}

/** 关闭标签，返回下一个应当激活的标签 id；Home 不可关。 */
export function closeTab(id: string): string | null {
  if (id === HOME_TAB_ID) return null;
  const index = sessionState.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return null;
  sessionState.tabs.splice(index, 1);
  sessionState.rev += 1;
  if (sessionState.activeId !== id) return null;
  // 活动指针先留在被关掉的 id 上：调用方随后 activateTab(next)，
  // 由它负责重挂门面（就算 next 是 Home 也不能提前改成 home，否则会被当成"没变化"）
  return (sessionState.tabs[Math.min(index, sessionState.tabs.length - 1)] ?? home).id;
}

/** 拖拽排序：把 from 移到 to 的位置。Home 固定在第 1 位。 */
export function moveTab(fromId: string, toId: string): void {
  const from = sessionState.tabs.findIndex((tab) => tab.id === fromId);
  const to = sessionState.tabs.findIndex((tab) => tab.id === toId);
  if (from < 0 || to < 0 || fromId === HOME_TAB_ID) return;
  const target = Math.max(1, to);
  const [tab] = sessionState.tabs.splice(from, 1);
  sessionState.tabs.splice(target, 0, tab!);
  sessionState.rev += 1;
}

/** 测试与「关闭全部」用：回到只有 Home 的状态；未命名编号一并归零。 */
export function resetSessions(): void {
  sessionState.tabs.splice(1);
  sessionState.rev += 1;
  sessionState.activeId = HOME_TAB_ID;
  untitledSeq = 0;
  closedPaths.length = 0;
}

/* ---------- ⇧⌘T：最近关闭的标签 ---------- */
/** 只记路径：未命名/未保存的新文件不恢复（用户已经在关闭时确认过丢弃）。 */
const closedPaths: string[] = [];
export const CLOSED_TAB_LIMIT = 10;

export function rememberClosedPath(path: string | null): void {
  if (!path) return;
  closedPaths.push(path);
  if (closedPaths.length > CLOSED_TAB_LIMIT) closedPaths.shift();
}

export function takeClosedPath(): string | null {
  return closedPaths.pop() ?? null;
}

export function closedPathCount(): number {
  return closedPaths.length;
}
