// 工具名直接分派；每个分支保持原实现，ctx 提供 store 与宿主能力。
import { CURRENT_FORMAT_VERSION } from "../shared";
import type { Handler } from "../types";

/** `document.new` */
export const handleDocumentNew: Handler = async (ctx, args) => {
    if (!ctx.host) throw new Error("当前宿主不支持新建文档");
    const created = await ctx.host.newDocument();
    return JSON.stringify(created ? { ok: true } : { ok: false, canceled: true });
};

/** `document.open` */
export const handleDocumentOpen: Handler = async (ctx, args) => {
    if (!ctx.host) throw new Error("当前宿主不支持打开文档");
    if ("path" in args) throw new Error("document.open 只接受系统对话框选择文件，不接受路径参数");
    const opened = await ctx.host.openDocument();
    return JSON.stringify(opened ? { ok: true } : { ok: false, canceled: true });
};

/** `app_info` */
export const handleAppInfo: Handler = async (ctx, args) => {
    if (!ctx.host?.appInfo) throw new Error("当前宿主不支持 app_info");
    const meta = await ctx.host.appInfo();
    return JSON.stringify({ ...meta, formatVersion: CURRENT_FORMAT_VERSION });
};

/** `import_font` */
export const handleImportFont: Handler = async (ctx, args) => {
    if (!ctx.host?.importFont) throw new Error("当前宿主不支持导入字体");
    const fileName = String(args.fileName ?? "font");
    const data = String(args.dataBase64 ?? "");
    if (!data) throw new Error("import_font 需要 dataBase64");
    if (Math.ceil((data.length * 3) / 4) > 5 * 1024 * 1024) throw new Error("字体超过 5MB 上限");
    const meta = await ctx.host.importFont(fileName, data);
    if (!meta) throw new Error("字体导入失败：格式不支持或已损坏");
    return JSON.stringify({ ok: true, ...meta });
};
