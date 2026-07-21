/**
 * Side-pane terminal UI: multi-tab xterm for ACP + user PTY sessions.
 * Interaction aligned with Codex/Cursor: open category → auto shell.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { NormalizedEvent } from "../shared/events.js";
import { tr } from "../shared/i18n/index.js";

type Inv = (
  method: string,
  params?: unknown,
) => Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }>;

export interface TerminalPaneDeps {
  inv: Inv;
  getCwd: () => string | null;
  /** Open side pane on terminal category (user-initiated / interactive) */
  focusTerminalCategory: () => void;
  /** Whether the side pane is currently showing the terminal category */
  isTerminalCategoryActive?: () => boolean;
  /** ACP 后台终端：不抢焦点，仅提示有活动 */
  onAcpTerminalBackground?: (terminalId: string) => void;
  onFocus?: () => void;
  onClose?: () => void;
  onBackHome?: () => void;
  /** Cursor：+ 打开二级菜单（而非直接新建终端） */
  onPlusClick?: (anchor: HTMLElement) => void;
}

/** 浅色主题：与 app --bg / 左侧栏同色底，避免左右色差 */
const TERM_THEME = {
  background: "#ebebef",
  foreground: "#1c1c1e",
  cursor: "#1c1c1e",
  cursorAccent: "#ebebef",
  selectionBackground: "rgba(0, 0, 0, 0.12)",
  selectionInactiveBackground: "rgba(0, 0, 0, 0.06)",
  black: "#1a1a1a",
  red: "#c42b2b",
  green: "#0a7a3e",
  yellow: "#9a6700",
  blue: "#1a6fb5",
  magenta: "#a12d9c",
  cyan: "#0d7c8f",
  white: "#e8e8e8",
  brightBlack: "#6e6e6e",
  brightRed: "#e04848",
  brightGreen: "#12a354",
  brightYellow: "#c69000",
  brightBlue: "#2b8bd8",
  brightMagenta: "#c44ebe",
  brightCyan: "#12a0b5",
  brightWhite: "#1c1c1e",
} as const;

interface TabState {
  terminalId: string;
  title: string;
  kind: "acp" | "user";
  interactive: boolean;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  exited: boolean;
}

export class TerminalPaneController {
  private root: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private hostEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private tabs = new Map<string, TabState>();
  private activeId: string | null = null;
  private ro: ResizeObserver | null = null;
  private deps: TerminalPaneDeps;
  private creatingDefault = false;
  /** 最近一次 agent 后台终端，用户点开 Terminal 时优先展示 */
  private pendingAcpId: string | null = null;

  constructor(deps: TerminalPaneDeps) {
    this.deps = deps;
  }

  /** 侧栏切入 Terminal 时优先激活该 ACP 标签 */
  activateIfPresent(terminalId: string): boolean {
    if (!this.tabs.has(terminalId)) return false;
    this.activate(terminalId);
    return true;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = `
      <div class="term-pane-toolbar">
        <button type="button" class="side-chrome-back term-pane-back" id="term-pane-back" title="${escAttr(tr("side.backHome"))}">←</button>
        <div class="term-pane-tabs" id="term-pane-tabs" role="tablist"></div>
        <button type="button" class="term-pane-new" id="term-pane-new" title="${escAttr(tr("side.plusMenu"))}" aria-haspopup="menu" aria-expanded="false">
          +
        </button>
      </div>
      <div class="term-pane-host" id="term-pane-host"></div>
      <div class="term-pane-empty hidden" id="term-pane-empty">
        <p class="side-cat-lead">${esc(tr("side.terminalLeadLive"))}</p>
      </div>
    `;
    this.tabsEl = root.querySelector("#term-pane-tabs");
    this.hostEl = root.querySelector("#term-pane-host");
    this.emptyEl = root.querySelector("#term-pane-empty");
    root.querySelector("#term-pane-new")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLElement;
      if (this.deps.onPlusClick) this.deps.onPlusClick(btn);
      else void this.createUserTerminal();
    });
    root.querySelector("#term-pane-back")?.addEventListener("click", () => {
      this.deps.onBackHome?.();
    });

    if (typeof ResizeObserver !== "undefined" && this.hostEl) {
      this.ro = new ResizeObserver(() => this.fitActive());
      this.ro.observe(this.hostEl);
    }
    this.syncEmpty();
  }

  dispose(): void {
    this.ro?.disconnect();
    this.ro = null;
    for (const tab of this.tabs.values()) {
      tab.term.dispose();
    }
    this.tabs.clear();
    this.activeId = null;
  }

  /**
   * Cursor / Codex：用户切到终端栏时：
   * - 已有存活会话（含 ACP）→ 激活展示，不额外开 zsh
   * - 完全没有会话 → 自动开本机交互 shell
   * Agent 后台建终端不走这里；由用户点 Terminal / + / 快捷键进入。
   */
  ensureDefaultTerminal(): void {
    const run = () => {
      // 有待查看的 agent 服务终端 → 优先展示（Cursor：点 Terminal 看到刚起的服务）
      const pending = this.pendingAcpId;
      if (pending) {
        const tab = this.tabs.get(pending);
        if (tab && !tab.exited) {
          this.pendingAcpId = null;
          this.activate(pending);
          return;
        }
        this.pendingAcpId = null;
      }
      const liveAcp = [...this.tabs.values()].filter(
        (t) => !t.exited && t.kind === "acp",
      );
      if (liveAcp.length > 0) {
        const prefer =
          this.activeId &&
          this.tabs.get(this.activeId)?.kind === "acp" &&
          !this.tabs.get(this.activeId)!.exited
            ? this.activeId!
            : liveAcp[liveAcp.length - 1]!.terminalId;
        this.activate(prefer);
        return;
      }
      const liveUser = [...this.tabs.values()].filter(
        (t) => !t.exited && t.kind === "user",
      );
      if (liveUser.length > 0) {
        const prefer =
          this.activeId &&
          this.tabs.get(this.activeId) &&
          !this.tabs.get(this.activeId)!.exited
            ? this.activeId
            : liveUser[0]!.terminalId;
        this.activate(prefer);
        return;
      }
      if (this.creatingDefault) return;
      void this.createUserTerminal({ asDefault: true });
    };
    // 等侧栏布局完成再创建，避免 fit/焦点抢在 hidden 状态下失败
    requestAnimationFrame(() => requestAnimationFrame(run));
  }

  onHostEvent(ev: NormalizedEvent): void {
    if (ev.type === "terminal.opened") {
      this.ensureTab({
        terminalId: ev.terminalId,
        title: ev.title,
        kind: ev.kind,
        // ACP 服务终端也允许输入 / Ctrl+C（Cursor 对齐）
        interactive: ev.interactive || ev.kind === "acp",
      });
      this.creatingDefault = false;

      // Cursor：
      // - 用户自建 shell：打开侧栏并聚焦
      // - Agent 起的服务：建可交互标签，不抢聊天焦点；已在终端栏则切到该标签
      const onTerminal = this.deps.isTerminalCategoryActive?.() === true;
      if (ev.kind === "user") {
        this.activate(ev.terminalId);
        this.deps.focusTerminalCategory();
      } else if (onTerminal) {
        this.activate(ev.terminalId);
      } else {
        this.pendingAcpId = ev.terminalId;
        this.deps.onAcpTerminalBackground?.(ev.terminalId);
      }
      return;
    }
    if (ev.type === "terminal.output") {
      const tab = this.tabs.get(ev.terminalId);
      if (tab) tab.term.write(ev.data);
      // 后台有新输出时点一下 Terminal 磁贴（不抢焦点）
      const onTerminal = this.deps.isTerminalCategoryActive?.() === true;
      if (
        tab &&
        tab.kind === "acp" &&
        !tab.exited &&
        (!onTerminal || this.activeId !== ev.terminalId)
      ) {
        this.pendingAcpId = ev.terminalId;
        this.deps.onAcpTerminalBackground?.(ev.terminalId);
      }
      return;
    }
    if (ev.type === "terminal.exit") {
      const tab = this.tabs.get(ev.terminalId);
      if (!tab) return;
      tab.exited = true;
      const code = ev.exitCode;
      const sig = ev.signal;
      const msg =
        sig != null
          ? `\r\n\x1b[90m[exited signal ${sig}]\x1b[0m\r\n`
          : `\r\n\x1b[90m[exited ${code ?? "?"}]\x1b[0m\r\n`;
      tab.term.write(msg);
      this.renderTabs();
      return;
    }
    if (ev.type === "terminal.closed") {
      this.removeTab(ev.terminalId, false);
    }
  }

  async createUserTerminal(opts?: { asDefault?: boolean }): Promise<void> {
    const cwd = this.deps.getCwd();
    if (!cwd) {
      this.writeBanner(tr("side.terminalNeedProject"));
      this.creatingDefault = false;
      return;
    }
    if (opts?.asDefault) this.creatingDefault = true;
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
    const cols = Math.max(40, active?.term.cols ?? 80);
    const rows = Math.max(12, active?.term.rows ?? 24);
    const r = await this.deps.inv("terminals.createUser", {
      cwd,
      cols,
      rows,
      title: tr("side.terminal"),
    });
    if (!r.ok) {
      this.creatingDefault = false;
      this.writeBanner(r.error?.message || tr("side.terminalCreateFailed"));
    }
  }

  private writeBanner(text: string): void {
    if (!this.emptyEl) return;
    this.emptyEl.classList.remove("hidden");
    const p = this.emptyEl.querySelector(".side-cat-lead");
    if (p) p.textContent = text;
  }

  private ensureTab(opts: {
    terminalId: string;
    title: string;
    kind: "acp" | "user";
    interactive: boolean;
  }): void {
    if (this.tabs.has(opts.terminalId) || !this.hostEl) return;

    const el = document.createElement("div");
    el.className = "term-pane-xterm";
    el.dataset.terminalId = opts.terminalId;
    el.hidden = true;
    this.hostEl.appendChild(el);

    const term = new Terminal({
      convertEol: true,
      fontFamily:
        'Menlo, Monaco, "SF Mono", ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      theme: { ...TERM_THEME },
      cursorBlink: opts.interactive,
      cursorStyle: "block",
      disableStdin: !opts.interactive,
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* ignore until visible */
    }

    if (opts.interactive) {
      term.onData((data) => {
        void this.deps.inv("terminals.write", {
          terminalId: opts.terminalId,
          data,
        });
      });
      term.onResize(({ cols, rows }) => {
        void this.deps.inv("terminals.resize", {
          terminalId: opts.terminalId,
          cols,
          rows,
        });
      });
    }

    this.tabs.set(opts.terminalId, {
      terminalId: opts.terminalId,
      title: opts.title,
      kind: opts.kind,
      interactive: opts.interactive,
      term,
      fit,
      el,
      exited: false,
    });
    this.renderTabs();
    this.syncEmpty();
  }

  private activate(terminalId: string): void {
    if (!this.tabs.has(terminalId)) return;
    this.activeId = terminalId;
    for (const [id, tab] of this.tabs) {
      tab.el.hidden = id !== terminalId;
    }
    this.renderTabs();
    this.syncEmpty();
    requestAnimationFrame(() => {
      this.fitActive();
      this.tabs.get(terminalId)?.term.focus();
    });
  }

  private removeTab(terminalId: string, closeHost: boolean): void {
    const tab = this.tabs.get(terminalId);
    if (!tab) return;
    if (closeHost) {
      void this.deps.inv("terminals.close", { terminalId });
    }
    tab.term.dispose();
    tab.el.remove();
    this.tabs.delete(terminalId);
    if (this.activeId === terminalId) {
      const next =
        [...this.tabs.values()].find((t) => !t.exited)?.terminalId ??
        (this.tabs.keys().next().value as string | undefined);
      this.activeId = next ?? null;
      if (next) this.activate(next);
    }
    this.renderTabs();
    this.syncEmpty();
  }

  private renderTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = "";
    for (const tab of this.tabs.values()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "term-pane-tab" +
        (tab.terminalId === this.activeId ? " active" : "") +
        (tab.exited ? " exited" : "");
      btn.setAttribute("role", "tab");
      const shellLabel =
        tab.kind === "acp"
          ? truncate(shortAcpTitle(tab.title), 22)
          : `>_ ${guessShellName()}`;
      btn.title =
        tab.kind === "acp"
          ? `${tr("side.terminalAgentTab")}: ${tab.title}`
          : tab.title;
      const label = document.createElement("span");
      label.className = "term-pane-tab-label term-pane-tab-shell";
      label.textContent = shellLabel;
      btn.appendChild(label);
      const close = document.createElement("span");
      close.className = "term-pane-tab-close";
      close.textContent = "×";
      close.title = tr("side.terminalClose");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeTab(tab.terminalId, true);
      });
      btn.appendChild(close);
      btn.addEventListener("click", () => this.activate(tab.terminalId));
      this.tabsEl.appendChild(btn);
    }
  }

  private fitActive(): void {
    if (!this.activeId) return;
    const tab = this.tabs.get(this.activeId);
    if (!tab || tab.el.hidden) return;
    try {
      tab.fit.fit();
    } catch {
      /* ignore */
    }
  }

  private syncEmpty(): void {
    const empty = this.tabs.size === 0;
    this.emptyEl?.classList.toggle("hidden", !empty);
    this.hostEl?.classList.toggle("hidden", empty);
  }
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

/** 标签显示短命令：剥 bash -lc / cd &&，贴近 Cursor */
function shortAcpTitle(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  const wrapped = s.match(
    /^\/bin\/(?:ba)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/i,
  );
  if (wrapped?.[2]) s = wrapped[2].trim();
  const parts = s.split(/\s&&\s/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1]!.trim();
    if (last && !/^cd\s+/i.test(last)) s = last;
  }
  // python3 -m http.server … → python3 · http.server
  const py = s.match(/^((?:\/\S+\/)?python3?)\s+-m\s+(\S+)/i);
  if (py) return `${pathBase(py[1]!)} · ${py[2]}`;
  const tok = s.split(/\s+/)[0] || s;
  return pathBase(tok);
}

function pathBase(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function guessShellName(): string {
  // renderer 无 process.env.SHELL；展示与 Cursor 一致的常见默认
  const plat =
    typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
  if (plat.includes("win")) return "powershell";
  return "zsh";
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
