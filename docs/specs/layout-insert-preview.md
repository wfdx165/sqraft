# 布局插入让位预览（Insert Preview）

日期：2026-10-29
状态：已实现

## 目标

把元素拖进自动布局容器时，兄弟节点按真实求解结果**让出空位**，让人在松手前就看见“插进去之后会变成什么样”。纯 UI 预览：不写文档、不进撤销，提交仍是一次命令批次。

## 行为

- 生效范围：落点是**合法可用**的自动布局容器（画板 / 组件），包括从外部拖入与在同一布局父级里重排。
- 不生效：`⌘` 落成绝对定位、非布局画板、非法落点、指针在页面外。
- 每个移动根各占一个槽位（多选时连续占 N 个），槽位尺寸取节点当前宽高；插入索引与提交共用 `reorderIndexAt`。
- 同父重排时，移动根先从原槽位移除，再按插入索引重新占位（原位置不会同时留空）。
- 被拖元素本身仍**跟着指针**（不吸进空位）；空位由插入线一起说明落点。
- hug 容器（主轴/交叉轴任一轴 hug）同步预览求解后的尺寸，避免子项溢出容器。
- 过渡：兄弟位置与容器尺寸用 **120ms ease-out** 插值；指针跨过兄弟中心切换索引时不瞬移。
- 指针离开容器或落点失效：兄弟与容器**缓动回**自然几何；松手 / `Esc` 立即清空预览。
- 预览期间仍然**不做吸附**（进流位置由求解器决定），插入线保留。

## 视觉

- 兄弟与 hug 容器用真实几何绘制，不加额外描边；落点仍由插入线 + 目标画板虚线框表达。
- 预览节点不参与命中；被拖元素继续按拖动预览偏移绘制。

## 实现

- `packages/render/src/renderer.ts`：`DrawOptions.geometryPreview`（节点 id → 局部几何），在 `geometryOf` 里优先于 `movePreview` / `resizePreview`。
- `apps/web/src/canvas/layout-preview.ts`：
  - `buildInsertPreview(containerId, index, roots)`：剔除移动根 → 插入等尺寸幽灵子项 → `solveLayout` → 返回子项新几何与 hug 容器尺寸；
  - `retargetInsertPreview` / `tickInsertPreview`：120ms ease-out 状态机，离开的节点缓动回自然位置。
- `apps/web/src/components/CanvasView.vue`：`updateMoveDrag` 按「容器 + 索引 + 根集合」缓存计算；`loop()` 逐帧推进过渡并重绘；`draw()` 把 `geometryPreview` 传给 `drawDocument`。
