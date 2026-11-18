/**
 * 示例 A：登录页。卡片居中，纵向自动布局；纯图形与文本，无图片、无 Token。
 */
import { createEmptyDoc } from "@sqraft/core";
import { frame, page, put, text, vertical } from "./kit";

export const LOGIN_TITLE = "Login example";

export function buildLoginExample() {
  const doc = createEmptyDoc();
  const root = page(doc, "Login", 900);

  const card = put(
    doc,
    root,
    frame("Sign-in card", {
      x: 520,
      y: 180,
      width: 400,
      height: 520,
      fill: "#ffffff",
      radius: 24,
      layout: vertical(16, 40),
    }),
  );

  put(doc, card, frame("Logo", { x: 40, y: 40, width: 48, height: 48, fill: "#3366ff", radius: 12 }));
  put(
    doc,
    card,
    text("Title", "Sign in", { x: 40, y: 40, width: 320, height: 40, fontSize: 28, fontWeight: 600 }),
  );
  put(
    doc,
    card,
    text("Subtitle", "Welcome back. Use your work email to continue.", {
      x: 40,
      y: 40,
      width: 320,
      height: 40,
      fontSize: 13,
      fill: "#6b7280",
    }),
  );

  for (const [name, placeholder] of [
    ["Email field", "Email"],
    ["Password field", "Password"],
  ] as const) {
    const field = put(
      doc,
      card,
      frame(name, {
        x: 40,
        y: 40,
        width: 320,
        height: 44,
        fill: "#ffffff",
        stroke: "#d1d5db",
        radius: 8,
      }),
    );
    put(
      doc,
      field,
      text(`${name} placeholder`, placeholder, {
        x: 14,
        y: 13,
        width: 200,
        height: 18,
        fontSize: 13,
        fill: "#9ca3af",
      }),
    );
  }

  const button = put(
    doc,
    card,
    frame("Continue button", {
      x: 40,
      y: 40,
      width: 320,
      height: 44,
      fill: "#3366ff",
      radius: 8,
    }),
  );
  put(
    doc,
    button,
    text("Continue label", "Continue", {
      x: 0,
      y: 12,
      width: 320,
      height: 20,
      fontSize: 14,
      fontWeight: 600,
      fill: "#ffffff",
      align: "center",
    }),
  );

  put(
    doc,
    card,
    text("Forgot password", "Forgot password?", {
      x: 40,
      y: 40,
      width: 320,
      height: 18,
      fontSize: 12,
      fill: "#3366ff",
    }),
  );
  put(
    doc,
    card,
    text("Terms", "By continuing you agree to the Terms of Service.", {
      x: 40,
      y: 40,
      width: 320,
      height: 32,
      fontSize: 11,
      fill: "#9ca3af",
    }),
  );

  return { title: LOGIN_TITLE, state: doc };
}
