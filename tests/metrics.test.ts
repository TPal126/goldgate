// tests/metrics.test.ts
import { describe, it, expect } from 'vitest';
import {
  wilsonLower, confusionMatrix, perKindMetrics,
  pooledGatedMetrics, negativeFpRate, calibrationTable,
  tokenF1, fieldScores, checkGate, DEFAULT_GATE, type EvalItem,
} from '../src/metrics.js';
import { triageTask, type TriageGold, type TriagePred } from './fixtures/triage-task.js';
import type { TaskSpec } from '../src/task.js';

const task = triageTask;

// Only 'bug' carries structured/freetext fields in triageTask.compareFields
// (component + summary); 'feature' and 'note' compare no fields.
const pred = (kind: 'note' | 'bug' | 'feature', certainty: 'low' | 'high'): TriagePred => {
  if (kind === 'bug') return { kind, certainty, component: 'core', summary: 'crash on save' };
  return { kind, certainty };
};
const gold = (id: string, kind: 'note' | 'bug' | 'feature'): TriageGold => {
  if (kind === 'bug') return { ticketId: id, provenance: 'hand', kind, component: 'core', summary: 'crash on save' };
  return { ticketId: id, provenance: 'hand', kind };
};
const item = (
  id: string, goldKind: 'note' | 'bug' | 'feature', predKind: 'note' | 'bug' | 'feature' | null,
  certainty: 'low' | 'high' = 'high',
  stratum: 'random' | 'boosted' = 'random',
): EvalItem<TriageGold, TriagePred> => ({
  itemId: id, stratum,
  gold: gold(id, goldKind),
  predicted: predKind === null ? null : pred(predKind, certainty),
  ...(predKind === null ? { error: 'boom' } : {}),
});

describe('wilsonLower', () => {
  it('matches hand-computed values', () => {
    expect(wilsonLower(36, 40)).toBeCloseTo(0.7695, 3);
    expect(wilsonLower(54, 60)).toBeCloseTo(0.7985, 3);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('applyThreshold', () => {
  // triage has only 2 confidence levels (low/high), so there is no
  // "in-between" demotion case to port from the source pipeline's 3-level
  // (low/medium/high) scenario — RANK: low=0, high=1, so a 'low'-certainty prediction
  // is demoted at min='high' and kept at min='low'.
  it('demotes sub-threshold predictions to note', () => {
    expect(task.kindOfPred(pred('bug', 'low'), 'high')).toBe('note');
    expect(task.kindOfPred(pred('bug', 'high'), 'high')).toBe('bug');
    expect(task.kindOfPred(pred('bug', 'low'), 'low')).toBe('bug');
  });
});

describe('classification metrics', () => {
  // 10 items: 3 bugs (2 found, 1 missed), 2 features (both found, plus
  // 1 extra FP from a note), 5 notes (1 misread as a feature). Mirrors the
  // source pipeline's original 3-kind scenario 1:1 (mapped onto triage's
  // bug/feature/note) so every derived number below is unchanged from
  // that test.
  const items: EvalItem<TriageGold, TriagePred>[] = [
    item('1', 'bug', 'bug'),
    item('2', 'bug', 'bug'),
    item('3', 'bug', 'note'),
    item('4', 'feature', 'feature'),
    item('5', 'feature', 'feature'),
    item('6', 'note', 'feature'),
    item('7', 'note', 'note'),
    item('8', 'note', 'note'),
    item('9', 'note', 'note'),
    item('10', 'note', 'note'),
  ];

  it('builds the confusion matrix', () => {
    const m = confusionMatrix(items, task, 'low');
    expect(m['bug']!['bug']).toBe(2);
    expect(m['bug']!['note']).toBe(1);
    expect(m['note']!['feature']).toBe(1);
  });

  it('computes per-kind precision/recall', () => {
    const per = perKindMetrics(items, task, 'low');
    const d = per.find((k) => k.kind === 'bug')!;
    expect(d.precision).toBeCloseTo(1.0, 5);
    expect(d.recall).toBeCloseTo(2 / 3, 5);
    const c = per.find((k) => k.kind === 'feature')!;
    expect(c.precision).toBeCloseTo(2 / 3, 5);
    expect(c.recall).toBeCloseTo(1.0, 5);
  });

  it('computes pooled gated metrics (bug+feature micro-averaged)', () => {
    const p = pooledGatedMetrics(items, task, 'low');
    expect(p.predictedPositives).toBe(5); // 2 bug + 3 feature predictions
    expect(p.precision).toBeCloseTo(4 / 5, 5);
    expect(p.recall).toBeCloseTo(4 / 5, 5); // 4 of 5 gold gated items found
  });

  it('computes negative-kind FP rate on the given items', () => {
    // 5 gold notes, 1 predicted as a gated kind -> 20%
    expect(negativeFpRate(items, task, 'low')).toBeCloseTo(0.2, 5);
  });

  it('excludes errored items from metrics but counts them', () => {
    const withError = [...items, item('11', 'bug', null)];
    const p = pooledGatedMetrics(withError, task, 'low');
    expect(p.errored).toBe(1);
    expect(p.precision).toBeCloseTo(4 / 5, 5); // unchanged by the errored item
  });

  it('negativeFpRate enforces the random-stratum filter itself', () => {
    // A boosted gold-note misread as a gated kind must NOT move the rate.
    const withBoostedFp = [...items, item('12', 'note', 'bug', 'high', 'boosted')];
    expect(negativeFpRate(withBoostedFp, task, 'low')).toBeCloseTo(0.2, 5);
  });
});

describe('calibrationTable', () => {
  it('reports observed precision per confidence level', () => {
    // Same shape as the source pipeline's 3-item scenario, but it only
    // ever exercised 'high' and 'low' confidences there (never 'medium'), so
    // dropping to triage's 2-level confidenceLevels changes nothing about
    // the arithmetic: high = {item1 correct, item2 wrong} -> 1/2 = 0.5;
    // low = {item3 correct} -> 1/1 = 1.0.
    const items: EvalItem<TriageGold, TriagePred>[] = [
      item('1', 'bug', 'bug', 'high'),
      item('2', 'note', 'bug', 'high'),
      item('3', 'feature', 'feature', 'low'),
    ];
    const t = calibrationTable(items, task)!;
    expect(t.find((r) => r.confidence === 'high')!.observedPrecision).toBeCloseTo(0.5, 5);
    expect(t.find((r) => r.confidence === 'low')!.observedPrecision).toBeCloseTo(1.0, 5);
  });
});

describe('field scoring', () => {
  it('tokenF1 rewards overlap', () => {
    expect(tokenF1('ship the fix by friday', 'ship the fix')).toBeGreaterThan(0.7);
    expect(tokenF1('ship the fix', 'review the design')).toBeLessThan(0.4);
  });

  it('scores structured fields exact-match on true positives', () => {
    // Only 'bug' has compareFields in triageTask (component structured,
    // summary freetext), so both items here are bugs (unlike the source
    // pipeline's two-field pair) — each contributes one structured comparison.
    const items: EvalItem<TriageGold, TriagePred>[] = [
      item('1', 'bug', 'bug'), // component matches ('core')
      item('2', 'bug', 'bug'), // component matches ('core')
    ];
    const s = fieldScores(items, task, 'low')!;
    expect(s.structuredExactMatch).toBeCloseTo(1.0, 5);
    expect(s.comparisons).toBeGreaterThan(0);
  });
});

describe('checkGate', () => {
  it('fails on undersized denominator', () => {
    const r = checkGate({
      pooledPrecision: 0.95, pooledPrecisionWilsonLower: 0.85, pooledRecall: 0.7,
      predictedPositives: 12, negativeFpRate: 0.02, structuredExactMatch: 0.9,
    }, task);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/denominator/i);
  });

  it('passes when all criteria hold', () => {
    const r = checkGate({
      pooledPrecision: 0.93, pooledPrecisionWilsonLower: 0.84, pooledRecall: 0.66,
      predictedPositives: 70, negativeFpRate: 0.03, structuredExactMatch: 0.9,
    }, task);
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('per-criterion gate skipping (spec: gate criteria are per-criterion optional)', () => {
  const minimalTask: TaskSpec<{ id: string; text: string }, { doc: string; tune: string; who: 'hand' | 'assisted' }, { tune: string }> = {
    kinds: ['tune-a', 'tune-b'],
    gatedKinds: ['tune-a', 'tune-b'],
    idOfGold: (g) => g.doc,
    kindOfGold: (g) => g.tune,
    provenanceOfGold: (g) => g.who,
    kindOfPred: (p) => p.tune,
  };

  it('negativeFpRate is null without a negativeKind', () => {
    expect(negativeFpRate([], minimalTask)).toBeNull();
  });

  it('calibrationTable is null without confidenceOfPred', () => {
    expect(calibrationTable([], minimalTask)).toBeNull();
  });

  it('fieldScores is null without compareFields', () => {
    expect(fieldScores([], minimalTask)).toBeNull();
  });

  it('a compareFields-less task is not failed on a vacuous structured-exact-match', () => {
    const r = checkGate({
      pooledPrecision: 0.95, pooledPrecisionWilsonLower: 0.85, pooledRecall: 0.7,
      predictedPositives: 70, negativeFpRate: null, structuredExactMatch: null,
    }, minimalTask);
    expect(r.pass).toBe(true);
  });

  it('task.gate overrides merge over DEFAULT_GATE', () => {
    const strict = { ...minimalTask, gate: { minPooledRecall: 0.99 } };
    const r = checkGate({
      pooledPrecision: 0.95, pooledPrecisionWilsonLower: 0.85, pooledRecall: 0.7,
      predictedPositives: 70, negativeFpRate: null, structuredExactMatch: null,
    }, strict);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toContain('recall');
    expect(DEFAULT_GATE.minPooledRecall).toBe(0.6);
  });
});
