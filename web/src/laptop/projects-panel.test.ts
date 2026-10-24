import { describe, expect, it } from 'vitest';
import type { ActorBuildStatus } from '@shared/schema';
import { scaleHeadline } from './hud';
import { HIGH_DETAIL_LABEL, HIGH_DETAIL_TIP, displayName, rebuildChip } from './projects-panel';

const leo: ActorBuildStatus = { characterId: 'leo', name: 'LEO', detail: 'standard', kind: 'splat-sequence' };

describe('actor rows', () => {
  it('says what the button does and costs', () => {
    expect(HIGH_DETAIL_LABEL).toBe('High detail (~5 min per actor)');
    expect(HIGH_DETAIL_TIP).toBe(
      'LHM-1B + fine-tune against the reference. About 5 minutes and ~$0.20 per actor on Modal; the current build stays until the new one lands.',
    );
  });

  it('title-cases screenplay names', () => {
    expect(displayName('LEO')).toBe('Leo');
    expect(displayName('MR. SMITH')).toBe('Mr. Smith');
    expect(displayName("MARY-JANE O'NEIL")).toBe("Mary-Jane O'Neil");
  });

  it('shows a running rebuild with its elapsed time, then the outcome', () => {
    expect(rebuildChip(leo)).toBeNull();
    const startedAt = '2026-10-24T12:00:00.000Z';
    const running = { ...leo, rebuild: { detail: 'high' as const, status: 'running' as const, note: 'queued', startedAt } };
    expect(rebuildChip(running, Date.parse(startedAt) + 83_000)).toEqual({
      cls: 'running',
      text: 'rebuilding Leo · ~5 min · 1:23',
      title: 'queued',
    });
    const done = { ...leo, detail: 'high' as const, rebuild: { ...running.rebuild, status: 'done' as const, note: 'high detail ✓ in 4m 52s' } };
    expect(rebuildChip(done)).toEqual({ cls: 'done', text: 'high detail ✓', title: 'high detail ✓ in 4m 52s' });
    const failed = { ...leo, rebuild: { ...running.rebuild, status: 'failed' as const, note: 'CUDA out of memory' } };
    expect(rebuildChip(failed)).toMatchObject({ cls: 'failed', text: 'high detail failed', title: 'CUDA out of memory' });
  });
});

describe('HUD scale label', () => {
  const cal = { factor: 1, method: 'none', confidence: 'low' as const, evidence: 'unverified · collider at Marble scale: …' };
  it('uses the calibration headline, else the evidence lead', () => {
    expect(scaleHeadline({ ...cal, headline: 'door 2.04 m' })).toBe('door 2.04 m');
    expect(scaleHeadline(cal)).toBe('unverified');
  });
});
