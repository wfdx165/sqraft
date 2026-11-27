/**
 * 外部改动检测的纯逻辑（ADR-0041）。
 *
 * 只比较 mtime 与「用户选择忽略的那一次」：不读内容、不抢焦点。
 * 文件回到保存时的 mtime 视为"已恢复"，忽略记录一并清掉。
 */
export interface FileSnapshot {
  /** 上次保存/打开时记下的 mtime */
  mtimeMs: number;
  /** 「保留当前版本」忽略的那一次 mtime */
  ignoredMtime: number | null;
  /** 文件被删后用户选了「保留」：不再提示，直到文件重新出现 */
  ignoredMissing: boolean;
}

export interface DiskStat {
  exists: boolean;
  mtimeMs: number;
}

export interface ChangeState {
  externalChange: boolean;
  missing: boolean;
}

export function changeStateOf(file: FileSnapshot, stat: DiskStat): ChangeState {
  if (!stat.exists) {
    return { externalChange: !file.ignoredMissing, missing: true };
  }
  if (stat.mtimeMs === file.mtimeMs) return { externalChange: false, missing: false };
  if (file.ignoredMtime !== null && stat.mtimeMs === file.ignoredMtime) {
    return { externalChange: false, missing: false };
  }
  return { externalChange: true, missing: false };
}
