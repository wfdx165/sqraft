/**
 * 检查器的「原型」标签页：链接读写与页面滚动设置。
 *
 * 从 `useInspector` 里拆出来是为了控制单文件体积；这里只依赖选区快照
 * （`node` / `multi`）与锁定链判断，不碰设计面板的样式与布局逻辑。
 *
 * 纪律：所有写入都走 `node.update` 命令，一次改动 = 一个撤销步；
 * 归一化与位置校验在 `@sqraft/core` 的 `normalizeInteractions` 里，这里不重复。
 */
import { computed, type ComputedRef } from "vue";
import {
  DEFAULT_DISSOLVE_MS,
  getPages,
  hasInstanceAncestor,
  isInPageSubtree,
  newId,
  type DocNode,
  type Interaction,
} from "@sqraft/core";
import { dispatch, docStore, ui } from "../store";
import { t } from "../i18n";

export interface PrototypeDeps {
  /** 选区第一个节点（单选/多选都取首个） */
  node: ComputedRef<DocNode | null>;
  multi: ComputedRef<boolean>;
  /** 节点或祖先是否被锁定（锁定后不允许改链接） */
  lockedChain: (n: DocNode | null | undefined) => boolean;
}

export function usePrototype({ node, multi, lockedChain }: PrototypeDeps) {
  const inspectorTab = computed(() => ui.inspectorTab);

  function setInspectorTab(tab: "design" | "prototype"): void {
    ui.inspectorTab = tab;
  }

  /** 选中节点所在的页面（沿祖先链）。 */
  const nodePage = computed<DocNode | null>(() => {
    void ui.version;
    let cur = node.value;
    while (cur) {
      if (cur.type === "page") return cur;
      cur = cur.parentId ? docStore.doc.nodes[cur.parentId] : null;
    }
    return null;
  });

  /** 只有第一条交互可编辑；其余是 agent 写入的，只读展示。 */
  const link = computed(() => {
    void ui.version;
    return node.value?.interactions?.[0] ?? null;
  });

  const extraLinkCount = computed(() => {
    void ui.version;
    return Math.max(0, (node.value?.interactions?.length ?? 0) - 1);
  });

  /** 目标下拉可选页面：排除当前页（跳回原地没有意义）。 */
  const linkPages = computed(() => {
    void ui.version;
    const exclude = nodePage.value?.id;
    return getPages(docStore.doc).filter((page) => page.id !== exclude);
  });

  const linkTargetValue = computed(() => {
    const current = link.value;
    if (!current) return "";
    return current.action === "back" ? "__back__" : (current.targetId ?? "");
  });

  /** 这里为什么不能挂链接；null 表示可以。 */
  const linkBlocked = computed<string | null>(() => {
    const current = node.value;
    if (!current) return null;
    if (multi.value) return t("inspector.linkHintMulti");
    if (lockedChain(current)) return t("inspector.lockedHint");
    if (current.type === "page") return t("inspector.linkHintPage");
    if (hasInstanceAncestor(docStore.doc, current.id)) return t("inspector.linkHintInstance");
    if (!isInPageSubtree(docStore.doc, current.id)) return t("inspector.linkHintComponent");
    return null;
  });

  /** 写第一条交互，其余（agent 写入的）原样保留。 */
  function writeLink(next: Interaction | null): void {
    const current = node.value;
    if (!current) return;
    const all = next ? [next, ...(current.interactions?.slice(1) ?? [])] : (current.interactions?.slice(1) ?? []);
    dispatch(
      { type: "node.update", params: { nodeId: current.id, patch: { interactions: all.length ? all : undefined } } },
      "prototype",
    );
  }

  function setLinkTarget(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const current = link.value;
    if (!value) {
      writeLink(null);
      return;
    }
    const id = current?.id ?? newId();
    if (value === "__back__") {
      writeLink({ id, trigger: "click", action: "back", transition: { type: "instant", durationMs: 0 } });
      return;
    }
    writeLink({
      id,
      trigger: "click",
      action: "navigate",
      targetId: value,
      transition:
        current?.action === "navigate" ? current.transition : { type: "dissolve", durationMs: DEFAULT_DISSOLVE_MS },
    });
  }

  function setLinkTransition(event: Event): void {
    const current = link.value;
    if (!current) return;
    const instant = (event.target as HTMLSelectElement).value === "instant";
    writeLink({
      ...current,
      transition: {
        type: instant ? "instant" : "dissolve",
        durationMs: instant ? 0 : Math.max(current.transition.durationMs || 0, DEFAULT_DISSOLVE_MS),
      },
    });
  }

  function setLinkDuration(event: Event): void {
    const current = link.value;
    if (!current) return;
    const value = Math.round(Number((event.target as HTMLInputElement).value));
    if (!Number.isFinite(value)) return;
    writeLink({ ...current, transition: { ...current.transition, durationMs: value } });
  }

  function removeLink(): void {
    writeLink(null);
  }

  function setScrollDirection(event: Event): void {
    const current = node.value;
    if (!current || current.type !== "page") return;
    const value = (event.target as HTMLSelectElement).value;
    dispatch(
      {
        type: "node.update",
        params: {
          nodeId: current.id,
          patch: { scrollDirection: value === "none" ? undefined : (value as "vertical" | "horizontal") },
        },
      },
      "prototype",
    );
  }

  return {
    inspectorTab,
    setInspectorTab,
    link,
    extraLinkCount,
    linkPages,
    linkTargetValue,
    linkBlocked,
    setLinkTarget,
    setLinkTransition,
    setLinkDuration,
    removeLink,
    setScrollDirection,
  };
}
