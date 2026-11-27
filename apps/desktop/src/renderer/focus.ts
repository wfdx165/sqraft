/**
 * 工作台的面板开关（ADR-0041）。
 *
 * - `panelWidths`：左右栏宽度，每台机器一份，存 `localStorage`（不需要 IPC）；
 * - `panelsUi`：左右面板是否展开。窗口级、不按标签记、**不跨启动记忆**。
 *
 * 只有一个开关：收起 / 展开双侧面板。没有单侧折叠，也没有"只剩画布"的二级模式——
 * 那个姿态交给演示（演示不可编辑，是另一件事）。
 */
import { reactive } from "vue";

export type PanelSide = "left" | "right";

const STORAGE_KEY = "sqraft.panels.v1";
const LIMITS = {
  left: { min: 220, max: 480, def: 300 },
  right: { min: 200, max: 420, def: 276 },
} as const;

function clampWidth(side: PanelSide, value: unknown): number {
  const limit = LIMITS[side];
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : limit.def;
  return Math.round(Math.min(limit.max, Math.max(limit.min, numeric)));
}

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // 隐私模式下访问 localStorage 会抛
    return null;
  }
}

function loadWidths(): { left: number; right: number } {
  try {
    const raw = store()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { left?: unknown; right?: unknown }) : {};
    return { left: clampWidth("left", parsed.left), right: clampWidth("right", parsed.right) };
  } catch {
    return { left: LIMITS.left.def, right: LIMITS.right.def };
  }
}

export const panelWidths = reactive(loadWidths());

export function setPanelWidth(side: PanelSide, value: number): void {
  panelWidths[side] = clampWidth(side, value);
}

export function persistPanelWidths(): void {
  try {
    store()?.setItem(STORAGE_KEY, JSON.stringify({ left: panelWidths.left, right: panelWidths.right }));
  } catch {
    /* 写不进去不影响本次会话 */
  }
}

/** 面板是否展开：重启总是展开，所以不落盘。 */
export const panelsUi = reactive({ open: true });

/** `⌘\`、视图菜单与顶栏按钮共用的唯一开关。 */
export function togglePanels(): void {
  panelsUi.open = !panelsUi.open;
}
