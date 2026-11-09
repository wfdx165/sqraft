/**
 * 关闭/退出守卫：渲染层持有文档，主进程不知道有没有未保存改动，
 * 因此脏状态由渲染层上报，关闭流程由主进程拦下并"问渲染层"。
 *
 * 状态机单独抽成 `CloseGuard`（不碰 Electron），因为它是唯一防丢稿的机制：
 * `allow` 必须随窗口重建而复位，否则上一轮关窗会永久关掉守卫（关窗 → 从 Dock 重开 → 再关就不问了）。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { CHANNELS, type CloseRequest } from "../shared/ipc";

export interface CloseGuardHost {
  hasWindow(): boolean;
  /** 把"要不要保存"甩给渲染层 */
  requestClose(request: CloseRequest): void;
  closeWindow(): void;
  quitApp(): void;
}

export class CloseGuard {
  private dirty = false;
  /** 本次关闭/退出已经放行：close 事件不再拦，避免"确认后又被问一次" */
  private allow = false;
  /** 这次询问是不是退出（渲染层据此决定关窗还是退进程） */
  private quitRequested = false;
  /** 一个关闭请求还在等渲染层答复，重复触发不重复发 */
  private pending = false;

  constructor(private readonly host: CloseGuardHost) {}

  /** 新窗口挂载时调用：清掉上一轮关窗留下的许可与挂起状态 */
  attach(): void {
    this.allow = false;
    this.pending = false;
    this.quitRequested = false;
    this.dirty = false;
  }

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** 窗口 close 事件：返回 true 表示拦下，交给渲染层决定保存/丢弃/取消。 */
  blockClose(): boolean {
    if (this.allow) return false;
    this.ask();
    return true;
  }

  /** app before-quit：返回 true 表示 preventDefault。 */
  blockQuit(): boolean {
    this.quitRequested = true;
    if (this.allow) return false;
    // 没有未保存改动时不必打扰用户，直接放行（窗口 close 也随之放行）
    if (!this.dirty) {
      this.allow = true;
      return false;
    }
    if (!this.host.hasWindow()) return false;
    this.ask();
    return true;
  }

  /** 用户已经决定（保存或不保存）：放行这次关闭。 */
  finishClose(quit: boolean): void {
    this.allow = true;
    this.pending = false;
    if (quit) this.host.quitApp();
    else this.host.closeWindow();
  }

  /** 用户在"保存 / 不保存 / 取消"里选了取消：解除挂起，但守卫继续有效。 */
  cancelClose(): void {
    this.pending = false;
    this.quitRequested = false;
  }

  private ask(): void {
    if (this.pending) return;
    this.pending = true;
    this.host.requestClose({ quit: this.quitRequested });
  }
}

let window: BrowserWindow | null = null;

const guard = new CloseGuard({
  hasWindow: () => Boolean(window && !window.isDestroyed()),
  requestClose: (request) => window?.webContents.send(CHANNELS.appRequestClose, request),
  closeWindow: () => window?.close(),
  quitApp: () => app.quit(),
});

function applyTitle(name: string): void {
  if (!window || window.isDestroyed()) return;
  window.setTitle(name ? `${name}${guard.isDirty ? " •" : ""} — Sqraft` : "Sqraft");
}

/** 绑定窗口的关闭拦截；调用前 close 事件不会真正关闭窗口。 */
export function attachCloseGuard(win: BrowserWindow): void {
  window = win;
  guard.attach();
  win.on("close", (event) => {
    if (guard.blockClose()) event.preventDefault();
  });
  win.on("closed", () => {
    window = null;
  });
}

export function registerCloseChannels(): void {
  ipcMain.on(CHANNELS.appSetDirty, (_event, payload: { dirty: boolean; name: string }) => {
    guard.setDirty(payload.dirty);
    applyTitle(payload.name);
  });

  ipcMain.on(CHANNELS.appFinishClose, (_event, payload: { quit: boolean }) => {
    guard.finishClose(payload.quit);
  });

  ipcMain.on(CHANNELS.appCancelClose, () => {
    guard.cancelClose();
  });

  app.on("before-quit", (event) => {
    if (guard.blockQuit()) event.preventDefault();
  });
}
