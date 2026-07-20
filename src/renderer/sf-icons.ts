/**
 * SF Symbols 风格线框图标（统一 stroke / 圆角 / 光学尺寸）。
 * 用于 HTML 静态与 JS 动态渲染，避免 emoji / 杂字混用。
 */

export type SfIconName =
  | "compose"
  | "continue"
  | "search"
  | "plugins"
  | "timer"
  | "settings"
  | "plus"
  | "folder"
  | "folderFill"
  | "folderBadgePlus"
  | "chevronDown"
  | "chevronRight"
  | "chevronUp"
  | "sidebarLeft"
  | "sidebarRight"
  | "expand"
  | "send"
  | "ellipsis"
  | "xmark"
  | "archive"
  | "slash"
  | "circleDot"
  | "ban"
  | "doc"
  | "copy"
  | "arrowDown"
  | "arrowClockwise"
  | "trash"
  | "pause"
  | "play"
  | "list"
  | "checkmark"
  | "paperclip"
  | "person"
  | "command"
  | "terminal";

/** 24×24 viewBox 路径，stroke 由外层 SVG 控制 */
const PATHS: Record<SfIconName, string> = {
  compose:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  continue:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.1-5.6"/><path d="M3.5 4.5v4h4"/>',
  search:
    '<circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4.3 4.3"/>',
  plugins:
    '<path d="M12 3.5v3.2"/><path d="M12 17.3v3.2"/><path d="M3.5 12h3.2"/><path d="M17.3 12h3.2"/><rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2.2"/>',
  timer:
    '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5v4l2.5 1.5"/><path d="M9 3.5h6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 6.5l1.6 1.6M17.5 15.9l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.9 17.5l1.6-1.6M17.5 8.1l1.6-1.6"/>',
  plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  folder:
    '<path d="M3.8 7.5A1.8 1.8 0 0 1 5.6 5.7h4.1l1.6 1.7h7.1A1.8 1.8 0 0 1 20.2 9.2v8.1a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8Z"/>',
  folderFill:
    '<path d="M3.8 7.5A1.8 1.8 0 0 1 5.6 5.7h4.1l1.6 1.7h7.1A1.8 1.8 0 0 1 20.2 9.2v8.1a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8Z" fill="currentColor" stroke="none"/>',
  folderBadgePlus:
    '<path d="M3.8 7.5A1.8 1.8 0 0 1 5.6 5.7h4.1l1.6 1.7h5.2"/><path d="M20.2 11.2V9.2A1.8 1.8 0 0 0 18.4 7.4h-1"/><path d="M3.8 7.5v9.8A1.8 1.8 0 0 0 5.6 19.1h7.2"/><circle cx="17.5" cy="16.5" r="3.2"/><path d="M17.5 15v3"/><path d="M16 16.5h3"/>',
  chevronDown: '<path d="m7.5 10 4.5 4.5L16.5 10"/>',
  chevronRight: '<path d="m10 7.5 4.5 4.5L10 16.5"/>',
  chevronUp: '<path d="m7.5 14 4.5-4.5L16.5 14"/>',
  sidebarLeft:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M9.2 4.5v15"/><path d="M13.5 12H7.8"/><path d="m9.8 9.8-2 2.2 2 2.2"/>',
  sidebarRight:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M14.8 4.5v15"/>',
  expand:
    '<path d="M9 4.5H4.5V9"/><path d="M15 4.5h4.5V9"/><path d="M9 19.5H4.5V15"/><path d="M15 19.5h4.5V15"/>',
  send: '<path d="M12 18.5V6.2"/><path d="m7.8 10.2 4.2-4 4.2 4"/>',
  ellipsis:
    '<circle cx="6.5" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="17.5" cy="12" r="1.15" fill="currentColor" stroke="none"/>',
  xmark: '<path d="m7.5 7.5 9 9"/><path d="m16.5 7.5-9 9"/>',
  archive:
    '<path d="M4 8.2h16v2.2H4z"/><path d="M5.2 10.4V18a1.4 1.4 0 0 0 1.4 1.4h11a1.4 1.4 0 0 0 1.4-1.4v-7.6"/><path d="M10 13.5h4"/>',
  slash: '<path d="M9.2 18.5 14.8 5.5"/><path d="M7 18.5h3.2M13.8 5.5H17"/>',
  circleDot:
    '<circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>',
  ban: '<circle cx="12" cy="12" r="7.5"/><path d="m7.2 7.2 9.6 9.6"/>',
  doc: '<path d="M8 3.8h5.2L18 8.6V19a1.4 1.4 0 0 1-1.4 1.4H8A1.4 1.4 0 0 1 6.6 19V5.2A1.4 1.4 0 0 1 8 3.8z"/><path d="M13.2 3.8v4.2H18"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M6.8 15.2H6A1.6 1.6 0 0 1 4.4 13.6V6A1.6 1.6 0 0 1 6 4.4h7.6A1.6 1.6 0 0 1 15.2 6v.8"/>',
  arrowDown: '<path d="M12 5.5v13"/><path d="m7.8 13.8 4.2 4 4.2-4"/>',
  arrowClockwise:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.1-5.6"/><path d="M3.5 4.5v4h4"/>',
  trash:
    '<path d="M5.5 7.2h13"/><path d="M9.2 7.2V5.6A1.2 1.2 0 0 1 10.4 4.4h3.2a1.2 1.2 0 0 1 1.2 1.2v1.6"/><path d="M7.2 7.2 8 18.2A1.4 1.4 0 0 0 9.4 19.5h5.2A1.4 1.4 0 0 0 16 18.2l.8-11"/>',
  pause: '<path d="M9 6.5v11"/><path d="M15 6.5v11"/>',
  play: '<path d="M9 6.8v10.4l8.2-5.2Z" fill="currentColor" stroke="none"/>',
  list: '<path d="M8.5 7h10"/><path d="M8.5 12h10"/><path d="M8.5 17h10"/><circle cx="5.2" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="5.2" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5.2" cy="17" r="1" fill="currentColor" stroke="none"/>',
  checkmark: '<path d="m5.5 12.2 4.2 4.1L18.5 7.5"/>',
  paperclip:
    '<path d="M15.2 11.2 9.6 16.8a3.2 3.2 0 0 1-4.5-4.5l7.2-7.2a2.2 2.2 0 0 1 3.1 3.1l-6.5 6.5a1.1 1.1 0 1 1-1.6-1.6l5.4-5.4"/>',
  person:
    '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.2c1.4-3.2 3.7-4.7 6.5-4.7s5.1 1.5 6.5 4.7"/>',
  command:
    '<path d="M8.8 7.6A2.4 2.4 0 1 0 6.4 10h2.4v4H6.4a2.4 2.4 0 1 0 2.4 2.4V14h4.8v2.4a2.4 2.4 0 1 0 2.4-2.4h-2.4v-4h2.4a2.4 2.4 0 1 0-2.4-2.4V10H8.8V7.6z"/>',
  terminal:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="m7.2 9.2 2.8 2.8-2.8 2.8"/><path d="M12.2 14.8h4.6"/>',
};

export interface SfIconOpts {
  className?: string;
  /** 光学尺寸，侧栏默认 16，工具栏 15–17 */
  size?: number;
  label?: string;
}

const NAMES = new Set<string>(Object.keys(PATHS));

export function isSfIconName(name: string): name is SfIconName {
  return NAMES.has(name);
}

/** 生成内联 SVG（供 innerHTML / 模板） */
export function sfIcon(name: SfIconName, opts: SfIconOpts = {}): string {
  const size = opts.size ?? 16;
  const cls = ["sf-ico", opts.className].filter(Boolean).join(" ");
  const label = opts.label
    ? ` role="img" aria-label="${opts.label}"`
    : ` aria-hidden="true"`;
  return (
    `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"${label}>` +
    PATHS[name] +
    `</svg>`
  );
}

/**
 * 把 `[data-sf="compose"]` 占位替换为 SVG。
 * 可在动态插入 DOM 后再次调用。
 */
export function hydrateSfIcons(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>("[data-sf]");
  for (const el of Array.from(nodes)) {
    const name = el.getAttribute("data-sf") ?? "";
    if (!isSfIconName(name)) continue;
    const sizeAttr = el.getAttribute("data-sf-size");
    const size = sizeAttr ? Number(sizeAttr) : 16;
    const className =
      el.getAttribute("data-sf-class") ||
      (el.classList.contains("sf-ico") ? el.className : "sf-ico");
    const wrap = document.createElement("template");
    wrap.innerHTML = sfIcon(name, {
      className,
      size: Number.isFinite(size) ? size : 16,
    }).trim();
    const svg = wrap.content.firstElementChild;
    if (!svg) continue;
    el.replaceWith(svg);
  }
}
