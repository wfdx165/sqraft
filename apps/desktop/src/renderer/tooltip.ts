/**
 * 全局 tooltip 指令：v-tip="{ label: '矩形', shortcut: 'R' }"
 * 400ms 延迟、深色胶囊、按钮下方居中，超出视口自动翻转。
 * 单例 DOM，不进入 Vue 组件树（避免布局与 z-index 干扰）。
 */
import type { Directive } from "vue";
import { uiFontStack } from "./font-stack";

interface TipValue {
  label: string;
  shortcut?: string;
}

const DELAY = 400;
const OFFSET = 8;

let el: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;

function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement("div");
  el.className = "sqraft-tip";
  Object.assign(el.style, {
    position: "fixed",
    zIndex: "9999",
    pointerEvents: "none",
    padding: "5px 9px",
    borderRadius: "7px",
    background: "rgba(23, 23, 28, 0.92)",
    color: "#ffffff",
    font: "500 11px/1.4 sans-serif",
    letterSpacing: "0.01em",
    whiteSpace: "nowrap",
    opacity: "0",
    transform: "translate(-50%, -2px)",
    transition: "opacity 120ms ease, transform 120ms ease",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.28)",
  });
  document.body.appendChild(el);
  return el;
}

function hide() {
  window.clearTimeout(timer);
  current = null;
  if (el) {
    el.style.opacity = "0";
    el.style.transform = "translate(-50%, -2px)";
  }
}

function show(target: HTMLElement, value: TipValue) {
  const tip = ensureEl();
  // 语言可能在中途切换：每次显示时刷新字体栈，避免 tooltip 停在旧语言的 CJK 字形上
  tip.style.font = `500 11px/1.4 ${uiFontStack()}`;
  tip.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = value.label;
  tip.appendChild(label);
  if (value.shortcut) {
    const kbd = document.createElement("span");
    kbd.textContent = value.shortcut;
    Object.assign(kbd.style, {
      marginLeft: "6px",
      padding: "0 4px",
      borderRadius: "4px",
      background: "rgba(255, 255, 255, 0.14)",
      color: "rgba(255, 255, 255, 0.75)",
      font: "500 10px/1.5 'Geist Mono Variable', ui-monospace, monospace",
    });
    tip.appendChild(kbd);
  }
  // 先量尺寸再定位，避免首帧跳动
  tip.style.left = "-9999px";
  tip.style.top = "-9999px";
  tip.style.opacity = "0";
  const rect = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = rect.left + rect.width / 2;
  left = Math.min(Math.max(left, w / 2 + 6), window.innerWidth - w / 2 - 6);
  let top = rect.bottom + OFFSET;
  if (top + h > window.innerHeight - 6) top = rect.top - h - OFFSET;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.opacity = "1";
  tip.style.transform = "translate(-50%, 0)";
}

interface TipTarget extends HTMLElement {
  __tipValue?: TipValue;
  __tipCleanup?: () => void;
}

export const vTip: Directive<HTMLElement, TipValue> = {
  mounted(target, binding) {
    const t = target as TipTarget;
    t.__tipValue = binding.value;
    const onEnter = () => {
      window.clearTimeout(timer);
      current = t;
      timer = window.setTimeout(() => {
        if (current === t) show(t, t.__tipValue!);
      }, DELAY);
    };
    const onLeave = () => {
      if (current === t) hide();
    };
    t.__tipCleanup = () => {
      t.removeEventListener("mouseenter", onEnter);
      t.removeEventListener("mouseleave", onLeave);
      t.removeEventListener("pointerdown", onLeave);
      t.removeEventListener("blur", onLeave);
    };
    t.addEventListener("mouseenter", onEnter);
    t.addEventListener("mouseleave", onLeave);
    t.addEventListener("pointerdown", onLeave);
    t.addEventListener("blur", onLeave);
  },
  updated(target, binding) {
    (target as TipTarget).__tipValue = binding.value;
  },
  unmounted(target) {
    const t = target as TipTarget;
    t.__tipCleanup?.();
    if (current === t) hide();
  },
};
