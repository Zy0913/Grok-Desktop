/**
 * 用 Electron 将 assets/icon.svg 栅格化为 icon.png / icon-32.png（窗口与托盘）。
 * icon.png 需 ≥512（electron-builder mac 要求）；默认输出 1024。
 * 用法：npx electron scripts/gen-app-icon.mjs
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, "assets", "icon.svg");
const outPng = path.join(root, "assets", "icon.png");
const outPng32 = path.join(root, "assets", "icon-32.png");

const sizes = [
  { size: 1024, out: outPng },
  { size: 32, out: outPng32 },
];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, "utf8");
  for (const { size, out } of sizes) {
    const win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    const html = `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;display:flex;align-items:center;justify-content:center;overflow:hidden}
      svg{width:${Math.round(size * 0.88)}px;height:${Math.round(size * 0.88)}px;display:block}
    </style></head><body>${svg.replace(/fill="#111111"/g, 'fill="#0b0d12"')}</body></html>`;
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    await new Promise((r) => setTimeout(r, 120));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(out, image.toPNG());
    win.destroy();
    console.log("wrote", out);
  }
  app.quit();
});

app.on("window-all-closed", (e) => e.preventDefault());
