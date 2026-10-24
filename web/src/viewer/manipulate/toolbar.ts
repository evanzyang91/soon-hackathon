// The small floating toolbar over the selection (DOM, positioned over the viewport every frame).
// Its content is rebuilt only when the model changes; `place` just moves it.

export interface ToolButton {
  kind?: 'button';
  label: string;
  /** Hover hint (every button has one). */
  title: string;
  onClick: () => void;
  testid?: string;
  on?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

export interface ToolColor {
  kind: 'color';
  value: string;
  title: string;
  testid?: string;
  /** While the picker is open (live preview). */
  onInput: (hex: string) => void;
  /** Picker closed on a colour (commit). */
  onChange: (hex: string) => void;
}

export type ToolItem = ToolButton | ToolColor | 'sep';

export interface ToolbarModel {
  /** data-kind on the element: actor / prop / light / camera / region. */
  kind: string;
  title: string;
  hint?: string;
  items: ToolItem[];
}

export class Toolbar {
  readonly el: HTMLDivElement;
  private key = '';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'manip-toolbar';
    this.el.dataset.testid = 'manip-toolbar';
    this.el.hidden = true;
    // the canvas under it must not see these presses (no look-drag, no deselect)
    for (const ev of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel'] as const)
      this.el.addEventListener(ev, (e) => e.stopPropagation());
    parent.append(this.el);
  }

  /** Shows `model` (rebuilt only when it changed); null hides the toolbar. */
  show(model: ToolbarModel | null) {
    if (!model) {
      this.el.hidden = true;
      this.key = '';
      return;
    }
    const key = JSON.stringify(model, (k, v) => (typeof v === 'function' ? undefined : v));
    if (key === this.key) return;
    // keep an open colour picker alive while its own preview updates the model
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.type === 'color' && this.el.contains(active) && this.key) {
      const colors = model.items.filter((i): i is ToolColor => i !== 'sep' && i.kind === 'color');
      if (colors.length && key.replace(/"value":"#[0-9a-f]{6}"/gi, '') === this.key.replace(/"value":"#[0-9a-f]{6}"/gi, '')) return;
    }
    this.key = key;
    this.el.dataset.kind = model.kind;
    const head = document.createElement('div');
    head.className = 'manip-head';
    const title = document.createElement('b');
    title.textContent = model.title;
    head.append(title);
    if (model.hint) {
      const hint = document.createElement('span');
      hint.className = 'manip-hint';
      hint.textContent = model.hint;
      head.append(hint);
    }
    const row = document.createElement('div');
    row.className = 'manip-row';
    for (const item of model.items) {
      if (item === 'sep') {
        const s = document.createElement('span');
        s.className = 'manip-sep';
        row.append(s);
        continue;
      }
      if (item.kind === 'color') {
        const label = document.createElement('label');
        label.className = 'manip-color';
        label.title = item.title;
        const input = document.createElement('input');
        input.type = 'color';
        input.value = item.value;
        if (item.testid) input.dataset.testid = item.testid;
        input.addEventListener('input', () => item.onInput(input.value));
        input.addEventListener('change', () => item.onChange(input.value));
        const text = document.createElement('span');
        text.textContent = 'Recolour';
        label.append(input, text);
        row.append(label);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `small${item.on ? ' on' : ''}${item.danger ? ' danger' : ''}`;
      b.textContent = item.label;
      b.title = item.title;
      b.disabled = !!item.disabled;
      if (item.testid) b.dataset.testid = item.testid;
      b.addEventListener('click', () => item.onClick());
      row.append(b);
    }
    this.el.replaceChildren(head, row);
    this.el.hidden = false;
  }

  /**
   * Centres the toolbar above (x, y) in its parent's pixels, kept inside the parent; without room
   * above, it goes under `below` (the object's lowest screen point) instead.
   */
  place(x: number | null, y: number | null, below: number | null = null) {
    if (this.el.hidden && !this.key) return;
    if (x === null || y === null) {
      this.el.style.visibility = 'hidden';
      return;
    }
    const parent = this.el.parentElement;
    const pw = parent?.clientWidth ?? 0;
    const ph = parent?.clientHeight ?? 0;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.min(Math.max(6, x - w / 2), Math.max(6, pw - w - 6));
    let top = y - h - 14;
    if (top < 48) top = Math.min(ph - h - 6, Math.max(y, below ?? y) + 18); // no room above
    this.el.style.visibility = 'visible';
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(6, top))}px)`;
  }

  dispose() {
    this.el.remove();
  }
}
