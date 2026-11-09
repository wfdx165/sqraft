/**
 * 生成应用图标源图（1024×1024 PNG，带透明边角）。
 * 用法：pnpm --filter @sqraft/desktop exec electron scripts/make-icon.cjs
 * 之后用 iconutil / electron-builder 转成 icns / ico。
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const html = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin: 0; height: 100%; background: transparent; }
  .icon {
    width: 1024px; height: 1024px;
    border-radius: 232px;
    background: linear-gradient(160deg, #6d64ff 0%, #4f46e5 55%, #3f37c9 100%);
    display: grid; place-items: center;
    font-family: -apple-system, "Helvetica Neue", sans-serif;
    color: #fff; font-size: 600px; font-weight: 600;
    letter-spacing: -18px;
  }
  .icon span { transform: translateX(-14px); }
</style></head>
<body><div class="icon"><span>S</span></div></body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: false },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await window.webContents.capturePage();
  const target = process.argv[2] ?? join(process.cwd(), "build", "icon.png");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, image.toPNG());
  console.log(`wrote ${target}`);
  app.quit();
});
