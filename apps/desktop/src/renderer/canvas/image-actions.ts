/**
 * 图片插入：菜单选图、拖入画布、粘贴字节、文件选择框。
 *
 * 从 `CanvasView` 抽出来（它已经两千多行）：这里只依赖"取页面 / 屏幕坐标换算 /
 * 切活动页"三件事，画布把这三件事以 deps 传进来，模块本身不碰指针手势。
 */
import { createNode, type DocNode, type NodeId } from "@sqraft/core";
import { putAsset } from "../assets";
import { docStore, select } from "../store";
import { showToast } from "../toast";
import { t } from "../i18n";
import { insertSvgFrame } from "./svg-insert";

/** SVG 源文件上限（与导入规格一致）。 */
const MAX_SVG_BYTES = 5 * 1024 * 1024;

export interface ImageInsertDeps {
  /** 当前视口（世界坐标原点 + 像素尺寸 + 缩放） */
  viewport(): { x: number; y: number; width: number; height: number; zoom: number };
  /** 画布内坐标 → 世界坐标 */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number };
  activePage(): DocNode | null;
  pageAtViewportCenter(): DocNode | null;
  /** 世界坐标下命中的页面 id（没有则 null） */
  pageAt(x: number, y: number): NodeId | null;
  /** 左栏切到该页并展开（新图层才看得到） */
  focusPage(pageId: NodeId): void;
}

/** 视口中心对应的世界坐标（粘贴图片的默认落点）。 */
export function viewportCenterWorld(deps: ImageInsertDeps): { x: number; y: number } {
  const vp = deps.viewport();
  return { x: vp.x + vp.width / (2 * vp.zoom), y: vp.y + vp.height / (2 * vp.zoom) };
}

/**
 * 插入一批图片：按原始像素落地，超过页面 80% 时等比缩小，多张横向排开。
 * 单张失败（格式/体积/解码）汇总成一次错误提示，不打断其它图片。
 */
export async function insertImages(
  files: readonly { bytes: Uint8Array; name: string }[],
  deps: ImageInsertDeps,
  anchor?: { x: number; y: number },
  options: { svgAsImage?: boolean } = {},
): Promise<void> {
  // 落在哪一页：拖放点/视口中心下的页面优先，其次活动页。
  // 只认 activePageId 的话，拖动模式或视角停在别的页时图片会插到看不见的页里。
  const under = anchor ? deps.pageAt(anchor.x, anchor.y) : null;
  const page = (under ? docStore.doc.nodes[under] : null) ?? deps.activePage() ?? deps.pageAtViewportCenter();
  if (!page || page.type !== "page") {
    await window.sqraft.dialog.error(t("error.noPageForImage"));
    return;
  }
  const pageId = page.id;

  const problems: string[] = [];
  const nodes: DocNode[] = [];
  const svgFrames: DocNode[] = [];
  // 落点夹在页面内：视口中心可能落在页面外（缩放很小时），不夹会把图插到画板外
  const local = anchor ? { x: anchor.x - page.x, y: anchor.y - page.y } : { x: 40, y: 40 };
  let cursorX = Math.round(Math.min(Math.max(0, local.x), Math.max(0, page.width - 40)));
  let cursorY = Math.round(Math.min(Math.max(0, local.y), Math.max(0, page.height - 40)));
  const maxSide = Math.max(page.width, page.height) * 0.8;

  for (const file of files) {
    // SVG 默认按矢量导入；⌥ 拖入或解析失败时退回图片
    if (!options.svgAsImage && /\.svg$/i.test(file.name)) {
      if (file.bytes.length > MAX_SVG_BYTES) {
        problems.push(`${file.name}：${t("svgImport.tooLarge", { mb: Math.round(MAX_SVG_BYTES / 1024 / 1024) })}`);
        continue;
      }
      let inserted: Awaited<ReturnType<typeof insertSvgFrame>> | null = null;
      try {
        inserted = await insertSvgFrame({
          text: new TextDecoder().decode(file.bytes),
          name: file.name,
          pageId,
          x: cursorX,
          y: cursorY,
        });
      } catch (error) {
        problems.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!inserted) continue;
      if (inserted.status === "ok") {
        const frame = docStore.doc.nodes[inserted.result.frameId];
        if (frame) svgFrames.push(frame);
        if (inserted.result.missingFonts.length > 0) {
          showToast(t("svgImport.missingFonts", { fonts: inserted.result.missingFonts.join(", ") }), "error");
        }
        if (inserted.result.rasterized.length > 0) {
          showToast(t("svgImport.rasterized", { count: inserted.result.rasterized.length }), "info");
        }
        cursorX += inserted.result.width + 16;
        continue;
      }
      showToast(t("svgImport.fallback"));
    }

    const asset = await putAsset(file.bytes);
    if (!asset.ok) {
      problems.push(`${file.name}：${asset.reason}`);
      continue;
    }
    const scale = Math.min(1, maxSide / Math.max(asset.width, asset.height, 1));
    const width = Math.max(1, Math.round(asset.width * scale));
    const height = Math.max(1, Math.round(asset.height * scale));
    nodes.push(
      createNode("image", {
        name: file.name.replace(/\.[^.]+$/, "") || t("node.image"),
        parentId: pageId,
        x: cursorX,
        y: cursorY,
        width,
        height,
        image: {
          assetId: asset.id,
          naturalWidth: asset.width,
          naturalHeight: asset.height,
          crop: { x: 0, y: 0, width: asset.width, height: asset.height },
        },
      }),
    );
    cursorX += width + 16;
  }

  if (nodes.length > 0) {
    docStore.apply({ type: "node.create", params: { nodes, parentId: pageId } }, "插入图片");
  }
  const selected = [...nodes.map((node) => node.id), ...svgFrames.map((frame) => frame.id)];
  if (selected.length > 0) {
    deps.focusPage(pageId);
    select(selected);
  }
  if (problems.length > 0) await window.sqraft.dialog.error(problems.join("\n"));
}

/** 从 File 列表读取字节（渲染层能直接读 File，不需要经过主进程）。 */
export async function insertFromFiles(
  files: FileList | readonly File[],
  deps: ImageInsertDeps,
  anchor?: { x: number; y: number },
  options: { svgAsImage?: boolean } = {},
): Promise<void> {
  const payload: { bytes: Uint8Array; name: string }[] = [];
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|svg)$/i.test(file.name)) continue;
    payload.push({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
  }
  if (payload.length > 0) await insertImages(payload, deps, anchor, options);
}

/** 拖入文件：只要不是 .sqraft（那个交给主进程打开），其它图片就地插入。 */
export function dropImages(
  event: DragEvent,
  deps: ImageInsertDeps,
  canvas: HTMLCanvasElement | null,
): void {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  if (Array.from(files).some((file) => file.name.toLowerCase().endsWith(".sqraft"))) return;
  event.preventDefault();
  const rect = canvas?.getBoundingClientRect();
  const anchor = rect
    ? deps.screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
    : undefined;
  // ⌥ 拖入 = 明确要位图，绕过 SVG 矢量导入
  void insertFromFiles(files, deps, anchor, { svgAsImage: event.altKey });
}

/** 文件选择框的 change：读完立刻清空，选同一个文件也能再次触发。 */
export function readPickedFiles(event: Event, deps: ImageInsertDeps): void {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) void insertFromFiles(input.files, deps);
  input.value = "";
}

/** 打开系统文件选择框（隐藏的 input）。 */
export function pickImages(input: HTMLInputElement | null): void {
  input?.click();
}
