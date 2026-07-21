/**
 * Cursor-style localhost / port chips above the composer.
 * Click 1 → preview in Browser pane; click 2 → jump to Terminal.
 */
import type { NormalizedEvent } from "../shared/events.js";
import { tr } from "../shared/i18n/index.js";
import { sfIcon } from "./sf-icons.js";

export type PortService = {
  key: string;
  port: number;
  host: string;
  url: string;
  terminalId: string;
  title: string;
  /** idle | preview — 第二次点击进 Terminal */
  phase: "idle" | "preview";
};

export type PortChipsDeps = {
  openPreview: (svc: PortService) => void;
  openTerminal: (svc: PortService) => void;
  openExternal: (url: string) => void;
};

const MAX_CHIPS = 4;

/** 仅允许本机预览 URL，防止侧栏变成任意网页浏览器 */
export function normalizeLocalPreviewUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  let href = t;
  if (!/^https?:\/\//i.test(href)) {
    href = `http://${href}`;
  }
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return null;
  }
  if (host === "localhost" || host === "::1") {
    u.hostname = "127.0.0.1";
  }
  return u.toString();
}

/** 排除把 127.0.0.1 的「127」误当成端口 */
export function isPlausibleListenPort(port: number): boolean {
  if (!Number.isFinite(port) || port < 1 || port > 65535) return false;
  // 常见 http(s)；其余要求 ≥1024，避免 IP 段 / 误匹配
  if (port === 80 || port === 443) return true;
  return port >= 1024;
}

/** 从命令行 / 终端输出里抠本地端口 */
export function extractLocalServices(
  text: string,
  terminalId: string,
  titleHint = "",
): PortService[] {
  const out = new Map<string, PortService>();
  const add = (host: string, port: number, label?: string) => {
    if (!isPlausibleListenPort(port)) return;
    const h =
      host === "0.0.0.0" || host === "[::]" || host === "::" || host === "localhost"
        ? "127.0.0.1"
        : host;
    const url = `http://${h}:${port}/`;
    const key = `${terminalId}:${port}`;
    if (out.has(key)) return;
    out.set(key, {
      key,
      port,
      host: h,
      url,
      terminalId,
      title: label || titleHint || `localhost:${port}`,
      phase: "idle",
    });
  };

  const raw = text.replace(/\s+/g, " ");

  // 必须带显式 :port，避免 http://127.0.0.1 落到 :80
  for (const m of raw.matchAll(
    /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/gi,
  )) {
    const host = m[1]!.replace(/^\[|\]$/g, "");
    add(host === "::1" ? "127.0.0.1" : host, Number(m[2]));
  }

  // 「port 8765」——不要用裸数字，否则会吃到 127.0.0.1 的 127
  for (const m of raw.matchAll(
    /\b(?:Serving HTTP on|running (?:at|on)|listening (?:at|on))[^\n]{0,80}?\bport\s+(\d{2,5})\b/gi,
  )) {
    add("127.0.0.1", Number(m[1]));
  }

  for (const m of raw.matchAll(
    /(?:python3?|uv)\s+-m\s+http\.server\s+(\d{2,5})\b/gi,
  )) {
    add("127.0.0.1", Number(m[1]), "http.server");
  }

  for (const m of raw.matchAll(
    /(?:--port|--listen-port|-p)(?:=|\s+)(\d{2,5})\b/gi,
  )) {
    add("127.0.0.1", Number(m[1]));
  }

  // vite / next 常见默认（仅当尚未识别到端口）
  if (/\bvite\b/i.test(raw) && !out.size) add("127.0.0.1", 5173, "vite");
  if (/\bnext\s+dev\b/i.test(raw) && !out.size) add("127.0.0.1", 3000, "next");

  return [...out.values()];
}

export class PortChipsController {
  private services = new Map<string, PortService>();
  private bars: HTMLElement[] = [];
  private deps: PortChipsDeps;
  private menuEl: HTMLElement | null = null;

  constructor(deps: PortChipsDeps) {
    this.deps = deps;
  }

  mount(barIds: string[]): void {
    this.bars = barIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    document.addEventListener("click", (e) => {
      if (!this.menuEl) return;
      const t = e.target as Node;
      if (this.menuEl.contains(t)) return;
      if ((e.target as HTMLElement | null)?.closest?.(".port-chip")) return;
      this.hideMenu();
    });
  }

  onTerminalEvent(ev: NormalizedEvent): void {
    if (ev.type === "terminal.opened") {
      if (ev.kind !== "acp") return;
      const found = extractLocalServices(
        `${ev.command ?? ""} ${ev.title ?? ""}`,
        ev.terminalId,
        ev.title,
      );
      for (const s of found) this.upsert(s);
      return;
    }
    if (ev.type === "terminal.output") {
      const found = extractLocalServices(ev.data, ev.terminalId);
      for (const s of found) this.upsert(s);
      return;
    }
    if (ev.type === "terminal.exit" || ev.type === "terminal.closed") {
      this.removeByTerminal(ev.terminalId);
    }
  }

  private upsert(svc: PortService): void {
    const prev = this.services.get(svc.key);
    if (prev) {
      prev.url = svc.url;
      prev.host = svc.host;
      prev.title = svc.title || prev.title;
      this.render();
      return;
    }
    this.services.set(svc.key, svc);
    // 限制数量：保留最新
    if (this.services.size > MAX_CHIPS) {
      const first = this.services.keys().next().value;
      if (first) this.services.delete(first);
    }
    this.render();
  }

  private removeByTerminal(terminalId: string): void {
    let changed = false;
    for (const [k, s] of this.services) {
      if (s.terminalId === terminalId) {
        this.services.delete(k);
        changed = true;
      }
    }
    if (changed) {
      this.hideMenu();
      this.render();
    }
  }

  private list(): PortService[] {
    return [...this.services.values()];
  }

  private render(): void {
    const items = this.list();
    for (const bar of this.bars) {
      if (!items.length) {
        bar.classList.add("hidden");
        bar.innerHTML = "";
        continue;
      }
      bar.classList.remove("hidden");
      bar.innerHTML = items
        .map((s) => {
          const label = `localhost:${s.port}`;
          const hint =
            s.phase === "preview"
              ? tr("port.chipHintTerminal")
              : tr("port.chipHintPreview");
          return `<button type="button" class="port-chip${s.phase === "preview" ? " is-preview" : ""}" data-port-key="${escAttr(s.key)}" title="${escAttr(hint)}">
            <span class="port-chip-ico">${sfIcon("globe", { size: 12, className: "sf-ico sf-ico--sm" })}</span>
            <span class="port-chip-label">${esc(label)}</span>
            <span class="port-chip-chev" data-port-menu="${escAttr(s.key)}" title="${escAttr(tr("port.chipMenu"))}">▾</span>
          </button>`;
        })
        .join("");

      bar.querySelectorAll<HTMLElement>(".port-chip").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const key = btn.dataset.portKey;
          if (!key) return;
          if ((e.target as HTMLElement).closest("[data-port-menu]")) {
            e.stopPropagation();
            this.toggleMenu(key, btn);
            return;
          }
          this.onChipClick(key);
        });
      });
    }
  }

  private onChipClick(key: string): void {
    const svc = this.services.get(key);
    if (!svc) return;
    this.hideMenu();
    if (svc.phase === "idle") {
      svc.phase = "preview";
      this.deps.openPreview(svc);
      this.render();
      return;
    }
    // 第二次：跳到对应 Terminal
    svc.phase = "idle";
    this.deps.openTerminal(svc);
    this.render();
  }

  private toggleMenu(key: string, anchor: HTMLElement): void {
    if (this.menuEl?.dataset.portKey === key) {
      this.hideMenu();
      return;
    }
    const svc = this.services.get(key);
    if (!svc) return;
    this.hideMenu();
    const menu = document.createElement("div");
    menu.className = "port-chip-menu float-menu";
    menu.dataset.portKey = key;
    menu.innerHTML = `
      <button type="button" class="port-chip-menu-item" data-act="preview">${esc(tr("port.menuPreview"))}</button>
      <button type="button" class="port-chip-menu-item" data-act="terminal">${esc(tr("port.menuTerminal"))}</button>
      <button type="button" class="port-chip-menu-item" data-act="external">${esc(tr("port.menuExternal"))}</button>
      <button type="button" class="port-chip-menu-item danger" data-act="dismiss">${esc(tr("port.menuDismiss"))}</button>
    `;
    document.body.appendChild(menu);
    this.menuEl = menu;
    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight || 140;
    const above = r.top >= mh + 12;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 180))}px`;
    menu.style.top = above
      ? `${r.top - mh - 6}px`
      : `${r.bottom + 6}px`;
    menu.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => {
        const act = (el as HTMLElement).dataset.act;
        this.hideMenu();
        if (act === "preview") {
          svc.phase = "preview";
          this.deps.openPreview(svc);
          this.render();
        } else if (act === "terminal") {
          svc.phase = "idle";
          this.deps.openTerminal(svc);
          this.render();
        } else if (act === "external") {
          this.deps.openExternal(svc.url);
        } else if (act === "dismiss") {
          this.services.delete(key);
          this.render();
        }
      });
    });
  }

  private hideMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return esc(s).replace(/'/g, "&#39;");
}
