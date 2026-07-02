import { describe, it, expect } from 'vitest';
import { isBatchExtractor, type TaskSpec, type ExtractFn, type BatchExtractor } from '../src/task.js';

// A deliberately tiny non-triage task: proves the contract compiles for a
// second consumer (routing-shaped: no negativeKind, no confidence).
interface Doc { id: string; text: string }
interface RGold { doc: string; tune: string; who: 'hand' | 'assisted' }
interface RPred { tune: string }

const routingTask: TaskSpec<Doc, RGold, RPred> = {
  kinds: ['tune-a', 'tune-b'],
  gatedKinds: ['tune-a', 'tune-b'],
  idOfGold: (g) => g.doc,
  kindOfGold: (g) => g.tune,
  provenanceOfGold: (g) => g.who,
  kindOfPred: (p) => p.tune,
};

describe('TaskSpec contract', () => {
  it('accepts a minimal task (no negativeKind/confidence/fields/labeling)', () => {
    expect(routingTask.kinds.length).toBe(2);
  });

  it('isBatchExtractor discriminates the two extractor shapes', () => {
    const fn: ExtractFn<Doc, RPred> = async () => ({ prediction: { tune: 'tune-a' } });
    const batch: BatchExtractor<Doc, RPred> = {
      batch: async (targets) => new Map(targets.map((t) => [t.id, { prediction: { tune: 'tune-a' } }])),
    };
    expect(isBatchExtractor(fn)).toBe(false);
    expect(isBatchExtractor(batch)).toBe(true);
  });
});
