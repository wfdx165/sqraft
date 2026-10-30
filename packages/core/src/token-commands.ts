/**
 * Token 命令：define / delete / rename 的落地与逆命令。
 *
 * 从 `DocStore.applyOne` 抽出来：store 只负责命令调度，Token 的引用遍历
 * （fill / stroke / 阴影颜色）与逆操作集中在这里维护。
 */
import type { DocState, NodeId } from "./model";
import type { Command } from "./store";

export type TokenCommand = Extract<Command, { type: "token.define" | "token.delete" | "token.rename" }>;

/** 应用一条 token 命令，返回撤销它所需的逆命令。 */
export function applyTokenCommand(state: DocState, cmd: TokenCommand, changed: Set<NodeId>): { cmd: Command } {
  switch (cmd.type) {
    case "token.define": {
      const { path, tokenType, value } = cmd.params;
      const prevToken = state.tokens[path];
      state.tokens[path] = { type: tokenType, value };
      changed.add("__doc__" as NodeId);
      if (prevToken) {
        return {
          cmd: { type: "token.define", params: { path, tokenType: prevToken.type, value: prevToken.value } },
        };
      }
      // 新建 token 的逆是删除：撤销"粘贴带过来的 Token"要能真的清掉
      return { cmd: { type: "token.delete", params: { path } } };
    }
    case "token.delete": {
      const { path } = cmd.params;
      const prev = state.tokens[path];
      if (!prev) return { cmd: { type: "token.delete", params: { path } } };
      delete state.tokens[path];
      changed.add("__doc__" as NodeId);
      return { cmd: { type: "token.define", params: { path, tokenType: prev.type, value: prev.value } } };
    }
    case "token.rename": {
      const { from, to } = cmd.params;
      // 非法改名直接抛错：静默 no-op 会留下一条"撤销了却什么也没变"的历史
      if (from === to) throw new Error(`Token "${from}" 的目标路径与原名相同`);
      const entry = state.tokens[from];
      if (!entry) throw new Error(`Token "${from}" 不存在`);
      if (state.tokens[to]) throw new Error(`Token "${to}" 已存在，不能重命名`);

      delete state.tokens[from];
      state.tokens[to] = entry;

      // 引用随动：填充、描边与阴影颜色（效果里的 Paint）都要跟着改
      for (const node of Object.values(state.nodes)) {
        const style = node.style;
        let next: typeof style | null = null;
        if (style.fill?.token === from) next = { ...style, fill: { ...style.fill, token: to } };
        if (style.stroke?.token === from) next = { ...(next ?? style), stroke: { ...style.stroke, token: to } };
        const effects = style.effects;
        if (effects?.some((e) => (e.type === "drop-shadow" || e.type === "inner-shadow") && e.color.token === from)) {
          const base = next ?? style;
          next = {
            ...base,
            effects: (base.effects ?? []).map((effect) => {
              if (effect.type !== "drop-shadow" && effect.type !== "inner-shadow") return effect;
              if (effect.color.token !== from) return effect;
              return { ...effect, color: { ...effect.color, token: to } };
            }),
          };
        }
        if (next) {
          node.style = next;
          changed.add(node.id);
        }
      }
      changed.add("__doc__" as NodeId);
      return { cmd: { type: "token.rename", params: { from: to, to: from } } };
    }
  }
}
