// Stable per-character tint (css hex), shared by server/pipeline/actors.ts and the browser so a
// fallback actor keeps its colour whether or not the manifest carries `tint`. Pure.

/** FNV-1a of the id -> hue; fixed saturation/lightness so every tint reads on splat worlds. */
export function tintFor(id: string): string {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return hslHex(h % 360, 0.55, 0.52);
}

export function hslHex(hueDeg: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hueDeg / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
