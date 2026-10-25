// The frame guide: while a shot is selected the viewport shows the shot's frame (16:9, or 2.39:1
// for scope) as the largest rect of that aspect centred in the canvas, with the rest matted, and a
// label in its bottom-left corner ("1B · Over Leo's shoulder · 50 mm").
//
// A shot stores the vertical field of view of its frame (Shot.fovDeg: what the phone renders at its
// landscape aspect). The canvas is usually a different shape, so the viewport camera at a selected
// shot opens wider than the shot, by exactly the amount that puts the shot's frame inside the
// guide: tan(view / 2) = tan(shot / 2) · canvas height / guide height. Inside the guide is the
// shot; the matte around it is what the operator would see just outside the frame. Adding the
// current view as a shot runs the same relation backwards (the guide's crop of the view).

/** The guide's aspects: 16:9 (HD, the phone's frame) and 2.39:1 (scope). */
export type GuideAspect = '16:9' | '2.39';
export const GUIDE_ASPECT: Record<GuideAspect, number> = { '16:9': 16 / 9, '2.39': 2.39 };

export interface GuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEG = Math.PI / 180;

/** The largest rect of `aspect` (width / height) centred in a `width` × `height` canvas (CSS px). */
export function guideRect(width: number, height: number, aspect: number): GuideRect {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let gw = w;
  let gh = w / aspect;
  if (gh > h) {
    gh = h;
    gw = h * aspect;
  }
  return { x: (w - gw) / 2, y: (h - gh) / 2, width: gw, height: gh };
}

/** Vertical FOV the viewport camera needs so a guide `guideH` px tall (of `canvasH`) spans `shotFov`. */
export function viewFovForShot(shotFov: number, canvasH: number, guideH: number): number {
  const t = Math.tan((shotFov * DEG) / 2) * (Math.max(1, canvasH) / Math.max(1, guideH));
  return Math.min(150, (2 * Math.atan(t)) / DEG);
}

/** The shot's vertical FOV when the guide (`guideH` px of `canvasH`) is cut from a `viewFov` view. */
export function shotFovForView(viewFov: number, canvasH: number, guideH: number): number {
  const t = Math.tan((viewFov * DEG) / 2) * (Math.max(1, guideH) / Math.max(1, canvasH));
  return (2 * Math.atan(t)) / DEG;
}

/**
 * The matte + label over the viewport (DOM, so takes and frame grabs never include it): four plain
 * bars around the guide (cheap to composite over a canvas that redraws every frame) and the frame's
 * hairline with the label inside it.
 */
export class FrameGuide {
  readonly el: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly bars: HTMLDivElement[];
  private readonly label: HTMLSpanElement;
  private key = '';

  constructor(stage: HTMLElement) {
    const div = (cls: string) => {
      const d = document.createElement('div');
      d.className = cls;
      return d;
    };
    this.el = div('frame-guide');
    this.el.dataset.testid = 'frame-guide';
    this.el.hidden = true;
    this.bars = [div('frame-matte'), div('frame-matte'), div('frame-matte'), div('frame-matte')];
    this.frame = div('frame-guide-frame');
    this.label = document.createElement('span');
    this.label.className = 'vp-label frame-guide-label';
    this.label.dataset.testid = 'shot-label';
    this.frame.append(this.label);
    this.el.append(...this.bars, this.frame);
    stage.append(this.el);
  }

  show(rect: GuideRect, label: string, aspect: GuideAspect) {
    const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
    if (key !== this.key) {
      this.key = key;
      const px = (v: number) => `${Math.max(0, v)}px`;
      const place = (d: HTMLDivElement, l: string, t: string, w: string, h: string) => Object.assign(d.style, { left: l, top: t, width: w, height: h });
      const [top, bottom, left, right] = this.bars as [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement];
      place(top, '0', '0', '100%', px(rect.y));
      place(bottom, '0', px(rect.y + rect.height), '100%', `calc(100% - ${px(rect.y + rect.height)})`);
      place(left, '0', px(rect.y), px(rect.x), px(rect.height));
      place(right, px(rect.x + rect.width), px(rect.y), `calc(100% - ${px(rect.x + rect.width)})`, px(rect.height));
      place(this.frame, px(rect.x), px(rect.y), px(rect.width), px(rect.height));
    }
    this.el.dataset.aspect = aspect;
    if (this.label.textContent !== label) this.label.textContent = label;
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }

  get visible() {
    return !this.el.hidden;
  }

  get text() {
    return this.label.textContent ?? '';
  }
}
