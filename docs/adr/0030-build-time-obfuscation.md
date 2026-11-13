# ADR-0030：构建期硬化（压缩、零 node_modules、fuse、成品验收）

> 本 ADR 最初写于闭源时期（0.0.2），当时的首要目标是防止 `asar extract` 读出源码。
> 2026-11 起 Sqraft 以 Apache-2.0 开源，源码本来就在公开仓库，这个目标随之消失；
> 下面的构建约束技术上一行未改，但动机改为**包体积、启动开销、攻击面与成品完整性**。

## Context

- 0.0.2 的成品包实际体积远大于运行所需：
  - `app.asar` 里带着 `@sqraft/core`、`@sqraft/render`、`@sqraft/ai-tools` 的原始 TypeScript
    （718 个条目，含 `src/*.ts`、`tsconfig.json`）——运行时根本不会加载；
  - 渲染层 bundle 未压缩（electron-vite 6 对 main / preload / renderer 默认 `minify: false`），
    `index-*.js` 约 1 MB，注释与许可头完整；
  - 主进程与 preload 运行时只 `require("electron")` + Node 内置模块，**不需要任何 `node_modules`**，
    成品里却装了整个依赖树，包括运行时用不到的 `@vue/compiler-sfc`、`@babel/parser` 与 150 个 `.map`。
- Electron fuse 全是默认值：`RunAsNode=ON`、`EnableNodeCliInspectArguments=ON`、
  `OnlyLoadAppFromAsar=OFF`、`EnableEmbeddedAsarIntegrityValidation=OFF`。打包版没有任何理由
  保留 `--inspect` 或 `ELECTRON_RUN_AS_NODE` 这类入口。
- 未签名、未公证（adhoc，`spctl` 拒绝），见 ADR-0029；不引入 Apple 开发者账号。
  （2026-11 已改为 Developer ID 签名 + 公证，见 ADR-0034；这条保留为当时的背景。）
- `.sqraft` 仍是明文 zip：它是调试、排障与互通的基础，客户端加密对本地文件没有意义。

目标：

- **要得到**：更小的下载体积、更少的启动解析、更小的攻击面、发版前能自动发现“构建配置被改坏”。
- **不追求**：防逆向、防换皮分发、防付费绕过。源码公开后这些都不在威胁模型里。

## Decision

**T0（构建约束，已实现）**

1. **压缩**：`main` / `preload` / `renderer` 全开 `build.minify`（esbuild），CSS 同步压缩。
2. **sourcemap**：不生成（`build.sourcemap: false`）。应用没有崩溃上报，sourcemap 没有消费方，
   只会撑大安装包；需要排障时按发版 tag 检出源码、临时打开 sourcemap 重建一次。不做归档、不上传。
3. **成品零 `node_modules`**：三个 `@sqraft/*`、`vue`、两个 fontsource 放在 `devDependencies`
   ——它们只被 Vite 打包期消费，主进程/preload 运行时不引用。`dependencies` 为空即整棵树不进 asar。
4. **Electron fuse（`@electron/fuses` 2.1.3）**：
   `RunAsNode` 关、`EnableNodeOptionsEnvironmentVariable` 关、`EnableNodeCliInspectArguments` 关、
   `OnlyLoadAppFromAsar` 开；`afterPack` 里翻转，`strictlyRequireAllFuses` 打开——
   Electron 升级新增 fuse 时构建直接失败，逼着我们复核一次（Electron 45 已有 9 个）。
   **Windows 的 `Sqraft.exe` 同样翻转**（同一个 `after-pack.mjs`，ADR-0033）：`RunAsNode` /
   `NODE_OPTIONS` 注入 / 调试参数在 Windows 包上一样不该保留。
   代价：打包版不能 `--inspect`、不能 `ELECTRON_RUN_AS_NODE`、不能用 `NODE_OPTIONS` 注入；
   日常验证本来就不跑打包版（AGENTS.md）。
   `EnableEmbeddedAsarIntegrityValidation` **保持关**：`ElectronAsarIntegrity` 的哈希写在
   `Info.plist` 里，未签名时改包的人顺手就能改，开了只增加构建失败点。
   （2026-11 起 macOS 已签名，哈希受签名保护；开启仍需要一次"改包必挂"的负向测试，
   且 Windows exe 未签名时收益有限，另开票评估，见 ADR-0034。）
5. **成品验收**：`scripts/verify-pack.mjs` 挂进 `release.mjs` 的发版前置检查——断言 asar 只有
   `out/**` + `package.json`、不含 `.ts`/`.map`、`dependencies` 为空、渲染层已压缩、fuse 状态符合第 4 条；
   任一不满足即中止发版。不挂进 `pnpm test`（测试不该依赖构建产物）。

**T1：JS 混淆——否决**

`javascript-obfuscator` 的控制流平坦化会拖慢 20%+，且与三件事直接冲突：Vue 的属性名访问、
MCP 工具名与 JSON 字段字符串、`.sqraft` 的 `formatVersion` 契约。能安全做的只有“字符串数组 +
变量名混淆”，而它在 T0 的压缩之上只增加几个小时的逆向时间，维护成本（每次发版验证、错误栈、
构建时间）远大于收益。源码既然公开，混淆没有意义。

**T2：V8 字节码 / 原生 / WASM / 服务端——否决**

`bytenode` 要求把核心从渲染层搬进主进程（当前命令模型、渲染器、AI 工具全在渲染层），
是一次架构级改造，和“轻量、单机、快速迭代”的定位冲突，且每个平台要各自编译、
与自更新 zip 流程重新对齐。原生/WASM 重写、把内核放服务端更重，后者还会把“纯单机、无后端”
这个卖点直接推翻。

**重开条件**（出现任一条再开新 ADR）：

1. 引入付费授权或闭源模块，需要防 patch；
2. 拿到 Apple 开发者账号并开始签名——届时“防改包”回到讨论范围，asar 完整性 fuse 才有意义；
   **2026-11 已触发**（ADR-0034）：签名已落地，但 asar 完整性仍保持关闭，另开票评估。
3. 出现真实证据表明成品包被篡改后对外分发。

**文件格式**：明文 zip 保持。

## Considered Options

- **保留 `dependencies`，用 `files: ["!node_modules/**"]` 排除**：与 electron-builder 的依赖收集逻辑对抗，
  每次升级打包器都可能失效。移动依赖分类是语义正确的做法。
- **给每个包加 `files` 字段只进 `src/index.ts`**：只解决一半，`.map` 与编译器源码仍在包里。
- **`EnableEmbeddedAsarIntegrityValidation` 开启**：未签名状态下是纸糊的，纯负收益
  （签名后条件已满足，但需要负向测试，见 ADR-0034）。
- **签名 + 公证**：能顺带解决 Gatekeeper 首启拦截，但属于另一票（2026-11 已落地，ADR-0034）。
- **对渲染层保留可读错误栈（不压缩）**：包体积与启动解析差一个量级。

## Consequences

- 成品包里不再有 TypeScript 源码或 `.map`；`asar extract` 只能拿到压缩后的 bundle。
- 打包版不能 `--inspect` 或 `ELECTRON_RUN_AS_NODE`；只影响排障手段，不影响功能。
  线上崩溃栈不可读，排障时按发版 tag 检出源码重建。
- `dependencies` 为空是一条构建约束：以后给主进程/preload 加依赖时，若 Vite 没有 bundle 它，
  运行时会缺模块。`verify-pack.mjs` 能发现“包里多了 node_modules”，发现不了“bundle 里少了依赖”，
  后者只能靠手点清单（开→改→存→重开 + MCP 建节点 → 截图）。
- 压缩改变堆栈与符号名，`import.meta.env.DEV` 分支仍由 Vite 静态替换，行为不变。
- `.sqraft` 格式、MCP 工具名与 schema、CSS 与模板结构都是公开的产品契约，不隐藏。
