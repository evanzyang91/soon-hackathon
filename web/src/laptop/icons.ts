// The UI's icons: 16 px inline SVG, 1.5 px strokes on a 16-unit grid, drawn in currentColor (no
// icon font, no CDN). `icon(name)` builds one; markup in index.html asks for one with
// `<span data-icon="name"></span>`, which `mountIcons()` fills in.
const PATHS = {
  // a viewfinder: frame corners around a point
  brand:
    '<path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/><circle cx="8" cy="8" r="1.75"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.25 3v10"/>',
  play: '<path d="M5 3.4v9.2a.4.4 0 0 0 .6.34l7.2-4.6a.4.4 0 0 0 0-.68L5.6 3.06a.4.4 0 0 0-.6.34Z"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  'skip-back':
    '<path d="M4 3.5v9"/><path d="M12 3.9v8.2a.4.4 0 0 1-.62.33L6.3 8.33a.4.4 0 0 1 0-.66l5.08-4.1a.4.4 0 0 1 .62.33Z"/>',
  undo: '<path d="M3.5 6.5h6.25a3 3 0 0 1 0 6H7"/><path d="M6 4 3.5 6.5 6 9"/>',
  redo: '<path d="M12.5 6.5H6.25a3 3 0 0 0 0 6H9"/><path d="M10 4l2.5 2.5L10 9"/>',
  keyboard:
    '<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h-.5M5.5 9.5h5"/>',
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.25"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13.25 2.75v3h-3"/>',
  close: '<path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  minus: '<path d="M3.5 8h9"/>',
  'chevron-down': '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

const NS = 'http://www.w3.org/2000/svg';

/** A 16 px stroke icon (aria-hidden; the button around it carries the title / label). */
export function icon(name: IconName, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `ico${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = name;
  svg.innerHTML = PATHS[name];
  return svg;
}

/** Replaces every `[data-icon]` placeholder under `root` (static markup) with its SVG. */
export function mountIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('span[data-icon]')) {
    const name = el.dataset.icon as IconName;
    if (name in PATHS) el.replaceWith(icon(name, el.className));
  }
}
