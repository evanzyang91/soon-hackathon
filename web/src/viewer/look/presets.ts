// Look presets: the seven LUTs (one control) and four complete looks. A full-look preset replaces
// the grade, film and atmosphere settings but keeps the scene's lights and lens (dof), which are
// set up per scene, not per mood.
import { Look } from '@shared/look';

type Lut = Look['lut'];

export const LUT_LABELS: Record<Lut, string> = {
  neutral: 'Neutral',
  'teal-orange': 'Teal & orange',
  noir: 'Noir',
  kodak: 'Kodak print',
  bleach: 'Bleach bypass',
  'cool-night': 'Cool night',
  golden: 'Golden hour',
};

/** Grade / film / atmosphere fields a full-look preset sets (everything except lights and lens). */
export type LookMood = Omit<Look, 'lights' | 'dof'>;

const mood = (m: Partial<LookMood> & { name: string }): LookMood => {
  const { lights: _l, dof: _d, ...base } = Look.parse({});
  return { ...base, ...m, fog: { ...base.fog, ...m.fog }, skyTint: { ...base.skyTint, ...m.skyTint } };
};

export const FULL_PRESETS: LookMood[] = [
  mood({
    name: 'Daylight neutral',
    exposure: 0.1,
    contrast: 1.05,
    saturation: 1.05,
    temperature: 0.05,
    vignette: 0.1,
    grain: 0.05,
    bloom: 0.1,
  }),
  mood({
    name: 'Night street',
    exposure: -0.4,
    contrast: 1.15,
    saturation: 0.85,
    temperature: -0.35,
    tint: 0.05,
    shadows: -0.1,
    highlights: 0.15,
    lut: 'cool-night',
    lutStrength: 0.7,
    vignette: 0.35,
    grain: 0.2,
    bloom: 0.45,
    fog: { color: '#2a3550', density: 0.15 },
    skyTint: { color: '#3b4a7a', strength: 0.3 },
    ambient: 0.85,
  }),
  mood({
    name: 'Warm interior',
    exposure: 0.15,
    contrast: 1.05,
    saturation: 1.08,
    temperature: 0.4,
    tint: 0.05,
    shadows: 0.15,
    highlights: -0.1,
    lut: 'kodak',
    lutStrength: 0.6,
    vignette: 0.25,
    grain: 0.12,
    bloom: 0.25,
  }),
  mood({
    name: 'Overcast',
    exposure: 0.05,
    contrast: 0.88,
    saturation: 0.8,
    temperature: -0.12,
    shadows: 0.2,
    highlights: -0.25,
    lut: 'bleach',
    lutStrength: 0.25,
    vignette: 0.12,
    grain: 0.08,
    bloom: 0.05,
    fog: { color: '#b4bcc4', density: 0.12 },
    skyTint: { color: '#c8ced6', strength: 0.35 },
  }),
];

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
