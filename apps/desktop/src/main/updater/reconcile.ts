/**
 * 启动时的状态恢复（纯函数，不碰 Electron / 文件系统）。
 *
 * 为什么单独抽出来：安装失败后如果只弹个窗、不清理"已就绪"，
 * 下一次启动会把磁盘上那个坏包重新接管回来，用户点一次就再装一次。
 * 判定顺序是这里唯一的契约，测试锁死它。
 */
import type { UpdateState } from "../../shared/ipc";
import type { UpdatePreferences } from "../preferences";
import { compareVersions } from "./protocol";
import type { MessageKey, MessageParams } from "../../shared/i18n";

export interface LocalizedText {
  key: MessageKey;
  params?: MessageParams;
}

export interface ReconcileInput {
  currentVersion: string;
  prefs: UpdatePreferences;
  /** 上次安装失败回执里的版本（`updates/install-failed.json` 的内容） */
  failedVersion: string | null;
  /** `updates/update.zip` 是否存在 */
  zipPresent: boolean;
  now: number;
}

export interface ReconcileResult {
  state: UpdateState;
  /** 要写回的偏好（字段为 undefined = 删除） */
  patch: Partial<UpdatePreferences>;
  removeZip: boolean;
  /** 删除失败回执文件 */
  clearFailure: boolean;
  /** 需要展示的错误文案（未翻译）；正常为 null */
  message: LocalizedText | null;
  /** 非空时弹一次"已回滚"提示（未翻译） */
  prompt: LocalizedText | null;
}

function idle(currentVersion: string): UpdateState {
  return {
    phase: "idle",
    currentVersion,
    latestVersion: null,
    notes: null,
    publishedAt: null,
    progress: 0,
    message: null,
    readyAt: null,
    supported: true,
  };
}

/** 清掉 ready 相关的三个字段（失败回滚、版本已落后、包丢了都用它）。 */
const CLEAR_READY: Partial<UpdatePreferences> = {
  readyVersion: undefined,
  readySince: undefined,
  remindedVersion: undefined,
};

export function reconcileOnStart(input: ReconcileInput): ReconcileResult {
  const { currentVersion, prefs, failedVersion, zipPresent } = input;

  // 1. 上次装坏了：先于"接管已下载包"处理，否则坏包会被重新认领
  if (failedVersion) {
    return {
      state: {
        ...idle(currentVersion),
        phase: "error",
        message: null,
      },
      patch: { ...CLEAR_READY, failedVersion },
      removeZip: true,
      clearFailure: true,
      message: { key: "update.rollback", params: { failed: failedVersion, current: currentVersion } },
      prompt: { key: "update.rollbackPrompt", params: { failed: failedVersion } },
    };
  }

  const ready = prefs.readyVersion;
  // 2. 下载的版本不高于当前版本：说明已经装上（或用户换了包），清掉残留
  if (ready && compareVersions(ready, currentVersion) <= 0) {
    return {
      state: idle(currentVersion),
      patch: { ...CLEAR_READY },
      removeZip: true,
      clearFailure: false,
      message: null,
      prompt: null,
    };
  }

  // 3. 偏好说"已就绪"但包没了（被清理/保存失败）：不要假装还能装
  if (ready && !zipPresent) {
    return {
      state: idle(currentVersion),
      patch: { ...CLEAR_READY },
      removeZip: false,
      clearFailure: false,
      message: null,
      prompt: null,
    };
  }

  // 4. 正常接管已下载包
  if (ready) {
    const readyAt = prefs.readySince ?? input.now;
    return {
      state: {
        ...idle(currentVersion),
        phase: "ready",
        latestVersion: ready,
        progress: 1,
        readyAt,
      },
      patch: prefs.readySince ? {} : { readySince: readyAt },
      removeZip: false,
      clearFailure: false,
      message: null,
      prompt: null,
    };
  }

  return {
    state: idle(currentVersion),
    patch: {},
    removeZip: false,
    clearFailure: false,
    message: null,
    prompt: null,
  };
}
