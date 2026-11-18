/**
 * 示例 B：卡片列表。三列自动布局、wrap；每张卡片纵向布局。
 */
import { createEmptyDoc } from "@sqraft/core";
import { frame, page, put, row, text, vertical } from "./kit";

export const CARDS_TITLE = "Card grid example";

const CARDS = [
  ["Design tokens", "Keep colors and spacing consistent across every screen."],
  ["Component library", "Reuse the same card for projects, settings and billing."],
  ["Prototype links", "Turn a static frame into a clickable flow in a minute."],
] as const;

export function buildCardGridExample() {
  const doc = createEmptyDoc();
  const root = page(doc, "Card grid", 900);

  put(
    doc,
    root,
    text("Heading", "Projects", { x: 80, y: 64, width: 420, height: 44, fontSize: 32, fontWeight: 600 }),
  );
  put(
    doc,
    root,
    text("Subheading", "Three cards, generated with auto layout.", {
      x: 80,
      y: 116,
      width: 520,
      height: 24,
      fontSize: 14,
      fill: "#6b7280",
    }),
  );

  const grid = put(
    doc,
    root,
    frame("Card grid", {
      x: 80,
      y: 170,
      width: 1280,
      height: 640,
      layout: row(24, true),
    }),
  );

  for (const [title, summary] of CARDS) {
    const card = put(
      doc,
      grid,
      frame(`Card · ${title}`, {
        x: 24,
        y: 24,
        width: 360,
        height: 220,
        fill: "#ffffff",
        radius: 16,
        layout: vertical(12, 24),
      }),
    );
    put(
      doc,
      card,
      text(`${title} title`, title, { x: 0, y: 0, width: 312, height: 28, fontSize: 18, fontWeight: 600 }),
    );
    put(
      doc,
      card,
      text(`${title} summary`, summary, {
        x: 24,
        y: 24,
        width: 312,
        height: 44,
        fontSize: 13,
        fill: "#6b7280",
      }),
    );
    const button = put(
      doc,
      card,
      frame(`${title} button`, {
        x: 24,
        y: 24,
        width: 120,
        height: 36,
        fill: "#eef2ff",
        radius: 8,
      }),
    );
    put(
      doc,
      button,
      text(`${title} button label`, "Open", {
        x: 0,
        y: 9,
        width: 120,
        height: 18,
        fontSize: 12,
        fontWeight: 600,
        fill: "#3366ff",
        align: "center",
      }),
    );
  }

  return { title: CARDS_TITLE, state: doc };
}
