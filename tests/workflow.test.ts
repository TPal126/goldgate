import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workflowPath, readWorkflow, appendWorkflowEvent,
  currentRound, latestFreeze, holdoutEvalsInRound,
  checkHoldoutRun, buildFreezeEvent, buildDecisionEvent, deriveStatus,
} from '../src/workflow.js';
import type { WorkflowEvent } from '../src/workflow.js';
import { defineConfig } from '../src/config.js';
import type { GoldgateConfig } from '../src/config.js';
import type { SampleItem } from '../src/sample.js';
import { triageTask, type TriageGold } from './fixtures/triage-task.js';

const AT = '2026-07-02T12:00:00.000Z';

const config = defineConfig({
  task: triageTask,
  extractors: {
    echo: () => async () => ({ prediction: { kind: 'note' as const, certainty: 'high' as const } }),
    batchy: () => ({ batch: async () => new Map() }),
  },
  paths: { corpus: 'c.jsonl', labels: 'l.jsonl', sample: 'work/s.jsonl', outDir: 'runs' },
  defaultModel: 'stub',
}) as unknown as GoldgateConfig;

const freezeEvent = (round: number, over?: Record<string, unknown>): WorkflowEvent => ({
  at: AT, type: 'freeze', round,
  frozen: { extractor: 'echo', model: 'stub', contextWindow: 10, mode: 'sync', ...over },
});

describe('workflowPath', () => {
  it('defaults to a workflow.jsonl sibling of the sample file', () => {
    expect(workflowPath({ sample: join('work', 's.jsonl') })).toBe(join('work', 'workflow.jsonl'));
    expect(workflowPath({ sample: 'work/s.jsonl', workflow: 'elsewhere.jsonl' })).toBe('elsewhere.jsonl');
  });
});

describe('event log persistence', () => {
  const path = join(tmpdir(), `goldgate-wf-${process.pid}.jsonl`);
  afterAll(() => rmSync(path, { force: true }));

  it('reads an empty log when the file is absent and round-trips appends', () => {
    expect(existsSync(path)).toBe(false);
    expect(readWorkflow(path)).toEqual([]);
    const ev = freezeEvent(1);
    appendWorkflowEvent(path, ev);
    appendWorkflowEvent(path, { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false });
    const events = readWorkflow(path);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(ev);
  });
});

describe('checkHoldoutRun (the seal)', () => {
  const run = { extractor: 'echo', model: 'stub', contextWindow: 10, mode: 'sync' as const };

  it('refuses with no freeze, unless --allow-unfrozen (then recorded as unfrozen)', () => {
    const refused = checkHoldoutRun([], run, false);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(' ')).toMatch(/no frozen configuration/);

    const allowed = checkHoldoutRun([], run, true);
    expect(allowed).toMatchObject({ ok: true, round: null, unfrozen: true, repeat: false });
  });

  it('passes a run matching the frozen configuration', () => {
    const v = checkHoldoutRun([freezeEvent(1)], run, false);
    expect(v).toMatchObject({ ok: true, round: 1, repeat: false, unfrozen: false, warnings: [] });
  });

  it('refuses any configuration drift field-by-field', () => {
    for (const drift of [
      { ...run, model: 'other' },
      { ...run, extractor: 'batchy' },
      { ...run, contextWindow: 0 },
      { ...run, mode: 'batch' as const },
      { ...run, effort: 'high' },
    ]) {
      const v = checkHoldoutRun([freezeEvent(1)], drift, false);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reasons.join(' ')).toMatch(/differs from round 1 freeze/);
    }
  });

  it('drift + allowUnfrozen proceeds but is flagged unfrozen', () => {
    const v = checkHoldoutRun([freezeEvent(1)], { ...run, model: 'other' }, true);
    expect(v).toMatchObject({ ok: true, unfrozen: true });
    if (v.ok) expect(v.warnings.join(' ')).toMatch(/recorded as unfrozen/);
  });

  it('treats configHashes as part of the seal (drift refused, match allowed)', () => {
    const frozen = freezeEvent(1, { configHashes: { promptHash: 'X', schemaHash: 'S' } });
    // same hashes, order-independent → passes
    expect(checkHoldoutRun([frozen], { ...run, configHashes: { schemaHash: 'S', promptHash: 'X' } }, false).ok).toBe(true);
    // a changed prompt hash is drift
    const drift = checkHoldoutRun([frozen], { ...run, configHashes: { promptHash: 'Y', schemaHash: 'S' } }, false);
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.reasons.join(' ')).toMatch(/config hashes/);
    // dropping a hash entirely is drift too
    expect(checkHoldoutRun([frozen], { ...run, configHashes: { promptHash: 'X' } }, false).ok).toBe(false);
  });

  it('flags repeat holdout evals within a round', () => {
    const events: WorkflowEvent[] = [
      freezeEvent(1),
      { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false },
    ];
    const v = checkHoldoutRun(events, run, false);
    expect(v).toMatchObject({ ok: true, repeat: true });
    if (v.ok) expect(v.warnings.join(' ')).toMatch(/already evaluated 1 time/);
  });

  it('a new round resets the repeat flag', () => {
    const events: WorkflowEvent[] = [
      freezeEvent(1),
      { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false },
      freezeEvent(2),
    ];
    expect(checkHoldoutRun(events, run, false)).toMatchObject({ ok: true, round: 2, repeat: false });
  });
});

describe('buildFreezeEvent', () => {
  it('starts round n+1 and derives mode from the extractor shape', () => {
    const e1 = buildFreezeEvent(config, [], { extractor: 'echo', model: 'stub', contextWindow: 10 }, AT);
    expect(e1).toMatchObject({ type: 'freeze', round: 1, frozen: { mode: 'sync' } });
    const e2 = buildFreezeEvent(config, [e1], { extractor: 'batchy', model: 'stub', contextWindow: 10 }, AT);
    expect(e2).toMatchObject({ round: 2, frozen: { mode: 'batch' } });
  });

  it('rejects unknown extractors and thresholds outside confidenceLevels', () => {
    expect(() => buildFreezeEvent(config, [], { extractor: 'nope', model: 'stub', contextWindow: 10 }, AT))
      .toThrow(/unknown extractor/);
    expect(() => buildFreezeEvent(config, [], { extractor: 'echo', model: 'stub', contextWindow: 10, threshold: 'huge' }, AT))
      .toThrow(/confidenceLevels/);
    const ok = buildFreezeEvent(config, [], { extractor: 'echo', model: 'stub', contextWindow: 10, threshold: 'high' }, AT);
    expect(ok.frozen.threshold).toBe('high');
  });

  it('refuses a NaN/negative context window (would poison the append-only log)', () => {
    expect(() => buildFreezeEvent(config, [], { extractor: 'echo', model: 'stub', contextWindow: NaN }, AT))
      .toThrow(/non-negative integer/);
    expect(() => buildFreezeEvent(config, [], { extractor: 'echo', model: 'stub', contextWindow: -1 }, AT))
      .toThrow(/non-negative integer/);
  });
});

describe('buildDecisionEvent', () => {
  it('refuses without a holdout eval in the current round', () => {
    expect(() => buildDecisionEvent([freezeEvent(1)], { ship: true }, AT))
      .toThrow(/no holdout eval/);
  });

  it('ties itself to the round and its FIRST completed gate run (not a later repeat)', () => {
    const events: WorkflowEvent[] = [
      freezeEvent(1),
      { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false },
      { at: AT, type: 'holdout-eval', round: 1, runId: 'r2', gate: null, repeat: true },
    ];
    // r1 is the gate — a passing repeat r2 must not be able to launder it.
    expect(buildDecisionEvent(events, { ship: false, note: 'precision short' }, AT))
      .toMatchObject({ type: 'decision', round: 1, runId: 'r1', ship: false, note: 'precision short' });
  });
});

describe('deriveStatus', () => {
  const sample: SampleItem[] = [
    { itemId: 'a', stratum: 'random', split: 'dev' },
    { itemId: 'b', stratum: 'boosted', split: 'dev' },
    { itemId: 'c', stratum: 'random', split: 'holdout' },
  ];
  const gold = (id: string, provenance: 'hand' | 'assisted' = 'hand'): TriageGold =>
    ({ ticketId: id, provenance, kind: 'note' });
  const status = (events: WorkflowEvent[], labels: TriageGold[], s: SampleItem[] = sample) =>
    deriveStatus({ events, sample: s, labels, task: triageTask });

  it('walks the stage ladder', () => {
    expect(status([], [], []).stage).toBe('sample');
    expect(status([], []).stage).toBe('label-dev');
    expect(status([], [gold('a', 'assisted')]).stage).toBe('dev');
    expect(status([freezeEvent(1)], [gold('a')]).stage).toBe('label-holdout');
    expect(status([freezeEvent(1)], [gold('a'), gold('c')]).stage).toBe('holdout-eval');
    const evald: WorkflowEvent[] = [freezeEvent(1), { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false }];
    expect(status(evald, [gold('a'), gold('c')]).stage).toBe('decide');
    const decided: WorkflowEvent[] = [...evald, { at: AT, type: 'decision', round: 1, runId: 'r1', ship: true }];
    expect(status(decided, [gold('a'), gold('c')]).stage).toBe('done');
  });

  it('counts split progress with provenance breakdown', () => {
    const s = status([], [gold('a'), gold('b', 'assisted')]);
    expect(s.dev).toEqual({ total: 2, labeled: 2, pending: 0, hand: 1, assisted: 1 });
    expect(s.holdout).toEqual({ total: 1, labeled: 0, pending: 1, hand: 0, assisted: 0 });
    expect(s.round).toBe(0);
    expect(s.frozen).toBeNull();
  });

  it('re-freezing after a decision starts a fresh round (stage leaves done)', () => {
    const events: WorkflowEvent[] = [
      freezeEvent(1),
      { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false },
      { at: AT, type: 'decision', round: 1, runId: 'r1', ship: false },
      freezeEvent(2),
    ];
    const s = status(events, [gold('a'), gold('c')]);
    expect(s.stage).toBe('holdout-eval');
    expect(s.round).toBe(2);
    expect(s.holdoutEvalsThisRound).toBe(0);
  });
});

describe('event-log queries', () => {
  it('currentRound / latestFreeze / holdoutEvalsInRound', () => {
    const events: WorkflowEvent[] = [
      freezeEvent(1),
      { at: AT, type: 'holdout-eval', round: 1, runId: 'r1', gate: null, repeat: false },
      freezeEvent(2, { model: 'stub2' }),
    ];
    expect(currentRound(events)).toBe(2);
    expect(latestFreeze(events)?.frozen.model).toBe('stub2');
    expect(holdoutEvalsInRound(events, 1)).toHaveLength(1);
    expect(holdoutEvalsInRound(events, 2)).toHaveLength(0);
  });
});
