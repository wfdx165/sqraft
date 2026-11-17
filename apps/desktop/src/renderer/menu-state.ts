/**
 * 渲染层 UI 状态 → 主进程菜单状态。
 *
 * 单独放一个模块是为了能被单测覆盖：`App.vue` 不参与 `tsc`，
 * 直接把 `ui.presenter`（对象或 null）设为 `presenting` 时，
 * 主进程会因类型校验丢弃整份状态，菜单就会一直停在"没有文档"。
 */
import type { MenuState } from "../shared/ipc";
import type { PresenterState } from "./store";

/** `presenting` 必须是布尔：null（没在演示）= false，对象（在演示）= true。 */
export function menuStateOf(docOpen: boolean, presenter: PresenterState | null): MenuState {
  return { docOpen: docOpen === true, presenting: presenter !== null };
}
