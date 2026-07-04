import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuns, readRun, isSafeRunId } from '../src/runs.js';

const outDir = join(tmpdir(), `goldgate-runs-test-${process.pid}`);

function fakeResults(runId: string, split: string, pass: boolean): unknown {
  return {
    config: {
      runId, split, extractor: 'echo', model: 'stub', contextWindow: 10,
      effort: '(n/a)', mode: 'sync', itemCount: 5, itemsSampledForSplit: 5, itemsSkipped: 0,
    },
    perThreshold: [{
      threshold: 'low',
      perKind: [],
      pooled: { tp: 4, fp: 1, fn: 0, predictedPositives: 5, precision: 0.8, precisionWilsonLower: 0.376, recall: 1, errored: 1 },
      confusion: {},
      negativeFpRate: null,
      fields: null,
      gate: { pass, reasons: pass ? [] : ['undersized'] },
    }],
    calibration: null,
    totalUsage: { inputTokens: 10, outputTokens: 5 },
    items: [],
  };
}

describe('listRuns / readRun', () => {
  beforeAll(() => {
    for (const [id, split, pass] of [['run-a', 'dev', false], ['run-b', 'holdout', true]] as const) {
      mkdirSync(join(outDir, id), { recursive: true });
      writeFileSync(join(outDir, id, 'results.json'), JSON.stringify(fakeResults(id, split, pass)), 'utf8');
    }
    // A corrupt run dir must be surfaced, never silently vanish.
    mkdirSync(join(outDir, 'run-corrupt'), { recursive: true });
    writeFileSync(join(outDir, 'run-corrupt', 'results.json'), '{nope', 'utf8');
    // A stray non-run directory is simply not a run.
    mkdirSync(join(outDir, 'not-a-run'), { recursive: true });
  });
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('returns an empty listing for a missing outDir', () => {
    expect(listRuns(join(outDir, 'absent'))).toEqual({ runs: [], skipped: [] });
  });

  it('lists valid runs with threshold summaries and surfaces corrupt dirs', () => {
    const { runs, skipped } = listRuns(outDir);
    expect(runs.map((r) => r.runId).sort()).toEqual(['run-a', 'run-b']);
    expect(skipped).toEqual(['run-corrupt']);
    const b = runs.find((r) => r.runId === 'run-b')!;
    expect(b).toMatchObject({ split: 'holdout', extractor: 'echo', errored: 1 });
    expect(b.thresholds[0]).toMatchObject({ threshold: 'low', pass: true, predictedPositives: 5 });
  });

  it('reads a single run and refuses path-traversal ids', () => {
    expect(readRun(outDir, 'run-a')?.config.runId).toBe('run-a');
    expect(readRun(outDir, 'absent')).toBeNull();
    expect(readRun(outDir, '../run-a')).toBeNull();
    expect(readRun(outDir, '..')).toBeNull();
  });

  it('isSafeRunId accepts the CLI runId shape and nothing sneaky', () => {
    expect(isSafeRunId('2026-07-02-12-00-echo-dev')).toBe(true);
    expect(isSafeRunId('../x')).toBe(false);
    expect(isSafeRunId('a/b')).toBe(false);
    expect(isSafeRunId('a\\b')).toBe(false);
    expect(isSafeRunId('')).toBe(false);
  });
});
