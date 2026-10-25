// Look presets: the twelve LUTs (one control) and the eighteen full looks of
// shared/look-presets.ts, which the planner's LookSeed names too. A full-look preset replaces the
// grade, film and atmosphere settings but keeps the scene's lights and lens (dof), which are set
// up per scene, not per mood.
import { Look } from '@shared/look';
import {
  LOOK_PRESET_GROUPS,
  LOOK_PRESET_LABELS,
  LOOK_PRESETS,
  presetLook,
  seedToLook,
  type LookMood,
} from '@shared/look-presets';
import type { LookPresetName } from '@shared/schema';

export { LOOK_PRESET_GROUPS, LOOK_PRESET_LABELS, LOOK_PRESETS, presetLook, seedToLook };
export type { LookMood, LookPresetName };

type Lut = Look['lut'];

export const LUT_LABELS: Record<Lut, string> = {
  neutral: 'Neutral',
  'teal-orange': 'Teal & orange',
  noir: 'Noir',
  kodak: 'Kodak print',
  bleach: 'Bleach bypass',
  'cool-night': 'Cool night',
  golden: 'Golden hour',
  sepia: 'Sepia print',
  verdant: 'Verdant',
  cyber: 'Cyber neon',
  ice: 'Ice',
  ember: 'Ember',
};

/** Every preset name in the Look panel's order (group by group). */
export const PRESET_ORDER: LookPresetName[] = LOOK_PRESET_GROUPS.flatMap((g) => g.presets);

/** The full-look presets as moods, in the panel's order (built from the shared table). */
export const FULL_PRESETS: LookMood[] = PRESET_ORDER.map((n) => LOOK_PRESETS[n]);

/** Applies a full-look preset, keeping `look`'s lights and lens. */
export function applyFullPreset(look: Look, preset: LookMood): Look {
  return Look.parse({ ...structuredClone(preset), lights: look.lights, dof: look.dof });
}

/** Applies a LUT preset at full strength (the rest of the look is untouched). */
export function applyLutPreset(look: Look, lut: Lut): Look {
  return { ...look, lut, lutStrength: lut === 'neutral' ? look.lutStrength : 1 };
}

// ---- reset per group ---------------------------------------------------------------------------

export type LookGroup = 'grade' | 'film' | 'atmosphere' | 'lens' | 'lights';
export const GROUP_FIELDS: Record<LookGroup, (keyof Look)[]> = {
  grade: ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'shadows', 'highlights'],
  film: ['lut', 'lutStrength', 'vignette', 'grain', 'bloom'],
  atmosphere: ['fog', 'skyTint'],
  lens: ['dof'],
  lights: ['lights', 'ambient'],
};

/** `look` with one group's fields back at their defaults. */
export function resetGroup(look: Look, group: LookGroup): Look {
  const d = Look.parse({}) as Record<string, unknown>;
  const out = structuredClone(look) as Record<string, unknown>;
  for (const k of GROUP_FIELDS[group]) out[k] = structuredClone(d[k]);
  return Look.parse(out);
}
