/**
 * 命令面板的纯搜索：可用性、打分、排序。组件只负责渲染与键盘。
 */
import {
  COMMANDS,
  COMMAND_GROUP_ORDER,
  type AppCommand,
  type CommandId,
} from "../shared/commands";

export interface PaletteContext {
  docOpen: boolean;
  selection: boolean;
  presenter: boolean;
}

export function isAvailable(command: AppCommand, ctx: PaletteContext): boolean {
  if (ctx.presenter) return false;
  if (command.id === "palette.open") return false;
  if (command.requires === "doc" && !ctx.docOpen) return false;
  if (command.requires === "selection" && !ctx.selection) return false;
  return true;
}

/** 全等 1000 > 前缀 800 > 子串 600 > 子序列 400；分数只用于排序。 */
export function scoreLabel(query: string, label: string): number {
  const q = query.trim().toLowerCase();
  const text = label.toLowerCase();
  if (!q) return 0;
  if (text === q) return 1000;
  const prefix = text.indexOf(q);
  if (prefix === 0) return 800;
  if (prefix > 0) return 600 - prefix * 5;

  let at = 0;
  let gaps = 0;
  for (const char of q) {
    const found = text.indexOf(char, at);
    if (found < 0) return 0;
    gaps += found - at;
    at = found + 1;
  }
  return 400 - gaps * 10;
}

interface Scored {
  command: AppCommand;
  score: number;
}

const INDEX_OF = new Map<CommandId, number>(COMMANDS.map((command, index) => [command.id, index]));

function compare(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  const group = COMMAND_GROUP_ORDER.indexOf(a.command.group) - COMMAND_GROUP_ORDER.indexOf(b.command.group);
  if (group !== 0) return group;
  const registry = (INDEX_OF.get(a.command.id) ?? 0) - (INDEX_OF.get(b.command.id) ?? 0);
  if (registry !== 0) return registry;
  return a.command.labelKey.localeCompare(b.command.labelKey);
}

export interface SearchResult {
  /** 空查询时的最近命令（≤5） */
  recent: AppCommand[];
  /** 查询结果；空查询时是其余命令 */
  commands: AppCommand[];
}

/**
 * `available` 由调用方提供：组件还要叠加"执行器是否已登记"。
 * `labelOf` 把命令映射成当前语言的展示文案——必须按译名搜索，
 * 否则 zh/ja/ko 下拿 `labelKey`（ASCII 键）打分，中文查询会被全部滤掉。
 * `limit` 只截断 commands，不影响 recent。
 */
export function searchCommands(
  query: string,
  recentIds: readonly CommandId[],
  available: (command: AppCommand) => boolean,
  labelOf: (command: AppCommand) => string,
  limit = 50,
): SearchResult {
  const q = query.trim();
  const pool = COMMANDS.filter(available);

  if (!q) {
    const recent = recentIds
      .map((id) => pool.find((command) => command.id === id))
      .filter((command): command is AppCommand => Boolean(command))
      .slice(0, 5);
    const rest = pool
      .filter((command) => !recent.some((item) => item.id === command.id))
      .sort(
        (a, b) =>
          COMMAND_GROUP_ORDER.indexOf(a.group) - COMMAND_GROUP_ORDER.indexOf(b.group) ||
          (INDEX_OF.get(a.id) ?? 0) - (INDEX_OF.get(b.id) ?? 0),
      );
    return { recent, commands: rest };
  }

  const scored: Scored[] = [];
  for (const command of pool) {
    const score = scoreLabel(q, labelOf(command));
    if (score > 0) scored.push({ command, score });
  }
  scored.sort(compare);
  return { recent: [], commands: scored.slice(0, limit).map((item) => item.command) };
}
