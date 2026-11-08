# ADR-0030：构建期防护分级（T0 必做，T1/T2 否决）

## Context

Sqraft 是闭源软件：源码在私有 Gitea，公开发行仓库只放安装包（README「Sqraft 是闭源软件」）。
但 `0.0.2` 的成品包实际上等于分发源码：

- `app.asar` 里带着 `@sqraft/core`、`@sqraft/render`、`@sqraft/ai-tools` 的原始 TypeScript
  （718 个条目，含 `src/*.ts`、`tsconfig.json`）：`npx asar extract` 之后直接读。
- 渲染层 bundle 未压缩：`electron.vite.config.ts` 没有 `build` 块，electron-vite 6 对
  main / preload / renderer 默认 `minify: false`；`index-*.js` 约 1MB，注释与许可头完整。
- 主进程与 preload 运行时只 `require("electron")` + Node 内置模块，**不需要任何 `node_modules`**；
  成品里却装了整个依赖树，包括运行时用不到的 `@vue/compiler-sfc`、`@babel/parser` 与 150 个 `.map`。
- Electron fuse 全是默认值：`RunAsNode=ON`、`EnableNodeCliInspectArguments=ON`、
  `OnlyLoadAppFromAsar=OFF`、`EnableEmbeddedAsarIntegrityValidation=OFF`。
- 未签名、未公证（adhoc，`spctl` 拒绝），见 ADR-0029。

目标与边界（2026-11 与作者确认）：

- **要防的**：源码被读、设计器内核被抄。**不防**：换皮再分发、授权/收费绕过（当前免费、无付费墙）。
- **对手**：会 `asar extract`、会读 bundle、会改几行的开发者（B 级）。对商业竞品只做到"提高时间成本"，
  **明确不防专业逆向**——Electron 用 V8 JIT 跑 JS，逻辑必然可读，做到 D 级只有维护痛苦。
- **不动**：`.sqraft` 文件格式仍为明文 zip。它是调试、排障、互通的基础；客户端加密对 B 级对手等于没加密。
- **不上**：Apple 开发者账号、签名、公证（另立一票）。

## Decision

**T0（本轮必做，只改构建配置，半天内）**

1. **压缩**：`main` / `preload` / `renderer` 全开 `build.minify`（esbuild），CSS 同步压缩。
2. **sourcemap**：`build.sourcemap: "hidden"`——生成但不写 `//# sourceMappingURL`，
   asar 里排除 `**/*.map`；`pnpm dist` 把 map 归档到 `release/sourcemaps/<version>/`，
   不随包上传、不进 git、不进产品目录。任何一版发出后都能还原崩溃栈。
3. **成品零 `node_modules`**：三个 `@sqraft/*`、`vue`、两个 fontsource 移到 `devDependencies`
   ——它们只被 Vite 打包期消费，主进程/preload 运行时不引用。`dependencies` 为空即整棵树不进 asar。
4. **Electron fuse（引入 `@electron/fuses` 2.1.3，唯一新增的构建期依赖）**：
   `RunAsNode` 关、`EnableNodeOptionsEnvironmentVariable` 关、`EnableNodeCliInspectArguments` 关、
   `OnlyLoadAppFromAsar` 开；`afterPack` 里翻转，`strictlyRequireAllFuses` 打开——
   Electron 升级新增 fuse 时构建直接失败，逼着我们复核一次（Electron 45 已有 9 个）。
   代价：打包版不能再 `--inspect`、不能 `ELECTRON_RUN_AS_NODE`、不能用 `NODE_OPTIONS` 注入；
   日常验证本来就不跑打包版（AGENTS.md）。
   `EnableEmbeddedAsarIntegrityValidation` **保持关**：`ElectronAsarIntegrity` 的哈希写在
   `Info.plist` 里，未签名时改包的人顺手就能改，开了只增加构建失败点。
5. **验收脚本**：`scripts/verify-pack.mjs` 挂进 `release.mjs` 的发版前置检查——断言 asar 只有
   `out/**` + `package.json`、不含 `.ts`/`.map`、`dependencies` 为空、fuse 状态符合第 4 条；
   任一不满足即中止发版。不挂进 `pnpm test`（测试不该依赖构建产物）。

**T1：JS 混淆——否决**

`javascript-obfuscator` 的控制流平坦化会拖慢 20%+，且与三件事直接冲突：Vue 的属性名访问、
MCP 工具名与 JSON 字段字符串、`.sqraft` 的 `formatVersion` 契约。能安全做的只有"字符串数组 +
变量名混淆"，而它在 T0 的压缩之上只增加几个小时的逆向时间——对 B 级对手的边际收益接近零，
对 C 级对手无效。维护成本（每次发版验证、错误栈、构建时间）远大于收益。

**T2：V8 字节码 / 原生 / WASM / 服务端——否决**

`bytenode` 把主进程编成字节码，能真正藏住主进程逻辑；但它要求把核心从渲染层搬进主进程
（当前命令模型、渲染器、AI 工具全在渲染层），是一次架构级改造，和"轻量、单机、快速迭代"的定位冲突，
且每个平台要各自编译、与自更替的 zip 流程重新对齐。原生/WASM 重写、把内核放服务端更重，
后者还会把"纯单机、无后端"这个卖点直接推翻。

**重开条件**（出现任一条再开新 ADR，否则不必讨论）：

1. 出现实际证据：包被解出源码后改品牌分发，或内核被抄进竞品；
2. 引入付费授权，需要防 patch；
3. 拿到了 Apple 开发者账号并开始签名——届时"防改包"回到讨论范围，asar 完整性 fuse 才有意义。

**文件格式**：本轮不动，明文 zip 保持。

## Considered Options

- **只做 obfuscator、不做 T0 的清理**：本末倒置。当前泄露的 90% 来自"带源码 + 不压缩"这类配置问题，
  混淆器只是给没打伞的人发雨衣。
- **保留 `dependencies`，用 `files: ["!node_modules/**"]` 排除**：与 electron-builder 的依赖收集逻辑对抗，
  每次升级打包器都可能失效。移动依赖分类是语义正确的做法。
- **给每个包加 `files` 字段只进 `src/index.ts`**：只解决一半，`.map` 与编译器源码仍在包里。
- **`EnableEmbeddedAsarIntegrityValidation` 开启**：未签名状态下是纸糊的（见上），纯负收益。
- **签名 + 公证**：能顺带解决 Gatekeeper 首启拦截，但属于另一票，且不在本次威胁模型内。
- **对渲染层保留可读错误栈（不压缩）**：包体积与可读性差一个量级，且直接违背 T0 的第一目标。

## Consequences

- 成品包里不再有任何 TypeScript 源码或 `.map`；`asar extract` 只能拿到压缩后的 bundle。
- 线上崩溃栈不可读，必须靠 `release/sourcemaps/<version>/` 还原；**归档失败等于丢失该版本的排障能力**，
  所以 `release.mjs` 里归档要在打包成功后立刻做，早于任何可能失败的步骤。
- 打包版不能再 `--inspect` 或 `ELECTRON_RUN_AS_NODE`；只影响排障手段，不影响功能。
- `dependencies` 为空是一条新的构建约束：以后给主进程/preload 加依赖时，若 Vite 没有 bundle 它，
  运行时会缺模块。`verify-pack.mjs` 能发现"包里多了 node_modules"，发现不了"bundle 里少了依赖"，
  后者只能靠手点清单（开→改→存→重开 + MCP 建节点 → 截图）。
- 压缩改变堆栈与符号名，`import.meta.env.DEV` 分支仍由 Vite 静态替换，行为不变。
- 泄露面仍在：CSS、模板结构、MCP 工具名与 schema、`.sqraft` 格式——这些是产品契约，不隐藏。
- 这是**抬高门槛**，不是保护。真正的护城河是产品迭代速度，不是构建配置。
