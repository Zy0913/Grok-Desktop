import fs from "node:fs";
import net from "node:net";
import { desktopInstanceLockPath, ensureDesktopDirs } from "./paths.js";
import { writeHandoff } from "./shell-state.js";

export interface SingleInstanceHandle {
  isPrimary: boolean;
  /** Local port written into the lock file when primary. */
  port?: number;
  release(): void;
  /** If secondary, send a payload to the primary (best-effort). */
  notifyPrimary(payload: string): Promise<boolean>;
}

export interface AcquireSingleInstanceOptions {
  home?: string;
  /** app = 安装包；dev = electron . / npm start */
  instance?: "app" | "dev";
  /** Invoked on primary when secondary sends TCP payload. */
  onSecondaryPayload?: (payload: string) => void;
}

interface LockFile {
  pid: number;
  port: number;
  startedAt: string;
}

function readLock(lockPath: string): LockFile | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return JSON.parse(raw) as LockFile;
  } catch {
    return null;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 500);
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a single-instance lock under ~/.grok-desktop/desktop/lock(|-dev).
 * Primary process listens on a local TCP port for secondary handoff.
 * Secondary payloads are written to handoff.json and optional callback.
 */
export async function acquireSingleInstance(
  homeOrOpts?: string | AcquireSingleInstanceOptions,
  maybeOpts?: AcquireSingleInstanceOptions,
): Promise<SingleInstanceHandle> {
  // Support acquireSingleInstance(home) and acquireSingleInstance({ home, onSecondaryPayload })
  const opts: AcquireSingleInstanceOptions =
    typeof homeOrOpts === "string" || homeOrOpts === undefined
      ? { home: homeOrOpts, ...maybeOpts }
      : homeOrOpts;
  const home = opts.home;
  const instance = opts.instance ?? "app";

  ensureDesktopDirs(home);
  const lockPath = desktopInstanceLockPath(home, instance);

  const existing = readLock(lockPath);
  // Live primary = lock port 可连且 pid 仍存活（避免僵尸锁误判为 secondary 秒退）
  if (
    existing &&
    pidAlive(existing.pid) &&
    (await portOpen(existing.port))
  ) {
    return {
      isPrimary: false,
      port: existing.port,
      release() {},
      async notifyPrimary(payload: string) {
        // Also write FS handoff so primary can pick up even if TCP race
        try {
          writeHandoff(payload, home);
        } catch {
          /* ignore */
        }
        return await new Promise((resolve) => {
          const sock = net.connect(
            { host: "127.0.0.1", port: existing.port },
            () => {
              sock.write(payload, () => {
                sock.end();
                resolve(true);
              });
            },
          );
          sock.on("error", () => resolve(false));
          setTimeout(() => {
            sock.destroy();
            resolve(false);
          }, 2000);
        });
      },
    };
  }

  // Stale lock (or dead port)
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }

  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (buf) => {
      chunks.push(Buffer.from(buf));
    });
    socket.on("end", () => {
      const payload = Buffer.concat(chunks).toString("utf8").trim();
      if (!payload) return;
      try {
        writeHandoff(payload, home);
      } catch {
        /* ignore */
      }
      try {
        opts.onSecondaryPayload?.(payload);
      } catch {
        /* ignore */
      }
    });
    // Don't end immediately — wait for client data then client end
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("failed to bind single-instance port"));
    });
    server.on("error", reject);
  });

  const lock: LockFile = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      const cur = readLock(lockPath);
      if (cur?.pid === process.pid) fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  };

  process.once("exit", release);

  return {
    isPrimary: true,
    port,
    release,
    async notifyPrimary() {
      return false;
    },
  };
}
