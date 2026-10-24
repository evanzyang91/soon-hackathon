import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mockPlan } from '../../../server/pipeline/fountain.ts';
import { fitWithin, pngName } from './chat-client';
import { hintLabel, patchDiff, planSummary, scriptOutline, targetOptions } from './chat-model';

const FIXTURE = readFileSync(
  new URL('../../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);

describe('chat helpers', () => {
  it('offers every character and scene as an attachment target, before and after the plan', () => {
    expect(targetOptions(mockPlan(FIXTURE)).map((o) => o.value)).toEqual([
      '',
      'character:theo',
      'character:maya',
      'scene:0',
      'scene:1',
      'scene:2',
    ]);
    // the first message: cue names from the text (the server resolves names as well as ids)
    expect(scriptOutline(FIXTURE)).toEqual({
      characters: ['THEO', 'MAYA'],
      headings: ['EXT. CITY STREET - NIGHT', 'INT. KITCHEN - MORNING', 'EXT. ROOFTOP - DUSK'],
    });
    // scene hints carry the 0-based index, labelled with the director's 1-based number
    expect(targetOptions(null, FIXTURE)[3]).toEqual({
      value: 'scene:0',
      label: 'Scene 1 · EXT. CITY STREET - NIGHT',
      group: 'scene',
    });
    expect(hintLabel('scene:1', null)).toBe('Scene 2');
    expect(targetOptions(null, FIXTURE)[1]).toEqual({
      value: 'character:theo',
      label: 'Theo',
      group: 'character',
    });
  });

  it('summarises the plan and a patch', () => {
    expect(planSummary(mockPlan(FIXTURE))).toBe('Planned 3 scenes and 2 characters: Theo, Maya.');
    const base = {
      type: 'plan-patch' as const,
      id: 'a',
      target: 'character:theo',
      summary: '',
      status: 'applied' as const,
    };
    expect(patchDiff({ ...base, field: 'heightMeters', before: 1.7, after: 1.8 })).toBe(
      '1.70 m → 1.80 m',
    );
    expect(
      patchDiff({ ...base, field: 'description', before: 'x', after: 'y'.repeat(80) }),
    ).toBeNull();
  });

  it('fits uploads within 1600 px on the long side and names them .png', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(pngName('Kitchen photo.JPEG')).toBe('Kitchen photo.png');
    expect(pngName(undefined)).toBe('image.png');
  });
});
