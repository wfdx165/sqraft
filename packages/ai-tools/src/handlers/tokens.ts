// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import { blockedDeleteMessage, planTokenDelete, tokenColorOf, tokenNumberOf, tokenPathOf } from "../shared";
import type { Handler } from "../types";

/** `get_tokens` */
export const handleGetTokens: Handler = async (ctx, args) => {
    const tokens = ctx.store.doc.tokens;
    if (Object.keys(tokens).length === 0) {
      return JSON.stringify({
        tokens,
        hint: "当前文档没有设计系统。可以先用 define_token 建 Token，或直接用 fill / stroke 字面量。",
      });
    }
    return JSON.stringify({ tokens });
};

/** `define_token` */
export const handleDefineToken: Handler = async (ctx, args) => {
    const path = tokenPathOf(args.path);
    if (!path) {
      throw new Error(
        `Token 路径 "${String(args.path ?? "")}" 不合法：至少形如 color/primary，不能含空格或空段`,
      );
    }
    const type = args.type === "color" || args.type === "number" ? args.type : null;
    if (!type) throw new Error('type 只能是 "color" 或 "number"');
    const raw = args.value;
    const value = type === "color" ? tokenColorOf(raw) : tokenNumberOf(raw);
    if (value === null) {
      throw new Error(
        type === "color"
          ? `颜色 "${String(raw ?? "")}" 不合法：需要 #hex、rgb() 或 rgba()`
          : `数值 "${String(raw ?? "")}" 不合法`,
      );
    }
    const prev = ctx.store.doc.tokens[path];
    if (prev && prev.type !== type) {
      throw new Error(`Token "${path}" 已存在且类型为 ${prev.type}，不能改成 ${type}`);
    }
    ctx.store.apply({ type: "token.define", params: { path, tokenType: type, value } }, "ai:define_token");
    return JSON.stringify({ ok: true, path, type, value });
};

/** `rename_token` */
export const handleRenameToken: Handler = async (ctx, args) => {
    const from = tokenPathOf(args.from);
    const to = tokenPathOf(args.to);
    if (!from) throw new Error(`Token 路径 "${String(args.from ?? "")}" 不合法：至少形如 color/primary`);
    if (!to) throw new Error(`Token 路径 "${String(args.to ?? "")}" 不合法：至少形如 color/primary`);
    if (from === to) throw new Error("from 与 to 不能相同");
    if (!ctx.store.doc.tokens[from]) throw new Error(`Token "${from}" 不存在`);
    if (ctx.store.doc.tokens[to]) throw new Error(`Token "${to}" 已存在，不能重命名`);
    ctx.store.apply({ type: "token.rename", params: { from, to } }, "ai:rename_token");
    return JSON.stringify({ ok: true, from, to });
};

/** `delete_token` */
export const handleDeleteToken: Handler = async (ctx, args) => {
    const path = tokenPathOf(args.path);
    if (!path) throw new Error(`Token 路径 "${String(args.path ?? "")}" 不合法：至少形如 color/primary`);

    // 宽容解析：部分客户端会把布尔写成字符串；"false" / 缺省仍按拒绝处理（安全侧不放松）
    const detach = args.detach === true || args.detach === "true";
    const plan = planTokenDelete(ctx.store.doc, path, detach);
    if (plan.status === "missing") throw new Error(`Token "${path}" 不存在`);
    if (plan.status === "blocked") throw new Error(blockedDeleteMessage(ctx.store.doc, path, plan.refs, plan.value));

    try {
      for (const cmd of plan.commands) ctx.store.apply(cmd, "ai:delete_token");
    } catch (error) {
      // 引用里含锁定节点时，core 只会说「节点「X」已锁定」：补上是谁在做哪件事
      throw new Error(
        `删除 Token "${path}" 失败：${error instanceof Error ? error.message : String(error)}` +
          "（引用含锁定节点时需先解锁）",
      );
    }
    return JSON.stringify({ ok: true, path, detached: plan.refs.length });
};
