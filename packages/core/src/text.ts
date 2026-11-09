/**
 * 文本行盒算法：测量、换行、列表缩进、段落间距、截断。
 * 纯函数，字体宽度由调用方注入（web 用 Canvas，测试用桩）。
 * 渲染与测量共用同一份结果，保证「提交后不跳动」。
 */

import {
  TEXT_LINE_HEIGHT,
  type DocNode,
  type ListType,
  type NodeStyle,
  type TextAutoResize,
  type TextCase,
} from "./model";

export const DEFAULT_TEXT_FONT_SIZE = 20;
export const DEFAULT_TEXT_FONT_FAMILY =
  "'Geist Variable', 'PingFang SC', 'Hiragino Sans', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic', sans-serif";

export type MeasureText = (text: string, font: string) => number;

export function fontSizeOf(style: NodeStyle | undefined): number {
  return style?.fontSize ?? DEFAULT_TEXT_FONT_SIZE;
}

export function fontFamilyOf(style: NodeStyle | undefined): string {
  return style?.fontFamily ?? DEFAULT_TEXT_FONT_FAMILY;
}

export function fontWeightOf(style: NodeStyle | undefined): number {
  return style?.fontWeight ?? 400;
}

/** Canvas / CSS 共用的 font 简写。 */
export function fontString(style: NodeStyle | undefined): string {
  const italic = style?.fontStyle === "italic" ? "italic " : "";
  return `${italic}${fontWeightOf(style)} ${fontSizeOf(style)}px ${fontFamilyOf(style)}`;
}

/** 行高（px）：auto 用固定倍数，percent 以字号为基准。 */
export function lineHeightPx(style: NodeStyle | undefined): number {
  const size = fontSizeOf(style);
  const unit = style?.lineHeightUnit ?? "auto";
  if (unit === "auto" || style?.lineHeight === undefined) return size * TEXT_LINE_HEIGHT;
  return unit === "percent" ? (size * style.lineHeight) / 100 : style.lineHeight;
}

/** 字距（px）：percent 以字号为基准。 */
export function letterSpacingPx(style: NodeStyle | undefined): number {
  if (!style?.letterSpacing) return 0;
  const size = fontSizeOf(style);
  return (style.letterSpacingUnit ?? "px") === "percent" ? (size * style.letterSpacing) / 100 : style.letterSpacing;
}

/** 大小写转换（只影响绘制与测量，不改文档文本）。 */
export function applyTextCase(text: string, textCase: TextCase | undefined): string {
  if (!textCase || textCase === "none") return text;
  if (textCase === "upper") return text.toUpperCase();
  if (textCase === "lower") return text.toLowerCase();
  return text.replace(/(^|[\s\-_/])(\p{L})/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

export function textAutoResizeOf(node: Pick<DocNode, "textAutoResize">): TextAutoResize {
  return node.textAutoResize ?? "auto-width";
}

export interface TextLine {
  text: string;
  /** 不含缩进与列表标记的行宽 */
  width: number;
  /** 该行左侧缩进（列表标记占位） */
  indent: number;
  /** 列表标记（不含缩进）；普通行缺省 */
  marker?: string;
  /** 段落序号：用于判断段末行（justify 不对末行拉伸） */
  paragraph: number;
}

export interface TextLayoutResult {
  lines: TextLine[];
  lineHeight: number;
  /** 内容自然宽度（最长行 + 缩进） */
  width: number;
  /** 内容自然高度（含段落间距） */
  height: number;
  /** 实际参与绘制的行（fixed + truncate 时可能被裁掉） */
  truncated: boolean;
}

export interface TextLayoutOptions {
  measure: MeasureText;
  /** 换行宽度（内容区宽度）；缺省表示不自动换行 */
  maxWidth?: number;
  /** fixed 高度下的可用高度；配合 truncate 使用 */
  maxHeight?: number;
  truncate?: boolean;
  /** 列表类型（节点级） */
  listType?: ListType;
}

function measureLine(text: string, font: string, spacing: number, measure: MeasureText): number {
  if (!text) return 0;
  const base = measure(text, font);
  return base + spacing * Math.max(0, [...text].length - 1);
}

function chars(text: string): string[] {
  return [...text];
}

/** 行首禁止出现的字符（收尾标点与右括号）：日文/中文共用的轻量禁则。 */
const NO_LINE_START = new Set([
  ..."、。，．！？：；）］｝」』】〉》〕｣!?,.:;)]}",
]);

/** 行尾禁止出现的字符（开括号）：避免「（」落在行尾。 */
const NO_LINE_END = new Set([..."（［｛「『【〈《〔｢([{"]);

/**
 * 轻量禁则：把行尾会违规的字符挪到下一行，或把下一行行首的收尾标点带回来。
 * 只剩一个字时宁可让这一行溢出 1 个字宽，也不把标点甩到行首（与 Figma 的处理一致）。
 */
function applyKinsoku(line: string, next: string): { head: string; tail: string } {
  const head = [...line];
  const tail = [...next];
  while (head.length > 0) {
    const last = head[head.length - 1];
    const first = tail[0];
    const badStart = first !== undefined && NO_LINE_START.has(first);
    const badEnd = last !== undefined && NO_LINE_END.has(last);
    if (!badStart && !badEnd) break;
    if (head.length === 1) return { head: head.join("") + tail.join(""), tail: "" };
    tail.unshift(head.pop()!);
  }
  return { head: head.join(""), tail: tail.join("") };
}

/** 按可用宽度逐字贪心换行：优先在空格处断行，超长单词强制断开。 */
function wrapParagraph(text: string, font: string, spacing: number, maxWidth: number, measure: MeasureText): string[] {
  if (maxWidth <= 0) return [text];
  const all = chars(text);
  if (all.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  let lastSpace = -1;
  for (const ch of all) {
    const next = line + ch;
    if (line && measureLine(next, font, spacing, measure) > maxWidth) {
      // 拉丁单词尽量在空格处断开；CJK / 超长单词按字符断开
      if (ch !== " " && lastSpace > 0) {
        const head = line.slice(0, lastSpace);
        const tail = line.slice(lastSpace + 1) + ch;
        const split = head ? applyKinsoku(head, tail) : { head, tail };
        lines.push(split.head);
        line = split.tail;
      } else if (ch === " ") {
        lines.push(line);
        line = "";
      } else {
        const split = applyKinsoku(line, ch);
        lines.push(split.head);
        line = split.tail;
      }
      lastSpace = line.lastIndexOf(" ");
      continue;
    }
    line = next;
    if (ch === " ") lastSpace = line.length - 1;
  }
  lines.push(line);
  return lines;
}

/** 截断一行：保留能放下省略号的最长前缀。 */
function ellipsize(text: string, font: string, spacing: number, maxWidth: number, measure: MeasureText): string {
  const ellipsis = "…";
  const all = chars(text);
  while (all.length > 0 && measureLine(all.join("") + ellipsis, font, spacing, measure) > maxWidth) {
    all.pop();
  }
  return all.join("").trimEnd() + ellipsis;
}

/**
 * 计算文本行盒。
 * - 不做自动换行时：每个 \n 是一段，段内一行。
 * - 有 maxWidth 时按宽度换行（列表缩进计入）。
 */
export function layoutText(text: string, style: NodeStyle, options: TextLayoutOptions): TextLayoutResult {
  const font = fontString(style);
  const size = fontSizeOf(style);
  const spacing = letterSpacingPx(style);
  const lineHeight = lineHeightPx(style);
  const paragraphSpacing = style.paragraphSpacing ?? 0;
  const listType = options.listType ?? "none";
  const markerGap = size * 0.5;
  const indent = markerGap + size * 0.7;

  const paragraphs = applyTextCase(text ?? "", style.textCase).split("\n");
  const lines: TextLine[] = [];
  paragraphs.forEach((paragraph, pIndex) => {
    const numbered = listType === "numbered";
    const bulleted = listType === "bulleted";
    const marker = bulleted ? "•" : numbered ? `${pIndex + 1}.` : undefined;
    const markerWidth = marker ? measureLine(marker, font, spacing, options.measure) : 0;
    const left = marker ? indent + Math.max(0, size - markerWidth) : 0;
    const available = options.maxWidth === undefined ? Number.POSITIVE_INFINITY : Math.max(1, options.maxWidth - left);
    const wrapped =
      options.maxWidth === undefined ? [paragraph] : wrapParagraph(paragraph, font, spacing, available, options.measure);
    if (wrapped.length === 0) wrapped.push("");
    wrapped.forEach((lineText, lineIndex) => {
      lines.push({
        text: lineText,
        width: measureLine(lineText, font, spacing, options.measure),
        indent: left,
        marker: lineIndex === 0 ? marker : undefined,
        paragraph: pIndex,
      });
    });
  });

  const paragraphCount = paragraphs.length;
  void paragraphCount;
  const contentHeight = (list: TextLine[]): number => {
    let h = 0;
    list.forEach((line, i) => {
      const prev = list[i - 1];
      if (prev && prev.paragraph !== line.paragraph) h += paragraphSpacing;
      h += lineHeight;
    });
    return h;
  };
  let width = 0;
  for (const line of lines) width = Math.max(width, line.width + line.indent);

  let visible = lines;
  let truncated = false;
  if (options.maxHeight !== undefined && contentHeight(lines) > options.maxHeight + 0.5) {
    const budget = Math.max(lineHeight, options.maxHeight);
    const keep: TextLine[] = [];
    for (const line of lines) {
      if (contentHeight([...keep, line]) > budget + 0.5) break;
      keep.push(line);
    }
    if (keep.length === 0) keep.push(lines[0]);
    if (keep.length < lines.length) {
      truncated = true;
      if (options.truncate) {
        const last = keep[keep.length - 1];
        const available = options.maxWidth === undefined ? last.width : Math.max(1, options.maxWidth - last.indent);
        const clipped = ellipsize(last.text, font, spacing, available, options.measure);
        keep[keep.length - 1] = {
          ...last,
          text: clipped,
          width: measureLine(clipped, font, spacing, options.measure),
        };
      }
      visible = keep;
    }
  }

  return {
    lines: visible,
    lineHeight,
    width: Math.max(1, width),
    height: Math.max(lineHeight, contentHeight(visible)),
    truncated,
  };
}

/** 文本节点的目标尺寸：auto-width 不换行，auto-height 固定宽度换行，fixed 保留给定框。 */
export function measureTextBox(
  node: Pick<DocNode, "width" | "height" | "textAutoResize" | "listType" | "truncate">,
  style: NodeStyle,
  measure: MeasureText,
  text: string,
): { width: number; height: number } {
  const mode = textAutoResizeOf(node);
  if (mode === "fixed") return { width: node.width, height: node.height };
  const result = layoutText(text, style, {
    measure,
    listType: node.listType,
    maxWidth: mode === "auto-height" ? node.width : undefined,
  });
  return mode === "auto-height"
    ? { width: node.width, height: result.height }
    : { width: result.width, height: result.height };
}
