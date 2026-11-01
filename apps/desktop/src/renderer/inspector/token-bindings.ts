/**
 * 检查器的数值 Token 绑定：展示解析值、打开选择器、绑定/解绑。
 *
 * 从 `useInspector` 里抽出来控制单文件体积；不持有文档状态，
 * 批量写回仍通过调用方传入的 applyStyle / applyTextStyle / applyNodes。
 */
import { computed, type ComputedRef } from "vue";
import {
  CORNER_RADIUS_KEYS,
  NUMERIC_TOKEN_OF_LITERAL,
  PADDING_SIDE_KEYS,
  resolveNumericLayout,
  resolveNumericStyle,
  type DocNode,
  type LayoutSpec,
  type NodeStyle,
  type Padding,
  type CornerRadius,
  type NumericLiteralField,
} from "@sqraft/core";
import { openTokenPicker } from "../token-picker";
import { docStore } from "../store";
import { showToast } from "../toast";

export type ScalarTokenField = NumericLiteralField;

export interface TokenBindingDeps {
  nodes: ComputedRef<DocNode[]>;
  node: ComputedRef<DocNode | null>;
  applyStyle: (fn: (style: NodeStyle) => NodeStyle, label?: string) => void;
  applyTextStyle: (patch: Partial<NodeStyle>, label?: string) => void;
  applyNodes: (fn: (node: DocNode) => Partial<DocNode> | null, label?: string) => void;
}

/** 多选时只在所有节点绑定一致时返回路径，否则视为未绑定。 */
function sharedToken(nodes: DocNode[], read: (node: DocNode) => string | undefined): string {
  const values = nodes.map(read);
  const first = values[0] ?? "";
  return values.every((value) => (value ?? "") === first) ? first : "";
}

export function createTokenBindings(deps: TokenBindingDeps) {
  /** 展示用的解析结果：Token 优先，未绑定回退字面量。 */
  const styleView = computed<NodeStyle | null>(() => {
    const n = deps.node.value;
    return n ? resolveNumericStyle(docStore.doc, n.style) : null;
  });

  const layoutView = computed<LayoutSpec | null>(() => {
    const n = deps.node.value;
    return n?.layout ? resolveNumericLayout(docStore.doc, n.layout) : null;
  });

  function scalarTokenOf(field: ScalarTokenField): string {
    return sharedToken(deps.nodes.value, (n) => n.style[NUMERIC_TOKEN_OF_LITERAL[field]] as string | undefined);
  }

  function cornerTokenOf(corner: keyof CornerRadius): string {
    return sharedToken(deps.nodes.value, (n) => n.style.cornerRadiusTokens?.[corner]);
  }

  function allCornerToken(): string {
    return sharedToken(deps.nodes.value, (n) => {
      const map = n.style.cornerRadiusTokens;
      if (!map) return undefined;
      const first = map.topLeft;
      return first && CORNER_RADIUS_KEYS.every((key) => map[key] === first) ? first : undefined;
    });
  }

  function paddingTokenOf(side: keyof Padding): string {
    return sharedToken(deps.nodes.value, (n) => n.layout?.paddingTokens?.[side]);
  }

  function allPaddingToken(): string {
    return sharedToken(deps.nodes.value, (n) => {
      const map = n.layout?.paddingTokens;
      if (!map) return undefined;
      const first = map.top;
      return first && PADDING_SIDE_KEYS.every((key) => map[key] === first) ? first : undefined;
    });
  }

  function layoutTokenOf(key: "gap" | "crossGap"): string {
    return sharedToken(deps.nodes.value, (n) => n.layout?.[key === "gap" ? "gapToken" : "crossGapToken"]);
  }

  function openScalarToken(field: ScalarTokenField, e: MouseEvent): void {
    openTokenPicker({
      x: e.clientX,
      y: e.clientY,
      current: scalarTokenOf(field),
      onPick: (path) => bindScalarToken(field, path),
    });
  }

  function bindScalarToken(field: ScalarTokenField, path: string | null): void {
    const tokenKey = NUMERIC_TOKEN_OF_LITERAL[field];
    if (field === "strokeWidth") {
      deps.applyStyle((style) => ({ ...style, [tokenKey]: path ?? undefined }), "绑定 Token");
      return;
    }
    if (!deps.nodes.value.some((n) => n.type === "text")) {
      showToast("当前选区没有文本图层", "error");
      return;
    }
    const patch = { [tokenKey]: path ?? undefined } as Partial<NodeStyle>;
    // 自动行高会忽略数值，绑定时切到 px 才能立即生效
    if (path && field === "lineHeight" && (deps.node.value?.style.lineHeightUnit ?? "auto") === "auto") {
      patch.lineHeightUnit = "px";
    }
    deps.applyTextStyle(patch, "绑定 Token");
  }

  function openCornerToken(corner: keyof CornerRadius | "all", e: MouseEvent): void {
    openTokenPicker({
      x: e.clientX,
      y: e.clientY,
      current: corner === "all" ? allCornerToken() : cornerTokenOf(corner),
      onPick: (path) => bindCornerToken(corner, path),
    });
  }

  function bindCornerToken(corner: keyof CornerRadius | "all", path: string | null): void {
    const keys = corner === "all" ? CORNER_RADIUS_KEYS : [corner];
    deps.applyStyle((style) => {
      const map = { ...(style.cornerRadiusTokens ?? {}) };
      for (const key of keys) {
        if (path) map[key] = path;
        else delete map[key];
      }
      return {
        ...style,
        cornerRadiusTokens: Object.keys(map).length > 0 ? map : undefined,
      };
    }, "绑定 Token");
  }

  function openPaddingToken(side: keyof Padding | "all", e: MouseEvent): void {
    openTokenPicker({
      x: e.clientX,
      y: e.clientY,
      current: side === "all" ? allPaddingToken() : paddingTokenOf(side),
      onPick: (path) => bindPaddingToken(side, path),
    });
  }

  function bindPaddingToken(side: keyof Padding | "all", path: string | null): void {
    if (!deps.nodes.value.some((n) => n.layout)) {
      showToast("当前图层没有自动布局", "error");
      return;
    }
    const sides = side === "all" ? PADDING_SIDE_KEYS : [side];
    deps.applyNodes((n) => {
      if (!n.layout) return null;
      const map = { ...(n.layout.paddingTokens ?? {}) };
      for (const key of sides) {
        if (path) map[key] = path;
        else delete map[key];
      }
      const paddingTokens = Object.keys(map).length > 0 ? map : undefined;
      return { layout: { ...n.layout, paddingTokens } };
    }, "绑定 Token");
  }

  function openLayoutToken(key: "gap" | "crossGap", e: MouseEvent): void {
    openTokenPicker({
      x: e.clientX,
      y: e.clientY,
      current: layoutTokenOf(key),
      onPick: (path) => bindLayoutToken(key, path),
    });
  }

  function bindLayoutToken(key: "gap" | "crossGap", path: string | null): void {
    if (!deps.nodes.value.some((n) => n.layout)) {
      showToast("当前图层没有自动布局", "error");
      return;
    }
    const tokenKey = key === "gap" ? "gapToken" : "crossGapToken";
    deps.applyNodes(
      (n) => (n.layout ? { layout: { ...n.layout, [tokenKey]: path ?? undefined } } : null),
      "绑定 Token",
    );
  }

  return {
    styleView,
    layoutView,
    scalarTokenOf,
    cornerTokenOf,
    allCornerToken,
    paddingTokenOf,
    allPaddingToken,
    layoutTokenOf,
    openScalarToken,
    openCornerToken,
    openPaddingToken,
    openLayoutToken,
  };
}
