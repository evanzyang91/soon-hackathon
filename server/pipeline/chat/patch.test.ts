// Style and scene look patches: what the chat (Claude or the keyword planner) may write into the plan.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOOK_PRESETS } from '../../../shared/look-presets.ts';
import { ScreenplayPlan } from '../../../shared/schema.ts';
import { mockPlan } from '../fountain.ts';
import { applyPatch, checkPatch, effectOf, getValue, type Patch } from './patch.ts';

const PLAN = ScreenplayPlan.parse(
  mockPlan(readFileSync(new URL('../../../fixtures/screenplay.fountain', import.meta.url), 'utf8')),
);
const ok = (plan: ScreenplayPlan, target: string, field: string, value: string): Patch => {
  const p = checkPatch(plan, target, field, value);
  if ('error' in p) throw new Error(p.error);
  return p;
};
const err = (target: string, field: string, value: string) => {
  const p = checkPatch(PLAN, target, field, value);
  return 'error' in p ? p.error : undefined;
};

describe('style and look patches', () => {
  it('style fields are free and keep the rest of the style', () => {
    const plan = structuredClone(PLAN);
    const p = ok(plan, 'style', 'genre', 'neo-noir thriller');
    expect(p.targetKey).toBe('style');
    expect(effectOf(p)).toBe('none');
    expect(applyPatch(plan, p)).toEqual({
      before: 'contemporary drama',
      after: 'neo-noir thriller',
    });
    expect(plan.style).toEqual({ ...PLAN.style, genre: 'neo-noir thriller' });
    expect(err('style', 'genre', '')).toMatch(/cannot be empty/);
    expect(err('style', 'mood', 'x')).toMatch(/no field mood/);
  });

  it('a style patch on a plan without a style starts from the one read from the script', () => {
    const { style: _s, ...rest } = structuredClone(PLAN);
    const plan = ScreenplayPlan.parse(rest);
    applyPatch(plan, ok(plan, 'style', 'palette', 'neon pink, wet black'));
    expect(plan.style).toMatchObject({
      genre: 'contemporary drama',
      palette: 'neon pink, wet black',
    });
  });

  it('look fields: names by label, hex colours, ranges; a look is "look" (free), not "world"', () => {
    expect(ok(PLAN, 'scene:0', 'look.preset', 'Golden hour').value).toBe('golden-hour');
    expect(ok(PLAN, 'scene:0', 'look.lut', 'Cool night').value).toBe('cool-night');
    expect(ok(PLAN, 'scene:0', 'look.fog.color', 'ABC').value).toBe('#aabbcc');
    expect(ok(PLAN, 'scene:0', 'look.temperature', '-0.45').value).toBe(-0.45);
    expect(effectOf(ok(PLAN, 'scene:0', 'look.exposure', '0.3'))).toBe('look');
    expect(err('scene:0', 'look.preset', 'sparkly')).toMatch(/unknown look preset/);
    expect(err('scene:0', 'look.temperature', '4')).toMatch(/outside -1…1/);
    expect(err('scene:0', 'look.fog.color', 'grey')).toMatch(/not a colour/);
    expect(err('scene:0', 'look.flare', '1')).toMatch(/no field look\.flare/);
  });

  it('a new preset keeps the mood words and drops adjustments tuned to the old one', () => {
    const plan = structuredClone(PLAN);
    plan.scenes[0]!.look = { preset: 'night-street', mood: 'wet, sodium-lit', exposure: -0.8 };
    applyPatch(plan, ok(plan, 'scene:0', 'look.preset', 'moonlit'));
    expect(plan.scenes[0]!.look).toEqual({ preset: 'moonlit', mood: 'wet, sodium-lit' });
  });

  it("numbers read the preset's value until set; fog starts from the preset's fog", () => {
    const plan = structuredClone(PLAN);
    const temp = { target: { kind: 'scene', index: 1 }, field: 'look.temperature' } as const;
    expect(getValue(plan, temp)).toBe(LOOK_PRESETS['warm-interior'].temperature);
    applyPatch(plan, ok(plan, 'scene:1', 'look.fog.density', '0.3'));
    expect(plan.scenes[1]!.look!.fog).toEqual({
      color: LOOK_PRESETS['warm-interior'].fog.color,
      density: 0.3,
    });
  });

  it('a scene without a planned look is patched from its derived one', () => {
    const plan = structuredClone(PLAN);
    delete plan.scenes[2]!.look;
    applyPatch(plan, ok(plan, 'scene:2', 'look.mood', 'hazy, tender'));
    expect(plan.scenes[2]!.look).toEqual({ preset: 'golden-hour', mood: 'hazy, tender' });
  });
});
