# 矢量路径：本地锚点 + 包围盒推导

钢笔工具需要一套可编辑的曲线表示。三种候选：SVG `d` 字符串、0–1 归一化锚点、节点本地绝对坐标。选择**节点本地绝对坐标 + 相对锚点的手柄偏移**：

```ts
interface VectorAnchor {
  x: number;
  y: number;       // 锚点，节点本地坐标
  inX: number;     // 入手柄相对锚点的偏移
  inY: number;
  outX: number;    // 出手柄相对锚点的偏移
  outY: number;
}

interface VectorPath {
  closed: boolean;
  anchors: VectorAnchor[];
}
```

`path` 节点持有 `vector?: VectorPath`（复用已有的 `path` 类型，旧文档没有该字段也能打开）。

## 规则

- **包围盒推导**：锚点与手柄端点的包围盒就是节点框。命令层收到 `vector` 时先把路径平移到最小坐标为 0，再令 `node.x/y` 承接平移量、`width/height` 取包围盒尺寸。因此调用方（GUI / AI）可以按父容器坐标给点，不必自己算本地坐标。
- **手柄偏移**：全 0 表示该侧无手柄（尖角），缩放时与锚点一起按比例变化；`strokeWidth` 不缩放。
- **整体替换**：`patch.vector` 与 `patch.style` 一样是整体替换，撤销依赖这一点。一次锚点/手柄拖动只提交一条 `node.update`。
- **只改宽高时自动缩放**：`node.update` 命中带 `vector` 的节点且没有给 `vector` 时，按新旧尺寸比例缩放锚点与手柄；同时给 `vector` 时以 `vector` 为准。
- **闭合约束**：至少 2 个锚点；`closed: true` 至少 3 个，否则命令抛错且不产生撤销记录。
- **草稿不进文档**：钢笔绘制期只存在 UI 状态，结束时一次性 `node.create` 整条路径，撤销一步删除整条。
- **命中按几何**：无填充/开放路径按描边距离（5px 屏幕容差）；有填充的闭合路径内部也算命中，避免细曲线的大包围盒抢点击。

## Consequences

- 路径锚点与现有"子节点相对父容器"的坐标纪律一致，`worldRect` 仍可直接用于选中框与命中。
- 渲染后端新增 `drawPath`，Canvas 2D 用 `bezierCurveTo` 绘制真实曲线；命中检测在 core 内做纯函数采样，可在 Node 下测试。
- AI 工具与 GUI 共用同一套归一化规则：`points` 一律父容器坐标。
- 锚点增删、多选、布尔运算、SVG 导入导出均不在本决策范围内。
