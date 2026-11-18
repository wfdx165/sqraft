/**
 * 「跳到 Token」的落点：面板把路径写进来，设计系统面板负责切分组、滚动与高亮。
 */
import { reactive } from "vue";

export const tokenFocus = reactive({
  path: null as string | null,
  /** 每次请求自增，面板 watch 它（同一个 Token 连点两次也要有反馈） */
  rev: 0,
});

export function focusToken(path: string): void {
  tokenFocus.path = path;
  tokenFocus.rev += 1;
}
