/**
 * 命令面板的 UI 状态与最近命令（localStorage，最多 5 条）。
 */
import { reactive } from "vue";
import { isCommandId, type CommandId } from "../shared/commands";

const RECENT_KEY = "sqraft.palette.recent.v1";

function loadRecent(): CommandId[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((item): item is CommandId => isCommandId(item));
    return [...new Set(ids)].slice(0, 5);
  } catch {
    return [];
  }
}

export const paletteUi = reactive({
  open: false,
  query: "",
  /** 当前选中项在平铺结果里的下标 */
  active: 0,
  recent: loadRecent(),
});

export function togglePalette(open = !paletteUi.open): void {
  paletteUi.open = open;
  if (open) {
    paletteUi.query = "";
    paletteUi.active = 0;
  }
}

/** 只记成功派发的命令；重复项置顶。 */
export function recordCommand(id: CommandId): void {
  paletteUi.recent = [id, ...paletteUi.recent.filter((item) => item !== id)].slice(0, 5);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(paletteUi.recent));
  } catch {
    /* 隐私模式下不可写：内存里仍然生效 */
  }
}
