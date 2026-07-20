import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureVendorCompatDisabled } from "./compat.js";

/**
 * Desktop 专用 GROK_HOME：`~/.grok-desktop`
 * 与 CLI 默认 `~/.grok` 隔离（auth / sessions / config / skills 等互不覆盖）。
 *
 * @param home OS 用户主目录（测试可传入临时目录）
 */
export function grokHomeDir(home = os.homedir()): string {
  return path.join(home, ".grok-desktop");
}

/** CLI 默认 home：`~/.grok`（仅用于定位系统安装的 grok 二进制等，Desktop 不写入） */
export function cliGrokHomeDir(home = os.homedir()): string {
  return path.join(home, ".grok");
}

/** Desktop 应用数据：`~/.grok-desktop/desktop`（projects / settings / logs） */
export function desktopDir(home = os.homedir()): string {
  return path.join(grokHomeDir(home), "desktop");
}

export function desktopLockPath(home = os.homedir()): string {
  return path.join(desktopDir(home), "lock");
}

/**
 * 单实例锁文件名。
 * 开发（electron .）与安装包共用同一 GROK_HOME，但锁分离，
 * 避免「打包版已开 → npm start 亮一下就退」被误当成崩溃。
 */
export function desktopInstanceLockPath(
  home = os.homedir(),
  instance: "app" | "dev" = "app",
): string {
  return path.join(desktopDir(home), instance === "dev" ? "lock-dev" : "lock");
}

export function desktopLogsDir(home = os.homedir()): string {
  return path.join(desktopDir(home), "logs");
}

export function sessionsRoot(home = os.homedir()): string {
  return path.join(grokHomeDir(home), "sessions");
}

/**
 * 一次性迁移：旧版把 UI 数据放在 `~/.grok/desktop`。
 * 若新 profile 尚无 projects/settings，则复制旧目录。
 */
export function migrateLegacyDesktopData(home = os.homedir()): void {
  const legacy = path.join(cliGrokHomeDir(home), "desktop");
  const next = desktopDir(home);
  if (!fs.existsSync(legacy)) return;
  const hasNew =
    fs.existsSync(path.join(next, "projects.json")) ||
    fs.existsSync(path.join(next, "settings.json"));
  if (hasNew) return;
  try {
    fs.mkdirSync(path.dirname(next), { recursive: true });
    fs.cpSync(legacy, next, { recursive: true, force: false, errorOnExist: false });
  } catch {
    /* 迁移失败不阻塞启动 */
  }
}

export function ensureDesktopDirs(home = os.homedir()): void {
  migrateLegacyDesktopData(home);
  fs.mkdirSync(grokHomeDir(home), { recursive: true });
  fs.mkdirSync(desktopLogsDir(home), { recursive: true });
  fs.mkdirSync(desktopDir(home), { recursive: true });
  try {
    ensureVendorCompatDisabled(home);
  } catch {
    /* 不阻塞启动 */
  }
}

/**
 * Encode an absolute cwd the way Grok session layout often does
 * (percent-encoded path as directory name).
 */
export function encodeCwdForSessionDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  // Match common Grok encoding: URL-encode path separators as %5C / %2F style
  return encodeURIComponent(resolved).replace(/%/g, "%");
}

/**
 * Search Desktop GROK_HOME sessions for a directory containing sessionId.
 * Session layout is typically sessions/<encoded-cwd>/<session-id>/.
 */
export function findSessionDir(
  sessionId: string,
  home = os.homedir(),
): string | null {
  const root = sessionsRoot(home);
  if (!fs.existsSync(root)) return null;

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === sessionId) {
        return full;
      }
      // Limit depth to avoid walking forever
      const rel = path.relative(root, full);
      if (rel.split(path.sep).length < 6) {
        stack.push(full);
      }
    }
  }
  return null;
}
