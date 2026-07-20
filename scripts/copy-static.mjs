import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Renderer static
const srcRenderer = path.join(root, "src", "renderer");
const destRenderer = path.join(root, "dist", "renderer");
fs.mkdirSync(destRenderer, { recursive: true });
for (const f of [
  "index.html",
  "styles.css",
  "styles-glass.css",
  "styles-mac.css",
]) {
  fs.copyFileSync(path.join(srcRenderer, f), path.join(destRenderer, f));
}

// Preload must ship as CommonJS for Electron
const srcPreload = path.join(root, "src", "main", "preload.cjs");
const destMain = path.join(root, "dist", "main");
fs.mkdirSync(destMain, { recursive: true });
fs.copyFileSync(srcPreload, path.join(destMain, "preload.cjs"));

// App icons（窗口 / 托盘 / favicon）
const assetsSrc = path.join(root, "assets");
const destAssets = path.join(root, "dist", "assets");
fs.mkdirSync(destAssets, { recursive: true });
for (const f of ["icon.svg", "icon.png", "icon-32.png"]) {
  const from = path.join(assetsSrc, f);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(destAssets, f));
  }
}
// favicon 给 renderer 用
const favSrc = path.join(assetsSrc, "icon-32.png");
const favDest = path.join(destRenderer, "favicon.png");
if (fs.existsSync(favSrc)) {
  fs.copyFileSync(favSrc, favDest);
}

console.log("copied renderer static assets + preload.cjs + icons");
