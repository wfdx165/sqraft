/**
 * 方向键微移：1px，`⇧` 10px。
 *
 * 连按合并成一条撤销：第一次按下开一个事务，300ms 内没有新的按键就提交。
 * 与裁切拖拽同一套做法（一次连续手势 = 一条撤销记录）。
 */
import type { Command } from "@sqraft/core";
import { docStore, ui } from "../store";
import { isLocked } from "./hit";

const IDLE_MS = 150;

let commit: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 可微移的节点：跳过页面、锁定子树与自动布局子项（位置由布局决定）。 */
function movableIds(): string[] {
  return ui.selection.filter((id) => {
    const node = docStore.doc.nodes[id];
    if (!node || node.type === "page" || isLocked(id)) return false;
    const parent = node.parentId ? docStore.doc.nodes[node.parentId] : null;
    return !(parent?.layout && !node.layoutAbsolute);
  });
}

function openSession(): void {
  if (commit) return;
  void docStore.transact(
    "微移",
    () =>
      new Promise<void>((resolve) => {
        commit = resolve;
      }),
  );
}

/** 立刻结束微移会话：下一个命令不该被并进"微移"这条撤销。 */
export function flushNudge(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  commit?.();
  commit = null;
}

export function nudgeSelection(dx: number, dy: number): void {
  const ids = movableIds();
  if (ids.length === 0) return;

  openSession();
  const commands: Command[] = ids.map((id) => {
    const node = docStore.doc.nodes[id];
    return {
      type: "node.update",
      params: { nodeId: id, patch: { x: node.x + dx, y: node.y + dy } },
    };
  });
  docStore.apply(commands, "微移");

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    commit?.();
    commit = null;
    timer = null;
  }, IDLE_MS);
}
