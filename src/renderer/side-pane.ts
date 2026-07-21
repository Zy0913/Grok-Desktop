/**
 * Codex 式右侧可展开侧栏：文件树 + 预览（MD 富文本 / 代码）+ 拖拽改宽
 */
import hljs from "highlight.js/lib/core";
import type { HostIpcMethod } from "../shared/host-api.js";
import { t as tr } from "../shared/i18n/index.js";
import { renderMarkdownToSafeHtml } from "./markdown.js";
import { linkifyFilePaths } from "./file-links.js";
import { hydrateSfIcons, sfIcon } from "./sf-icons.js";
import { TerminalPaneController } from "./terminal-pane.js";
import { ChangesPaneController } from "./changes-pane.js";
import {
  normalizeLocalPreviewUrl,
  type PortService,
} from "./port-chips.js";
import type { NormalizedEvent } from "../shared/events.js";

type HostRes<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

type Inv = <T>(method: HostIpcMethod, params?: unknown) => Promise<HostRes<T>>;

export type FileTab = {
  id: string;
  /** 展示用路径 */
  path: string;
  absPath: string;
  content: string;
  language: string;
  line?: number;
  dirty: boolean;
  truncated: boolean;
  binary: boolean;
  isDirectory: boolean;
  /** 编辑缓冲 */
  draft: string;
};

const LS_OPEN = "grok.desktop.sidePaneOpen";
const LS_WIDTH = "grok.desktop.sidePaneWidth";
const LS_CAT = "grok.desktop.sidePaneCat";
const LS_BROWSER_FAVS = "grok.desktop.browserFavorites";

type BrowserFavorite = { url: string; title: string; addedAt: number };

export type SideCategory = "home" | "files" | "browser" | "terminal" | "plan" | "agents" | "changes";

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function mapUiSubagentStatus(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "completed" || s === "complete" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "inactive";
  if (s === "blocked") return "blocked";
  if (s === "working" || s === "running" || s === "active" || s === "spawned")
    return "working";
  if (s === "idle") return "idle";
  return s || "unknown";
}

function statusLabelForAgents(st: string): string {
  const key = (`side.agentsStatus.` + st) as "side.agents";
  const translated = tr(key);
  if (translated && translated !== key) return translated;
  return st;
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function breadcrumbHtml(absPath: string, cwd?: string | null): string {
  let rel = absPath;
  if (cwd) {
    const nC = cwd.replace(/\\/g, "/").replace(/\/$/, "");
    const nA = absPath.replace(/\\/g, "/");
    if (nA.toLowerCase().startsWith(nC.toLowerCase() + "/")) {
      rel = nA.slice(nC.length + 1);
    } else if (nA.toLowerCase() === nC.toLowerCase()) {
      rel = baseName(nA);
    }
  }
  const segs = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segs.length) return esc(baseName(absPath));
  return segs
    .map((s, i) => {
      const isLast = i === segs.length - 1;
      return isLast
        ? `<span class="bc-cur">${esc(s)}</span>`
        : `<span>${esc(s)}</span><span class="bc-sep">›</span>`;
    })
    .join("");
}

/** 与 shared SubagentNode 对齐的轻量树节点 */
export type AgentsTreeNode = {
  id: string;
  type: string;
  status: string;
  summary?: string;
  childSessionId?: string;
  updatedAt?: string;
  children?: AgentsTreeNode[];
};

type TreeEntry = {
  name: string;
  path: string;
  absPath: string;
  isDirectory: boolean;
  ext: string;
};

export class SidePaneController {
  private open = false;
  private width = 680;
  private category: SideCategory = "home";
  private tabs: FileTab[] = [];
  private activeId: string | null = null;
  private inv: Inv;
  private getCwd: () => string | null;
  private resizing = false;
  /** 已展开目录 path → children */
  private treeCache = new Map<string, TreeEntry[]>();
  private expandedDirs = new Set<string>(["."]);
  private treeFilter = "";
  private treeLoadedRoot: string | null = null;
  /** 防抖刷新定时器（fs.watch / 工具写完） */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;
  /** 当前已请求 watch 的 cwd */
  private watchingCwd: string | null = null;
  /** 当前会话 subagent 树（侧栏 agents 分类） */
  private agentsTree: AgentsTreeNode[] = [];
  private agentsSessionId: string | null = null;
  private getSessionId: () => string | null = () => null;
  /** 文件树列是否展开（默认展开，对齐 Codex 可收起） */
  private treeVisible = true;
  /** 全屏展开侧栏（聊天区隐藏，底部悬浮输入） */
  private focusMode = false;
  private onFocusModeChange?: (focus: boolean) => void;
  private terminalPane: TerminalPaneController | null = null;
  /** Browser 预览关联的 ACP 终端（从 localhost 气泡进来） */
  private browserPreviewTerminalId: string | null = null;
  private browserLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private browserLoadToken = 0;
  private changesPane: ChangesPaneController | null = null;
  constructor(opts: {
    inv: Inv;
    getCwd: () => string | null;
    getSessionId?: () => string | null;
    onFocusModeChange?: (focus: boolean) => void;
  }) {
    this.inv = opts.inv;
    this.getCwd = opts.getCwd;
    this.getSessionId = opts.getSessionId ?? (() => null);
    this.onFocusModeChange = opts.onFocusModeChange;
    this.restorePrefs();
    this.bindChrome();
    this.applyOpenState(false);
    this.applyCategory();
    this.applyTreeVisible();
    this.applyFocusMode();
    this.mountTerminalPane();
    this.mountChangesPane();
    this.bindBrowserPreviewChrome();
    this.renderBrowserFavorites();
    this.syncSideTopLead();
    hydrateSfIcons(document.getElementById("side-pane") ?? document);
    if (this.open) this.applyOpenState(true);
    // 恢复偏好若已在终端分类：自动开 shell（对齐 Cursor）
    if (this.category === "terminal" && this.open) {
      this.terminalPane?.ensureDefaultTerminal();
    }
    if (this.category === "changes" && this.open) {
      void this.changesPane?.refresh();
    }
  }

  private mountTerminalPane(): void {
    const body = document.getElementById("side-terminal-body");
    if (!body) return;
    this.terminalPane = new TerminalPaneController({
      inv: (method, params) => this.inv(method as HostIpcMethod, params),
      getCwd: () => this.getCwd(),
      focusTerminalCategory: () => this.setCategory("terminal", true),
      isTerminalCategoryActive: () => this.open && this.category === "terminal",
      onAcpTerminalBackground: () => {
        document.getElementById("btn-home-terminal")?.classList.add("has-activity");
      },
      onFocus: () => this.toggleFocusMode(),
      onClose: () => {
        this.setFocusMode(false);
        this.setOpen(false);
      },
      onBackHome: () => this.setCategory("home", true),
      onPlusClick: (anchor) => this.toggleSidePlusMenu(anchor),
    });
    this.terminalPane.mount(body);
  }

  private mountChangesPane(): void {
    const body = document.getElementById("side-changes-body");
    if (!body) return;
    this.changesPane = new ChangesPaneController({
      inv: (method, params) => this.inv(method as HostIpcMethod, params),
      getCwd: () => this.getCwd(),
      openFile: (relPath, line) => {
        void this.openFile(relPath, line);
      },
    });
    this.changesPane.mount(body);
    this.changesPane.setOnBack(() => this.setCategory("home", true));
  }

  /** Forward host terminal.* events */
  onTerminalEvent(ev: NormalizedEvent): void {
    this.terminalPane?.onHostEvent(ev);
  }

  /** Cursor：localhost 气泡 → 侧栏预览 */
  openBrowserPreview(svc: PortService): void {
    this.browserPreviewTerminalId = svc.terminalId;
    this.setCategory("browser", true);
    document.getElementById("browser-placeholder")?.classList.add("hidden");
    document.getElementById("browser-preview")?.classList.remove("hidden");
    document.getElementById("btn-browser-to-term")?.classList.remove("hidden");
    document.getElementById("btn-browser-external")?.classList.remove("hidden");
    document.getElementById("btn-browser-reload")?.classList.remove("hidden");
    this.navigateBrowserPreview(svc.url);
    this.syncSideTopLead();
  }

  /** Cursor：气泡第二次点击 / 菜单 → 对应 Terminal */
  openTerminalForService(svc: PortService): void {
    this.setCategory("terminal", true);
    const ok = this.terminalPane?.activateIfPresent(svc.terminalId);
    if (!ok) this.terminalPane?.ensureDefaultTerminal();
  }

  private bindBrowserPreviewChrome(): void {
    document.getElementById("btn-browser-reload")?.addEventListener("click", () => {
      const url = this.currentBrowserPreviewUrl();
      if (url) this.navigateBrowserPreview(url);
    });
    const openExternal = () => {
      const url = this.currentBrowserPreviewUrl();
      if (url) void this.inv("system.openExternal", { url });
    };
    document
      .getElementById("btn-browser-external")
      ?.addEventListener("click", openExternal);
    document
      .getElementById("btn-browser-fallback-external")
      ?.addEventListener("click", openExternal);
    document.getElementById("btn-browser-to-term")?.addEventListener("click", () => {
      const id = this.browserPreviewTerminalId;
      if (!id) {
        this.setCategory("terminal", true);
        return;
      }
      this.setCategory("terminal", true);
      this.terminalPane?.activateIfPresent(id);
    });
    document.getElementById("btn-browser-star")?.addEventListener("click", () => {
      const url = this.currentBrowserPreviewUrl();
      if (!url) return;
      this.toggleBrowserFavorite(url);
    });
    document.getElementById("btn-browser-favs")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleBrowserFavsMenu(
        e.currentTarget as HTMLElement,
      );
    });
    const urlInput = document.getElementById(
      "browser-preview-url",
    ) as HTMLInputElement | null;
    urlInput?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const raw = urlInput.value.trim();
      const normalized = normalizeLocalPreviewUrl(raw);
      if (!normalized) {
        this.showBrowserFallback(true);
        return;
      }
      this.navigateBrowserPreview(normalized);
    });
    urlInput?.addEventListener("input", () => {
      this.syncBrowserStar(normalizeLocalPreviewUrl(urlInput.value));
    });
  }

  private loadBrowserFavorites(): BrowserFavorite[] {
    try {
      const raw = localStorage.getItem(LS_BROWSER_FAVS);
      if (!raw) return [];
      const arr = JSON.parse(raw) as BrowserFavorite[];
      if (!Array.isArray(arr)) return [];
      return arr.filter((x) => x && typeof x.url === "string");
    } catch {
      return [];
    }
  }

  private saveBrowserFavorites(list: BrowserFavorite[]): void {
    localStorage.setItem(LS_BROWSER_FAVS, JSON.stringify(list.slice(0, 40)));
  }

  private isBrowserFavorite(url: string): boolean {
    const n = normalizeLocalPreviewUrl(url);
    if (!n) return false;
    return this.loadBrowserFavorites().some((f) => f.url === n);
  }

  private toggleBrowserFavorite(url: string): void {
    const n = normalizeLocalPreviewUrl(url);
    if (!n) return;
    const list = this.loadBrowserFavorites();
    const idx = list.findIndex((f) => f.url === n);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      let title = n;
      try {
        title = `localhost:${new URL(n).port || "80"}`;
      } catch {
        /* keep */
      }
      list.unshift({ url: n, title, addedAt: Date.now() });
    }
    this.saveBrowserFavorites(list);
    this.syncBrowserStar(n);
    this.renderBrowserFavorites();
  }

  private syncBrowserStar(url: string | null): void {
    const btn = document.getElementById("btn-browser-star");
    if (!btn) return;
    const on = Boolean(url && this.isBrowserFavorite(url));
    btn.classList.toggle("is-on", on);
    btn.title = on ? tr("port.unfavorite") : tr("port.favorite");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.innerHTML = sfIcon(on ? "starFill" : "star", {
      size: 14,
      className: "sf-ico sf-ico--tool",
    });
  }

  private renderBrowserFavorites(): void {
    const block = document.getElementById("browser-favorites-block");
    const listEl = document.getElementById("browser-favorites-list");
    if (!block || !listEl) return;
    const favs = this.loadBrowserFavorites();
    if (!favs.length) {
      block.classList.add("hidden");
      listEl.innerHTML = "";
      return;
    }
    block.classList.remove("hidden");
    listEl.innerHTML = favs
      .map(
        (f) =>
          `<li>
            <button type="button" class="browser-fav-item" data-fav-url="${esc(f.url)}" title="${esc(f.url)}">
              <span class="browser-fav-ico">${sfIcon("globe", { size: 13, className: "sf-ico sf-ico--sm" })}</span>
              <span class="browser-fav-label">${esc(f.title || f.url)}</span>
              <span class="browser-fav-rm" data-fav-rm="${esc(f.url)}" title="${esc(tr("port.unfavorite"))}">${sfIcon("xmark", { size: 11, className: "sf-ico sf-ico--sm" })}</span>
            </button>
          </li>`,
      )
      .join("");
    listEl.querySelectorAll<HTMLElement>("[data-fav-url]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const rm = (e.target as HTMLElement).closest("[data-fav-rm]") as
          | HTMLElement
          | null;
        if (rm) {
          e.stopPropagation();
          const u = rm.dataset.favRm;
          if (u) this.toggleBrowserFavorite(u);
          return;
        }
        const u = btn.dataset.favUrl;
        if (!u) return;
        this.openBrowserPreview({
          key: `fav:${u}`,
          port: Number(new URL(u).port || 80),
          host: "127.0.0.1",
          url: u,
          terminalId: this.browserPreviewTerminalId || "",
          title: u,
          phase: "idle",
        });
      });
    });
  }

  private favsMenuEl: HTMLElement | null = null;

  private toggleBrowserFavsMenu(anchor: HTMLElement): void {
    if (this.favsMenuEl) {
      this.hideBrowserFavsMenu();
      return;
    }
    const favs = this.loadBrowserFavorites();
    const menu = document.createElement("div");
    menu.className = "browser-favs-menu float-menu";
    if (!favs.length) {
      menu.innerHTML = `<div class="browser-favs-empty">${esc(tr("port.favoritesEmpty"))}</div>`;
    } else {
      menu.innerHTML = favs
        .map(
          (f) =>
            `<button type="button" class="browser-favs-menu-item" data-url="${esc(f.url)}">
              <span>${sfIcon("globe", { size: 13, className: "sf-ico sf-ico--sm" })}</span>
              <span>${esc(f.title || f.url)}</span>
            </button>`,
        )
        .join("");
    }
    document.body.appendChild(menu);
    this.favsMenuEl = menu;
    anchor.setAttribute("aria-expanded", "true");
    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight || 120;
    menu.style.left = `${Math.max(8, Math.min(r.right - 200, window.innerWidth - 212))}px`;
    menu.style.top =
      r.bottom + mh + 8 > window.innerHeight
        ? `${Math.max(8, r.top - mh - 6)}px`
        : `${r.bottom + 6}px`;
    menu.querySelectorAll<HTMLElement>("[data-url]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = btn.dataset.url;
        this.hideBrowserFavsMenu();
        if (!u) return;
        this.openBrowserPreview({
          key: `fav:${u}`,
          port: Number(new URL(u).port || 80),
          host: "127.0.0.1",
          url: u,
          terminalId: this.browserPreviewTerminalId || "",
          title: u,
          phase: "idle",
        });
      });
    });
    const onDoc = (ev: MouseEvent) => {
      if (menu.contains(ev.target as Node) || anchor.contains(ev.target as Node))
        return;
      this.hideBrowserFavsMenu();
      document.removeEventListener("click", onDoc, true);
    };
    setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  }

  private hideBrowserFavsMenu(): void {
    this.favsMenuEl?.remove();
    this.favsMenuEl = null;
    document
      .getElementById("btn-browser-favs")
      ?.setAttribute("aria-expanded", "false");
  }

  private currentBrowserPreviewUrl(): string | null {
    const urlInput = document.getElementById(
      "browser-preview-url",
    ) as HTMLInputElement | null;
    const fromInput = urlInput?.value?.trim();
    if (fromInput) {
      const n = normalizeLocalPreviewUrl(fromInput);
      if (n) return n;
    }
    const frame = document.getElementById(
      "browser-preview-frame",
    ) as HTMLIFrameElement | null;
    const src = frame?.src?.trim();
    if (src && src !== "about:blank") return src;
    return null;
  }

  private navigateBrowserPreview(url: string): void {
    const normalized = normalizeLocalPreviewUrl(url);
    const urlInput = document.getElementById(
      "browser-preview-url",
    ) as HTMLInputElement | null;
    const frame = document.getElementById(
      "browser-preview-frame",
    ) as HTMLIFrameElement | null;
    const fallback = document.getElementById("browser-preview-fallback");
    if (!normalized) {
      if (urlInput) urlInput.value = url;
      this.showBrowserFallback(true);
      return;
    }
    if (urlInput) urlInput.value = normalized;
    this.syncBrowserStar(normalized);
    fallback?.classList.add("hidden");
    frame?.classList.remove("hidden");
    if (!frame) return;

    if (this.browserLoadTimer) {
      clearTimeout(this.browserLoadTimer);
      this.browserLoadTimer = null;
    }
    const token = ++this.browserLoadToken;
    let settled = false;
    const onLoad = () => {
      if (token !== this.browserLoadToken) return;
      settled = true;
      if (this.browserLoadTimer) {
        clearTimeout(this.browserLoadTimer);
        this.browserLoadTimer = null;
      }
      // about:blank 的 load 不算成功
      if (!frame.src || frame.src === "about:blank") return;
      this.showBrowserFallback(false);
    };
    frame.addEventListener("load", onLoad, { once: true });
    frame.src = "about:blank";
    requestAnimationFrame(() => {
      if (token !== this.browserLoadToken) return;
      frame.src = normalized;
      // 超时仍无有效 load → 提示外开（XFO / 服务未起）
      this.browserLoadTimer = setTimeout(() => {
        if (token !== this.browserLoadToken || settled) return;
        // 同源页面通常会触发 load；若被拦或挂起，露出兜底
        try {
          // 跨域读 contentDocument 会抛；能读到且有 body 则视为成功
          const doc = frame.contentDocument;
          if (doc?.body && (doc.body.childElementCount > 0 || doc.body.textContent)) {
            this.showBrowserFallback(false);
            return;
          }
        } catch {
          // 跨域但已导航成功：也算预览可用
          if (frame.src && frame.src !== "about:blank") {
            this.showBrowserFallback(false);
            return;
          }
        }
        this.showBrowserFallback(true);
      }, 3500);
    });
  }

  private showBrowserFallback(show: boolean): void {
    const fallback = document.getElementById("browser-preview-fallback");
    const frame = document.getElementById("browser-preview-frame");
    if (show) {
      fallback?.classList.remove("hidden");
      // 保留 iframe，但用遮罩提示
    } else {
      fallback?.classList.add("hidden");
      frame?.classList.remove("hidden");
    }
  }

  /** Cursor：侧栏 + 二级菜单（home / 终端顶栏共用） */
  toggleSidePlusMenu(anchor: HTMLElement): void {
    const menu = document.getElementById("side-plus-menu");
    if (!menu) return;
    const open =
      !menu.classList.contains("hidden") && menu.dataset.anchorId === anchor.id;
    if (open) {
      this.hideSidePlusMenu();
      return;
    }
    this.showSidePlusMenu(anchor);
  }

  private showSidePlusMenu(anchor: HTMLElement): void {
    const menu = document.getElementById("side-plus-menu");
    if (!menu) return;
    // 关闭其它浮层避免叠层
    document.querySelectorAll(".float-menu").forEach((m) => {
      if (m !== menu) m.classList.add("hidden");
    });
    menu.dataset.anchorId = anchor.id || "side-plus-anchor";
    this.syncSidePlusKbd();
    hydrateSfIcons(menu);
    const q = document.getElementById("side-plus-q") as HTMLInputElement | null;
    if (q) q.value = "";
    this.filterSidePlusMenu("");
    this.placeSidePlusMenu(menu, anchor);
    this.setSidePlusExpanded(true);
    requestAnimationFrame(() => q?.focus());
  }

  hideSidePlusMenu(): void {
    const menu = document.getElementById("side-plus-menu");
    menu?.classList.add("hidden");
    this.setSidePlusExpanded(false);
  }

  private setSidePlusExpanded(expanded: boolean): void {
    for (const id of ["btn-side-home-plus", "term-pane-new"] as const) {
      document.getElementById(id)?.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
  }

  private syncSidePlusKbd(): void {
    const isMac =
      document.body.classList.contains("platform-darwin") ||
      /Mac|iPhone|iPad/.test(navigator.platform);
    for (const el of Array.from(document.querySelectorAll(".side-plus-kbd"))) {
      const mac = (el as HTMLElement).dataset.mac;
      const other = (el as HTMLElement).dataset.other;
      if (mac && other) (el as HTMLElement).textContent = isMac ? mac : other;
    }
  }

  private placeSidePlusMenu(menu: HTMLElement, anchor: HTMLElement): void {
    const gap = 6;
    const pad = 8;
    menu.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 280;
    const mh = menu.offsetHeight || 220;

    let left = r.left;
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
    if (left < pad) left = pad;

    // 顶栏 +：优先向下展开
    let top = r.bottom + gap;
    if (top + mh > window.innerHeight - pad) {
      top = Math.max(pad, r.top - mh - gap);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private filterSidePlusMenu(query: string): void {
    const q = query.trim().toLowerCase();
    const items = Array.from(
      document.querySelectorAll<HTMLElement>("#side-plus-list [data-side-plus]"),
    );
    let visible = 0;
    for (const item of items) {
      const label =
        item.querySelector(".side-plus-label")?.textContent?.toLowerCase() ?? "";
      const key = (item.dataset.sidePlus || "").toLowerCase();
      const match = !q || label.includes(q) || key.includes(q);
      item.classList.toggle("hidden", !match);
      if (match) visible += 1;
    }
    document.getElementById("side-plus-empty")?.classList.toggle("hidden", visible > 0);
  }

  private runSidePlusAction(act: string): void {
    this.hideSidePlusMenu();
    if (act === "files") this.setCategory("files", true);
    else if (act === "browser") this.setCategory("browser", true);
    else if (act === "agents") this.setCategory("agents", true);
    else if (act === "changes") this.setCategory("changes", true);
    else if (act === "terminal") {
      const alreadyOnTerminal = this.category === "terminal" && this.open;
      this.setCategory("terminal", true);
      // 已在终端：再开一个标签；从 home 切入则由 ensureDefaultTerminal 负责首个 shell
      if (alreadyOnTerminal) void this.terminalPane?.createUserTerminal();
    }
  }

  private bindSidePlusMenu(): void {
    const menu = document.getElementById("side-plus-menu");
    if (!menu || menu.dataset.bound === "1") return;
    menu.dataset.bound = "1";

    const q = document.getElementById("side-plus-q") as HTMLInputElement | null;
    q?.addEventListener("input", () => this.filterSidePlusMenu(q.value));
    q?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideSidePlusMenu();
        return;
      }
      if (e.key === "Enter") {
        const first = menu.querySelector(
          ".side-plus-item:not(.hidden)",
        ) as HTMLElement | null;
        const act = first?.dataset.sidePlus;
        if (act) {
          e.preventDefault();
          this.runSidePlusAction(act);
        }
      }
    });

    menu.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest(
        "[data-side-plus]",
      ) as HTMLElement | null;
      if (!t) return;
      const act = t.dataset.sidePlus;
      if (act) this.runSidePlusAction(act);
    });

    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (
        t.closest(
          "#side-plus-menu, #btn-side-home-plus, #term-pane-new",
        )
      ) {
        return;
      }
      this.hideSidePlusMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hideSidePlusMenu();
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  isFocusMode(): boolean {
    return this.focusMode;
  }

  getCategory(): SideCategory {
    return this.category;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(next: boolean): void {
    this.open = next;
    if (!next) this.focusMode = false;
    if (next) {
      // 顶栏面板按钮打开：落在 Cursor home 四宫格
      this.category = "home";
      this.applyCategory();
    }
    this.applyOpenState(true);
    this.applyFocusMode();
    this.persist();
    void this.syncFileWatch();
  }

  /** 全屏展开 / 退出（对齐 Codex 文件沉浸布局） */
  setFocusMode(next: boolean): void {
    this.focusMode = next;
    if (next) {
      this.open = true;
      this.category = "files";
      this.applyCategory();
      void this.refreshFileTree();
    } else {
      void this.syncFileWatch();
    }
    this.applyOpenState(true);
    this.applyFocusMode();
    this.persist();
    this.onFocusModeChange?.(this.focusMode);
  }

  toggleFocusMode(): void {
    this.setFocusMode(!this.focusMode);
  }

  /** 切换侧栏分类，并确保侧栏展开 */
  setCategory(cat: SideCategory, openPane = true): void {
    this.category = cat;
    if (openPane) this.open = true;
    this.applyCategory();
    this.applyOpenState(true);
    this.persist();
    if (cat === "terminal") {
      this.refreshTerminalCwd();
      document.getElementById("btn-home-terminal")?.classList.remove("has-activity");
      this.terminalPane?.ensureDefaultTerminal();
    }
    if (cat === "browser") {
      this.renderBrowserFavorites();
      hydrateSfIcons(document.getElementById("side-cat-browser") ?? document);
    }
    if (cat === "files") void this.refreshFileTree();
    else void this.syncFileWatch();
    if (cat === "agents") void this.refreshAgentsTree();
    if (cat === "changes") void this.changesPane?.refresh();
  }

  /**
   * 打开并聚焦「计划」分类。
   * 不触发 onPlanCategory（由调用方负责加载内容，避免 openPlanPanel 递归）。
   */
  openPlanCategory(): void {
    this.category = "plan";
    this.open = true;
    this.applyCategory();
    this.applyOpenState(true);
    this.persist();
    void this.syncFileWatch();
  }

  /** 若当前在计划栏：切回文件并收起侧栏（新建/切换会话） */
  closePlanCategory(): void {
    if (this.category !== "plan") return;
    this.category = "files";
    this.open = false;
    this.focusMode = false;
    this.applyCategory();
    this.applyOpenState(true);
    this.applyFocusMode();
    this.persist();
    void this.syncFileWatch();
  }

  /** 打开并聚焦「子代理」分类 */
  openAgentsCategory(): void {
    this.category = "agents";
    this.open = true;
    this.applyCategory();
    this.applyOpenState(true);
    this.persist();
    void this.syncFileWatch();
    void this.refreshAgentsTree();
  }

  /** 会话切换时清空 / 重载树 */
  onSessionChanged(): void {
    const sid = this.getSessionId();
    if (sid !== this.agentsSessionId) {
      this.agentsSessionId = sid;
      this.agentsTree = [];
      this.renderAgentsTree();
    }
    if (this.open && this.category === "agents") {
      void this.refreshAgentsTree();
    } else if (sid) {
      void this.refreshAgentsTree();
    }
  }

  /**
   * 实时事件增量更新本地树。
   * Host 已写盘；此处不强制 IPC refresh，避免频繁往返。
   */
  applySubagentUpdate(ev: {
    sessionId?: string;
    parentSessionId?: string;
    subagentId: string;
    subagentType?: string;
    description?: string;
    status: string;
    phase: string;
    childSessionId?: string;
  }): void {
    const sid = this.getSessionId();
    if (!sid) return;
    const parent = ev.parentSessionId || ev.sessionId;
    if (parent && parent !== sid) return;

    const status = mapUiSubagentStatus(ev.status);
    const summary =
      ev.description ||
      (ev.phase === "progress" ? tr("side.agentsProgress") : undefined);
    const idx = this.agentsTree.findIndex((n) => n.id === ev.subagentId);
    const node: AgentsTreeNode = {
      id: ev.subagentId,
      type: ev.subagentType || "general-purpose",
      status,
      summary: summary || (idx >= 0 ? this.agentsTree[idx].summary : undefined),
      childSessionId:
        ev.childSessionId ??
        (idx >= 0 ? this.agentsTree[idx].childSessionId : undefined),
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      this.agentsTree = this.agentsTree.map((n, i) =>
        i === idx ? { ...n, ...node, summary: node.summary ?? n.summary } : n,
      );
    } else {
      this.agentsTree = [...this.agentsTree, node];
    }
    this.agentsSessionId = sid;
    this.renderAgentsTree();
    if (ev.phase === "spawned") {
      document.getElementById("btn-cat-agents")?.classList.add("has-activity");
    }
  }

  async refreshAgentsTree(): Promise<void> {
    const sid = this.getSessionId();
    this.agentsSessionId = sid;
    if (!sid) {
      this.agentsTree = [];
      this.renderAgentsTree();
      return;
    }
    const res = await this.inv<AgentsTreeNode[]>("subagents.tree", {
      sessionId: sid,
    });
    this.agentsTree = res.ok && Array.isArray(res.data) ? res.data : [];
    this.renderAgentsTree();
  }

  private renderAgentsTree(): void {
    const empty = document.getElementById("side-agents-empty");
    const list = document.getElementById("side-agents-tree");
    if (!empty || !list) return;
    const nodes = this.agentsTree;
    if (!nodes.length) {
      empty.hidden = false;
      empty.classList.remove("hidden");
      list.hidden = true;
      list.innerHTML = "";
      return;
    }
    empty.hidden = true;
    empty.classList.add("hidden");
    list.hidden = false;
    list.innerHTML = nodes.map((n) => this.agentsNodeHtml(n, 0)).join("");
  }

  private agentsNodeHtml(n: AgentsTreeNode, depth: number): string {
    const st = String(n.status || "unknown");
    const shortId = (n.id || "").slice(0, 8);
    const typeLabel = esc(n.type || "subagent");
    const summary = n.summary ? esc(n.summary) : "";
    const statusLabel = esc(statusLabelForAgents(st));
    const kids = (n.children || [])
      .map((c) => this.agentsNodeHtml(c, depth + 1))
      .join("");
    return (
      `<li class="agents-node" data-status="${esc(st)}" style="--depth:${depth}">` +
      `<div class="agents-row">` +
      `<span class="agents-dot" data-status="${esc(st)}" title="${statusLabel}"></span>` +
      `<span class="agents-type">${typeLabel}</span>` +
      `<span class="agents-id mono">${esc(shortId)}</span>` +
      `<span class="agents-status">${statusLabel}</span>` +
      `</div>` +
      (summary ? `<div class="agents-summary">${summary}</div>` : "") +
      (kids ? `<ul class="agents-children">${kids}</ul>` : "") +
      `</li>`
    );
  }


  private restorePrefs(): void {
    try {
      // 启动默认收起右侧栏；仅恢复宽度与分类
      this.open = false;
      const w = Number(localStorage.getItem(LS_WIDTH));
      if (Number.isFinite(w) && w >= 320 && w <= 1200) this.width = w;
      const c = localStorage.getItem(LS_CAT) as SideCategory | null;
      // plan 不持久化为默认；home 为 Cursor 默认入口
      if (
        c === "home" ||
        c === "files" ||
        c === "browser" ||
        c === "terminal" ||
        c === "agents"
      ) {
        this.category = c;
      } else {
        this.category = "home";
      }
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    try {
      // 不再持久化 open：每次启动默认收起
      localStorage.setItem(LS_OPEN, "0");
      localStorage.setItem(LS_WIDTH, String(Math.round(this.width)));
      localStorage.setItem(LS_CAT, this.category);
    } catch {
      /* ignore */
    }
  }

  private applyOpenState(updateBtn: boolean): void {
    const pane = $("side-pane");
    const resizer = $("split-resizer");
    const btn = $("btn-panel");
    pane.classList.toggle("hidden", !this.open);
    // 全屏时不显示拖拽条
    resizer.classList.toggle("hidden", !this.open || this.focusMode);
    this.syncTopChrome();
    if (!this.open) this.hideSidePlusMenu();
    if (this.open && !this.focusMode) {
      pane.style.width = `${this.width}px`;
    } else if (this.focusMode) {
      pane.style.width = "";
    }
    if (updateBtn) {
      btn.classList.toggle("active", this.open);
      btn.setAttribute("aria-pressed", this.open ? "true" : "false");
    }
  }

  /**
   * Cursor：侧栏打开时，顶栏操作迁入右侧面板（左 +，右 打开位置/全屏/收起）；
   * 关闭时迁回聊天列顶栏。
   */
  private syncTopChrome(): void {
    const chatActions = document.getElementById("main-top-right");
    const sideActions = document.getElementById("side-pane-top-actions");
    const plus = document.getElementById("btn-side-home-plus");
    const openLoc = document.getElementById("btn-open-location");
    const focus = document.getElementById("btn-side-focus");
    const layout = document.getElementById("btn-layout");
    const panel = document.getElementById("btn-panel");
    if (!chatActions || !sideActions) return;

    const moveTo = this.open ? sideActions : chatActions;
    for (const el of [openLoc, focus, layout, panel]) {
      if (el && el.parentElement !== moveTo) moveTo.appendChild(el);
    }
    plus?.classList.toggle("hidden", !this.open);
  }

  private applyFocusMode(): void {
    const split = $("main-split");
    const focusBtn = document.getElementById("btn-side-focus");
    const dock = document.getElementById("focus-composer");
    split.classList.toggle("focus-mode", this.focusMode && this.open);
    this.syncTopChrome();
    if (focusBtn) {
      focusBtn.classList.toggle("active", this.focusMode);
      focusBtn.setAttribute("aria-pressed", this.focusMode ? "true" : "false");
      focusBtn.title = this.focusMode ? tr("side.focusExit") : tr("side.focusEnter");
    }
    if (dock) {
      dock.classList.toggle("hidden", !(this.focusMode && this.open));
    }
  }

  private applyCategory(): void {
    for (const cat of [
      "home",
      "files",
      "browser",
      "terminal",
      "plan",
      "agents",
      "changes",
    ] as const) {
      const view = document.getElementById(`side-cat-${cat}`);
      view?.classList.toggle("hidden", cat !== this.category);
      const btn = document.querySelector(
        `.side-cat-btn[data-cat="${cat}"]`,
      ) as HTMLElement | null;
      btn?.classList.toggle("active", cat === this.category);
    }
    this.syncSideTopLead();
  }

  /** 把各视图的返回/标签并入侧栏顶栏左区，避免 Cursor 式双行头 */
  private syncSideTopLead(): void {
    const lead = document.getElementById("side-pane-top-lead");
    if (!lead) return;

    while (lead.firstChild) {
      const el = lead.firstChild as HTMLElement;
      const parentId = el.dataset.returnParent;
      const parent = parentId ? document.getElementById(parentId) : null;
      if (parent) {
        parent.insertBefore(el, parent.firstChild);
        delete el.dataset.returnParent;
      } else {
        lead.removeChild(el);
      }
    }

    const configs: Partial<
      Record<SideCategory, { chromeId: string; parentId: string }>
    > = {
      files: { chromeId: "side-chrome-files", parentId: "side-cat-files" },
      browser: { chromeId: "side-chrome-browser", parentId: "side-cat-browser" },
      agents: { chromeId: "side-chrome-agents", parentId: "side-cat-agents" },
      changes: { chromeId: "side-chrome-changes", parentId: "side-cat-changes" },
      terminal: { chromeId: "term-pane-toolbar", parentId: "side-terminal-body" },
    };
    const cfg = configs[this.category];
    if (!cfg) return;
    const chrome = document.getElementById(cfg.chromeId);
    if (!chrome) return;
    chrome.dataset.returnParent = cfg.parentId;
    chrome.querySelector("#term-pane-new")?.classList.add("hidden");
    lead.appendChild(chrome);
  }

  private refreshTerminalCwd(): void {
    /* cwd 展示已并入终端面板；保留空实现避免旧调用报错 */
  }

  private bindChrome(): void {
    $("btn-panel").onclick = () => this.toggle();
    // 顶栏全屏按钮（原历史按钮位置）
    const focusBtn = document.getElementById("btn-side-focus");
    if (focusBtn) {
      focusBtn.onclick = () => this.toggleFocusMode();
    }
    for (const el of Array.from(
      document.querySelectorAll(".btn-side-close-any"),
    )) {
      (el as HTMLElement).onclick = () => {
        this.setFocusMode(false);
        this.setOpen(false);
      };
    }

    // 收起 / 展开右侧文件目录
    $("btn-tree-toggle").onclick = () => this.toggleFileTree();

    // 刷新文件目录（清缓存后重载已展开目录）
    const refreshBtn = document.getElementById("btn-tree-refresh");
    if (refreshBtn) {
      refreshBtn.onclick = () => void this.refreshFileTree();
    }

    // Esc 退出全屏
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.focusMode) {
        e.preventDefault();
        this.setFocusMode(false);
      }
    });

    // ⋯ 更多菜单
    const moreBtn = $("btn-side-more");
    const moreMenu = $("side-more-menu");
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      moreMenu.classList.toggle("hidden");
    };
    document.addEventListener("click", () => {
      moreMenu.classList.add("hidden");
    });
    moreMenu.onclick = (e) => e.stopPropagation();
    for (const item of Array.from(moreMenu.querySelectorAll(".side-more-item"))) {
      (item as HTMLElement).onclick = () => {
        const act = (item as HTMLElement).dataset.act;
        moreMenu.classList.add("hidden");
        if (act === "open-editor") void this.openExternal();
        if (act === "copy-path") void this.copyPath();
        if (act === "copy-content") void this.copyContent();
        if (act === "save") void this.saveActive();
        if (act === "reveal") void this.reveal();
      };
    }

    // 侧栏 Cursor home 四宫格 + chrome
    for (const el of Array.from(document.querySelectorAll("[data-home-tile]"))) {
      (el as HTMLElement).onclick = () => {
        const tile = (el as HTMLElement).dataset.homeTile;
        if (tile === "files") this.setCategory("files", true);
        else if (tile === "browser") this.setCategory("browser", true);
        else if (tile === "terminal") this.setCategory("terminal", true);
        else if (tile === "changes") this.setCategory("changes", true);
      };
    }
    for (const el of Array.from(document.querySelectorAll("[data-side-home]"))) {
      (el as HTMLElement).onclick = () => this.setCategory("home", true);
    }
    for (const el of Array.from(document.querySelectorAll("[data-side-focus]"))) {
      (el as HTMLElement).onclick = () => this.toggleFocusMode();
    }
    const homePlus = document.getElementById("btn-side-home-plus");
    if (homePlus) {
      homePlus.onclick = (e) => {
        e.stopPropagation();
        this.toggleSidePlusMenu(homePlus);
      };
    }
    this.bindSidePlusMenu();

    const agentsReload = document.getElementById("btn-agents-reload");
    if (agentsReload) {
      agentsReload.onclick = () => void this.refreshAgentsTree();
    }

    for (const el of Array.from(document.querySelectorAll(".side-cat-btn"))) {
      (el as HTMLElement).onclick = () => {
        const cat = (el as HTMLElement).dataset.cat as SideCategory;
        if (cat) this.setCategory(cat, true);
        if (cat === "agents") {
          document.getElementById("btn-cat-agents")?.classList.remove("has-activity");
        }
      };
    }

    const q = $("file-tree-q") as HTMLInputElement;
    q.addEventListener("input", () => {
      this.treeFilter = q.value.trim().toLowerCase();
      this.renderFileTree();
    });

    const resizer = $("split-resizer");
    resizer.addEventListener("pointerdown", (e) => {
      if (!this.open) return;
      e.preventDefault();
      this.resizing = true;
      resizer.classList.add("dragging");
      resizer.setPointerCapture((e as PointerEvent).pointerId);
      const startX = (e as PointerEvent).clientX;
      const startW = this.width;
      const onMove = (ev: PointerEvent) => {
        if (!this.resizing) return;
        // 向左拖 → 侧栏变宽
        const dx = startX - ev.clientX;
        const split = $("main-split");
        const max = Math.floor(split.clientWidth * 0.75);
        this.width = Math.min(max, Math.max(320, startW + dx));
        $("side-pane").style.width = `${this.width}px`;
      };
      const onUp = (ev: PointerEvent) => {
        this.resizing = false;
        resizer.classList.remove("dragging");
        try {
          resizer.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        this.persist();
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });

    // 编辑监听
    $("file-preview-code").addEventListener("input", () => {
      const tab = this.activeTab();
      if (!tab || tab.binary || tab.isDirectory) return;
      tab.draft = $("file-preview-code").textContent ?? "";
      tab.dirty = tab.draft !== tab.content;
      this.renderTabs();
      this.syncSaveBtn();
    });
  }

  private activeTab(): FileTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  private syncSaveBtn(): void {
    const tab = this.activeTab();
    const isMd = tab ? this.isMarkdownTab(tab) : true;
    const canSave =
      !!tab && tab.dirty && !tab.binary && !tab.isDirectory && !isMd;
    const menuSave = document.getElementById("menu-side-save") as HTMLElement | null;
    if (menuSave) {
      menuSave.style.opacity = canSave ? "1" : "0.4";
      menuSave.style.pointerEvents = canSave ? "auto" : "none";
    }
  }

  private async copyPath(): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    const t = tab.absPath || tab.path;
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      /* ignore */
    }
  }

  private async copyContent(): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    try {
      await navigator.clipboard.writeText(tab.draft || tab.content);
    } catch {
      /* ignore */
    }
  }

  private isMarkdownTab(tab: FileTab): boolean {
    return (
      tab.language === "markdown" ||
      /\.md$/i.test(tab.path) ||
      /\.md$/i.test(tab.absPath)
    );
  }

  // ── 文件树 ─────────────────────────────────────────────

  private async ensureFileTree(): Promise<void> {
    const cwd = this.getCwd();
    if (!cwd) {
      $("file-tree").innerHTML =
        `<div class="file-tree-empty">${esc(tr("side.needProject"))}</div>`;
      return;
    }
    if (this.treeLoadedRoot !== cwd) {
      this.treeCache.clear();
      this.expandedDirs = new Set(["."]);
      this.treeLoadedRoot = cwd;
    }
    await this.loadDir(".");
    this.renderFileTree();
  }

  /** 强制刷新：清缓存并重载已展开目录（保留展开状态） */
  async refreshFileTree(): Promise<void> {
    const cwd = this.getCwd();
    if (!cwd) {
      $("file-tree").innerHTML =
        `<div class="file-tree-empty">${esc(tr("side.needProject"))}</div>`;
      void this.syncFileWatch();
      return;
    }
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      const expanded = [...this.expandedDirs];
      this.treeCache.clear();
      this.treeLoadedRoot = cwd;
      await this.loadDir(".");
      for (const dir of expanded) {
        if (dir && dir !== ".") await this.loadDir(dir);
      }
      this.renderFileTree();
      void this.syncFileWatch();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshFileTree();
      }
    }
  }

  /**
   * 防抖刷新（fs.watch / 写工具完成）。侧栏未开文件树时不刷。
   */
  scheduleRefreshFileTree(delayMs = 280): void {
    if (!this.open || this.category !== "files") return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshFileTree();
    }, delayMs);
  }

  /** 项目 cwd 切换时由外部调用：清缓存并按需重监听 */
  onCwdChanged(): void {
    this.treeCache.clear();
    this.treeLoadedRoot = null;
    this.expandedDirs = new Set(["."]);
    if (this.open && this.category === "files") void this.refreshFileTree();
    else void this.syncFileWatch();
  }

  private async syncFileWatch(): Promise<void> {
    const cwd =
      this.open && this.category === "files" ? this.getCwd() : null;
    if (!cwd) {
      if (this.watchingCwd) {
        this.watchingCwd = null;
        await this.inv("files.watchStop", {});
      }
      return;
    }
    if (this.watchingCwd === cwd) return;
    this.watchingCwd = cwd;
    await this.inv("files.watchStart", { cwd });
  }

  private async loadDir(relPath: string): Promise<TreeEntry[]> {
    const key = relPath || ".";
    if (this.treeCache.has(key)) return this.treeCache.get(key)!;
    const cwd = this.getCwd();
    const res = await this.inv<{
      path: string;
      absPath: string;
      entries: TreeEntry[];
    }>("files.list", {
      path: key === "." ? undefined : key,
      cwd: cwd ?? undefined,
    });
    if (!res.ok || !res.data) {
      this.treeCache.set(key, []);
      return [];
    }
    this.treeCache.set(key, res.data.entries);
    return res.data.entries;
  }

  private fileIcon(ent: TreeEntry): string {
    // 侧栏文件树：目录用 SF folder；文件用短标签（保留类型辨识）
    if (ent.isDirectory) return "__folder__";
    const e = ent.ext.toLowerCase();
    if (e === "md") return "MD";
    if (e === "ts" || e === "tsx") return "TS";
    if (e === "js" || e === "jsx" || e === "mjs") return "JS";
    if (e === "json") return "{}";
    if (e === "yml" || e === "yaml") return "YML";
    if (e === "css" || e === "scss") return "CSS";
    if (e === "html") return "HTML";
    if (e === "py") return "PY";
    if (e === "rs") return "RS";
    if (e === "go") return "GO";
    if (e === "svg" || e === "png" || e === "jpg") return "IMG";
    if (e === "lock") return "LOCK";
    return "DOC";
  }

  private renderFileTree(): void {
    const root = $("file-tree");
    root.innerHTML = "";
    const cwd = this.getCwd();
    if (!cwd) {
      root.innerHTML = `<div class="file-tree-empty">${esc(tr("side.needProject"))}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    this.renderTreeLevel(frag, ".", 0);
    if (!frag.childNodes.length) {
      root.innerHTML = `<div class="file-tree-empty">${esc(tr("side.noMatchFiles"))}</div>`;
      return;
    }
    root.appendChild(frag);
  }

  private renderTreeLevel(
    parent: ParentNode,
    dirRel: string,
    depth: number,
  ): void {
    const entries = this.treeCache.get(dirRel || ".") ?? [];
    const filter = this.treeFilter;
    for (const ent of entries) {
      if (filter) {
        // 目录：若自身不匹配，仍展开看子项（仅已缓存）
        const selfMatch = ent.name.toLowerCase().includes(filter);
        if (ent.isDirectory) {
          if (!selfMatch && !this.dirHasMatch(ent.path, filter)) continue;
        } else if (!selfMatch) {
          continue;
        }
      }

      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-tree-row";
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.path = ent.path;
      row.dataset.abs = ent.absPath;
      row.dataset.dir = ent.isDirectory ? "1" : "0";

      const expanded = this.expandedDirs.has(ent.path);
      const chevron = ent.isDirectory
        ? `<span class="ft-chev">${sfIcon(expanded ? "chevronDown" : "chevronRight", { size: 11, className: "sf-ico sf-ico--sm" })}</span>`
        : `<span class="ft-chev ft-spacer"></span>`;
      const icoRaw = this.fileIcon(ent);
      const icoCls = ent.isDirectory
        ? "ft-ico dir"
        : `ft-ico ext-${ent.ext || "file"}`;
      const icoHtml =
        icoRaw === "__folder__"
          ? sfIcon("folder", { size: 13, className: "sf-ico sf-ico--sm" })
          : esc(icoRaw);
      row.innerHTML =
        chevron +
        `<span class="${icoCls}">${icoHtml}</span>` +
        `<span class="ft-name">${esc(ent.name)}</span>`;

      row.onclick = () => void this.onTreeClick(ent);
      parent.appendChild(row);

      if (ent.isDirectory && expanded) {
        // 子级若未加载则先占位后异步加载
        if (!this.treeCache.has(ent.path)) {
          void this.loadDir(ent.path).then(() => this.renderFileTree());
        } else {
          this.renderTreeLevel(parent, ent.path, depth + 1);
        }
      }
    }
  }

  private dirHasMatch(dirPath: string, filter: string): boolean {
    const kids = this.treeCache.get(dirPath);
    if (!kids) return true; // 未加载：先显示目录
    for (const k of kids) {
      if (k.name.toLowerCase().includes(filter)) return true;
      if (k.isDirectory && this.dirHasMatch(k.path, filter)) return true;
    }
    return false;
  }

  private async onTreeClick(ent: TreeEntry): Promise<void> {
    if (ent.isDirectory) {
      if (this.expandedDirs.has(ent.path)) {
        this.expandedDirs.delete(ent.path);
      } else {
        this.expandedDirs.add(ent.path);
        await this.loadDir(ent.path);
      }
      this.renderFileTree();
      return;
    }
    await this.openFile(ent.path);
  }

  private toggleFileTree(): void {
    this.treeVisible = !this.treeVisible;
    this.applyTreeVisible();
  }

  private applyTreeVisible(): void {
    const col = document.getElementById("side-files-tree-col");
    const btn = document.getElementById("btn-tree-toggle") as HTMLElement | null;
    if (col) col.classList.toggle("collapsed", !this.treeVisible);
    if (btn) {
      btn.textContent = this.treeVisible ? "⟩" : "⟨";
      btn.title = this.treeVisible ? tr("side.collapseTree") : tr("side.expandTree");
      btn.setAttribute("aria-pressed", this.treeVisible ? "false" : "true");
      btn.setAttribute(
        "aria-label",
        this.treeVisible ? tr("side.collapseTree") : tr("side.expandTree"),
      );
    }
  }

  /** 打开路径到侧栏（聊天点击 / 工具） */
  async openFile(path: string, line?: number): Promise<void> {
    this.setCategory("files", true);
    const cwd = this.getCwd();
    // 已打开则激活
    const existing = this.tabs.find(
      (t) =>
        t.absPath.replace(/\\/g, "/").toLowerCase() ===
          path.replace(/\\/g, "/").toLowerCase() ||
        t.path.replace(/\\/g, "/").toLowerCase() ===
          path.replace(/\\/g, "/").toLowerCase(),
    );
    if (existing) {
      if (line) existing.line = line;
      this.activeId = existing.id;
      this.renderAll();
      this.scrollToLine(existing.line);
      return;
    }

    // 读取前先提示加载，避免「侧栏空空」的误感
    this.showInfo(tr("side.openingFile", { path }));

    const res = await this.inv<{
      path: string;
      absPath: string;
      content: string;
      language: string;
      truncated: boolean;
      binary: boolean;
      isDirectory: boolean;
    }>("files.read", { path, cwd: cwd ?? undefined });

    if (!res.ok || !res.data) {
      const msg = res.error?.message ?? tr("side.readFail");
      this.showInfo(`${tr("side.readFail")}\n${path}\n\n${msg}`);
      return;
    }
    const d = res.data;
    if (d.isDirectory) {
      this.showInfo(tr("side.isDir", { path: d.absPath }));
      return;
    }
    const tab: FileTab = {
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      path: d.path || path,
      absPath: d.absPath,
      content: d.content,
      draft: d.content,
      language: d.language || "plaintext",
      line,
      dirty: false,
      truncated: d.truncated,
      binary: d.binary,
      isDirectory: false,
    };
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.renderAll();
    this.scrollToLine(line);
  }

  showInfo(text: string): void {
    // 不重复 setCategory，避免无 tab 时被 renderActive 刷回 empty
    this.category = "files";
    this.open = true;
    this.applyCategory();
    this.applyOpenState(true);
    this.persist();
    $("side-pane-empty").classList.add("hidden");
    $("file-preview").classList.add("hidden");
    $("md-preview").classList.add("hidden");
    const info = $("side-pane-info");
    info.classList.remove("hidden");
    info.textContent = text;
  }

  /** 打开 Changes 面板（Cursor 式未提交变更） */
  async showChangesSummary(): Promise<void> {
    this.setCategory("changes", true);
  }

  private renderAll(): void {
    this.renderTabs();
    this.renderActive();
    this.syncSaveBtn();
  }

  private renderTabs(): void {
    const box = $("side-pane-tabs");
    box.innerHTML = "";
    for (const t of this.tabs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `side-tab${t.id === this.activeId ? " active" : ""}${t.dirty ? " dirty" : ""}`;
      b.innerHTML = `<span class="tab-name">${esc(baseName(t.absPath || t.path))}</span><span class="tab-close" data-close="${esc(t.id)}" title="${esc(tr("side.tabClose"))}">✕</span>`;
      b.onclick = (e) => {
        const c = (e.target as HTMLElement).closest("[data-close]") as HTMLElement | null;
        if (c) {
          e.stopPropagation();
          this.closeTab(c.dataset.close!);
          return;
        }
        this.activeId = t.id;
        this.renderAll();
      };
      box.appendChild(b);
    }
  }

  private closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const was = this.activeId === id;
    this.tabs.splice(idx, 1);
    if (was) {
      this.activeId = this.tabs[idx]?.id ?? this.tabs[idx - 1]?.id ?? null;
    }
    if (!this.tabs.length) {
      this.activeId = null;
      $("file-preview").classList.add("hidden");
      $("md-preview").classList.add("hidden");
      $("side-pane-info").classList.add("hidden");
      $("side-pane-empty").classList.remove("hidden");
      $("side-breadcrumb").innerHTML = "";
      this.renderTabs();
      this.syncSaveBtn();
      return;
    }
    this.renderAll();
  }

  private renderActive(): void {
    const tab = this.activeTab();
    const empty = $("side-pane-empty");
    const preview = $("file-preview");
    const mdPrev = $("md-preview");
    const info = $("side-pane-info");
    const codeEl = $("file-preview-code");
    const gutter = $("file-preview-gutter");

    if (!tab) {
      empty.classList.remove("hidden");
      preview.classList.add("hidden");
      mdPrev.classList.add("hidden");
      info.classList.add("hidden");
      $("side-breadcrumb").innerHTML = "";
      return;
    }

    empty.classList.add("hidden");
    $("side-breadcrumb").innerHTML = breadcrumbHtml(tab.absPath, this.getCwd());

    if (tab.binary) {
      preview.classList.add("hidden");
      mdPrev.classList.add("hidden");
      info.classList.remove("hidden");
      info.textContent = tr("side.binary", { path: tab.absPath });
      return;
    }

    info.classList.add("hidden");

    // Markdown：Codex 式富文本预览
    if (this.isMarkdownTab(tab)) {
      preview.classList.add("hidden");
      mdPrev.classList.remove("hidden");
      mdPrev.innerHTML = renderMarkdownToSafeHtml(tab.draft, {
        highlight: true,
        fixFences: true,
      });
      linkifyFilePaths(mdPrev, this.getCwd());
      // MD 预览：文件路径 + 页内锚点
      mdPrev.onclick = (e) => {
        const t = e.target as HTMLElement;
        const anchor = t.closest("a.md-anchor-link") as HTMLAnchorElement | null;
        if (anchor) {
          e.preventDefault();
          const id = decodeURIComponent(
            anchor.getAttribute("data-anchor-id") ||
              (anchor.getAttribute("href") || "").replace(/^#/, ""),
          ).trim();
          if (!id) return;
          let el: HTMLElement | null = null;
          try {
            el = mdPrev.querySelector(`#${CSS.escape(id)}`);
          } catch {
            el = document.getElementById(id);
          }
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        const a = t.closest(
          "a.file-link, [data-file-path]",
        ) as HTMLElement | null;
        if (!a?.dataset.filePath) return;
        e.preventDefault();
        void this.openFile(
          a.dataset.filePath,
          a.dataset.line ? Number(a.dataset.line) : undefined,
        );
      };
      return;
    }

    // 代码 / 文本
    mdPrev.classList.add("hidden");
    preview.classList.remove("hidden");

    const text = tab.draft;
    const lines = text.split(/\r?\n/);
    gutter.innerHTML = lines
      .map((_, i) => {
        const n = i + 1;
        const hl = tab.line === n ? " hl" : "";
        return `<span class="ln${hl}">${n}</span>`;
      })
      .join("");

    codeEl.setAttribute("contenteditable", "true");
    codeEl.textContent = text;
    codeEl.dataset.lang = tab.language;
    if (!tab.dirty) {
      try {
        if (hljs.getLanguage(tab.language)) {
          codeEl.innerHTML = hljs.highlight(text, {
            language: tab.language,
            ignoreIllegals: true,
          }).value;
        }
      } catch {
        codeEl.textContent = text;
      }
    }
    codeEl.onfocus = () => {
      if (codeEl.querySelector("span")) {
        codeEl.textContent = tab.draft;
      }
    };

    if (tab.truncated) {
      const note = document.createElement("div");
      note.className = "side-pane-info";
      note.style.cssText =
        "position:absolute;bottom:0;left:0;right:0;padding:6px 12px;background:#fff8e6;font-size:12px;border-top:1px solid #f0e0b0";
      note.textContent = tr("side.truncatedNote");
      $("side-pane-body").appendChild(note);
      setTimeout(() => note.remove(), 4000);
    }
  }

  private scrollToLine(line?: number): void {
    if (!line || line < 1) return;
    requestAnimationFrame(() => {
      const gutter = $("file-preview-gutter");
      const el = gutter.children[line - 1] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "center" });
      const preview = $("file-preview");
      // 同步：gutter 与 code 同容器滚动
      void preview;
    });
  }

  private async openExternal(): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    await this.inv("system.openInEditor", {
      path: tab.absPath,
      line: tab.line,
    });
  }

  private async reveal(): Promise<void> {
    const tab = this.activeTab();
    if (!tab) return;
    await this.inv("system.openPath", { path: tab.absPath });
  }

  private async saveActive(): Promise<void> {
    const tab = this.activeTab();
    if (!tab || !tab.dirty) return;
    // 从 DOM 取最新
    tab.draft = $("file-preview-code").textContent ?? tab.draft;
    const res = await this.inv<{ absPath: string; bytes: number }>(
      "files.write",
      {
        path: tab.absPath,
        content: tab.draft,
        cwd: this.getCwd() ?? undefined,
      },
    );
    if (!res.ok) {
      this.showInfo(res.error?.message ?? tr("side.saveFail"));
      return;
    }
    tab.content = tab.draft;
    tab.dirty = false;
    this.renderAll();
  }
}
