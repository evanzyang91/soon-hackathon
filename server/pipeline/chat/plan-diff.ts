// What a plan amendment changed, as readable paths ("characters.theo.heightMeters: 1.7 → 1.8").
// Characters and lines are keyed by id, scenes by index, so a diff names what the director named.
import type { ScreenplayPlan } from '../../../shared/schema.ts';

const show = (v: unknown) => {
  if (v === undefined) return '∅';
  const s = JSON.stringify(v);
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
};

function walk(path: string, a: unknown, b: unknown, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed = (x: unknown) =>
      isObj(x) && typeof x.id === 'string'
        ? x.id
        : isObj(x) && typeof x.characterId === 'string'
          ? x.characterId
          : undefined;
    if (a.every((x) => keyed(x)) && b.every((x) => keyed(x))) {
      const ka = new Map(a.map((x) => [keyed(x)!, x]));
      const kb = new Map(b.map((x) => [keyed(x)!, x]));
      for (const k of new Set([...ka.keys(), ...kb.keys()]))
        walk(`${path}.${k}`, ka.get(k), kb.get(k), out);
      return;
    }
    if (a.length === b.length && a.every(isObj)) {
      a.forEach((x, i) => walk(`${path}.${i}`, x, b[i], out));
      return;
    }
  } else if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      walk(path ? `${path}.${k}` : k, a[k], b[k], out);
    return;
  }
  out.push(`${path}: ${show(a)} → ${show(b)}`);
}

export function planDiff(before: ScreenplayPlan, after: ScreenplayPlan): string[] {
  const out: string[] = [];
  walk('', before, after, out);
  return out;
}
