import { describe, expect, it } from 'vitest';
import { UndoStack } from './undo';

describe('UndoStack', () => {
  it('undoes and redoes in order, and a new step clears the redo list', () => {
    let v = 0;
    const s = new UndoStack();
    const set = (from: number, to: number) => {
      v = to;
      s.push({ label: `to ${to}`, undo: () => (v = from), redo: () => (v = to) });
    };
    set(0, 1);
    set(1, 2);
    expect(s.undo()).toBe('to 2');
    expect(v).toBe(1);
    expect(s.redo()).toBe('to 2');
    expect(v).toBe(2);
    s.undo();
    set(1, 5);
    expect(s.canRedo).toBe(false);
    s.undo();
    s.undo();
    expect(v).toBe(0);
    expect(s.undo()).toBeNull();
  });

  it('merges nudges with the same key inside the window into one step', () => {
    let t = 0;
    let v = 0;
    const s = new UndoStack(100, () => t);
    const nudge = () => {
      const from = v;
      v += 5;
      const to = v;
      s.push({ label: 'nudge', undo: () => (v = from), redo: () => (v = to) }, { coalesce: 'maya', windowMs: 600 });
    };
    nudge();
    t = 300;
    nudge();
    t = 700;
    nudge(); // still within 600 ms of the previous nudge
    t = 2000;
    nudge(); // a new step
    expect(s.depth.undo).toBe(2);
    s.undo();
    expect(v).toBe(15);
    s.undo();
    expect(v).toBe(0);
    s.redo();
    expect(v).toBe(15);
  });

  it('never throws from a failing action and caps its length', () => {
    const s = new UndoStack(3);
    for (let i = 0; i < 5; i++)
      s.push({
        label: String(i),
        undo: () => {
          throw new Error('boom');
        },
        redo: () => Promise.reject(new Error('async boom')),
      });
    expect(s.depth.undo).toBe(3);
    expect(() => s.undo()).not.toThrow();
    expect(() => s.redo()).not.toThrow();
  });
});
