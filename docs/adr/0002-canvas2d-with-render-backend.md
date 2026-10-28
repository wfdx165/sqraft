# Canvas 2D 渲染 + RenderBackend 抽象（不走 WebGL 自研）

渲染层用 Canvas 2D 实现，且所有渲染调用必须经过 `RenderBackend` 接口；不从第一天自研 WebGL 渲染器。定位是轻量工具（单文件 ≤ 5k 节点、60fps），Canvas 2D + 视口剔除在此预算内足够，而 WebGL 路线意味着文本排版、命中检测、滤镜全部自研，是单人项目"引擎永远差一块"的经典无底洞。

## Considered Options

- WebGL2/WebGPU 自研（Figma 路线）：性能天花板最高，但在既定性能预算下收益为负。
- Skia-on-WASM：渲染质量好，但工具链与调试成本高，与"Web 优先、个人维护"冲突。
- 直接绑死 Canvas API（无抽象）：省一层间接，但撞墙时换后端要动全部调用点。

## Consequences

- 性能真撞墙时实现第二个 RenderBackend（WebGL2），文档模型与命令层零改动。
- 复杂滤镜（实时模糊等）在 v1 明确不做，属于"性能路线升级"的配套能力。
