/**
 * 可选：把本机/指定路径的 grok 同步到项目 agent-bin/（仅二进制，无用户数据）。
 *
 *   npm run sync:agent
 *   npm run sync:agent -- --from D:\path\to\grok.exe
 *   set GROK_AGENT_SOURCE=... && npm run sync:agent
 *
 * 同步后写入 agent-bin/VERSION.txt（version / source / synced_at / sha256）。
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const binName = isWin ? "grok.exe" : "grok";
const destDir = path.join(appRoot, "agent-bin");
const dest = path.join(destDir, binName);
const versionPath = path.join(destDir, "VERSION.txt");

function parseFromArg(argv) {
  const i = argv.indexOf("--from");
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return null;
}

function candidates() {
  const out = [];
  const env = process.env.GROK_AGENT_SOURCE?.trim();
  if (env) out.push(path.resolve(env));
  const fromArg = parseFromArg(process.argv.slice(2));
  if (fromArg) out.push(fromArg);
  out.push(path.join(os.homedir(), ".grok", "bin", binName));
  out.push(path.join(os.homedir(), ".grok-desktop", "bin", binName));
  return out;
}

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* continue */
    }
  }
  return null;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readBinaryVersion(binaryPath) {
  try {
    const r = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    const line = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

function writeVersionFile({ source, version, sha256 }) {
  const lines = [
    `version=${version ?? ""}`,
    `source=${source}`,
    `synced_at=${new Date().toISOString()}`,
    `sha256=${sha256}`,
    `binary=${binName}`,
    "",
  ];
  fs.writeFileSync(versionPath, lines.join("\n"), "utf8");
}

const src = firstExisting(candidates());
if (!src) {
  console.error(`[sync-agent-bin] 未找到 grok 二进制。
请任选：
  1) 安装 CLI 到 ~/.grok/bin/${binName}
  2) npm run sync:agent -- --from <绝对路径>
  3) 设置 GROK_AGENT_SOURCE`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
console.log(`[sync-agent-bin] 复制\n  从: ${src}\n  到: ${dest}`);
fs.copyFileSync(src, dest);
if (!isWin) {
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* ignore */
  }
}

const st = fs.statSync(dest);
const sha256 = sha256File(dest);
const version = readBinaryVersion(dest);
writeVersionFile({ source: src, version, sha256 });

console.log(
  `[sync-agent-bin] 完成 size=${(st.size / (1024 * 1024)).toFixed(1)} MB`,
);
console.log(`[sync-agent-bin] version=${version ?? "(unknown)"}`);
console.log(`[sync-agent-bin] sha256=${sha256.slice(0, 16)}…`);
console.log(`[sync-agent-bin] 已写 ${versionPath}`);
console.log(
  `[sync-agent-bin] 之后 npm start / npm run dist:mac / npm run dist:win 将优先使用 agent-bin`,
);
