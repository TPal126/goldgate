import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runEval } from '../src/runner.js';
import type { TaskExtractor } from '../src/task.js';
import type { SampleItem } from '../src/sample.js';
import { triageTask, type Ticket, type TriageGold, type TriagePred } from './fixtures/triage-task.js';

const corpus: Ticket[] = [
  { id: 't1', text: "let's add dark mode support", queue: 'product' },
  { id: 't2', text: "what's for lunch?", queue: 'general' },
  { id: 't3', text: 'the app crashes on save', queue: 'support' },
];
const labels: TriageGold[] = [
  { ticketId: 't1', provenance: 'hand', kind: 'feature', component: 'ui' },
  { ticketId: 't2', provenance: 'hand', kind: 'note' },
  { ticketId: 't3', provenance: 'hand', kind: 'note' },
];
const sample: SampleItem[] = [
  { itemId: 't1', stratum: 'boosted', split: 'dev' },
  { itemId: 't2', stratum: 'random', split: 'dev' },
  { itemId: 't3', stratum: 'random', split: 'dev' },
];

// Stub: correct on t1, correct on t2, throws on t3 (errored-item path).
const stub: TaskExtractor<Ticket, TriagePred> = async (input) => {
  if (input.target.id === 't3') throw new Error('boom');
  if (input.target.id === 't1') {
    return {
      prediction: { kind: 'feature', certainty: 'high', component: 'ui' },
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
  return { prediction: { kind: 'note', certainty: 'high' } };
};

// runEval writes results.json/report.md to disk — use a unique tmpdir per
// test and remove it afterward so the suite leaves nothing behind.
const tmpDirs: string[] = [];
function freshOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `goldgate-runner-test-${process.pid}-`));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('runEval', () => {
  it('runs end-to-end, writes report.md + results.json, counts errors visibly', async () => {
    const outDir = freshOutDir();
    const summary = await runEval({
      task: triageTask,
      corpus, labels, sample, split: 'dev',
      extractor: stub, extractorName: 'stub', model: 'stub-model',
      contextWindow: 10, effort: 'high', mode: 'sync',
      outDir, runId: 'test-run', concurrency: 2,
      configExtras: { promptHash: createHash('sha256').update('test-prompt').digest('hex') },
    });

    expect(summary.items).toHaveLength(3);
    expect(summary.pooled.errored).toBe(1);
    expect(summary.pooled.tp).toBe(1);
    expect(summary.totalUsage.inputTokens).toBe(100);

    expect(existsSync(join(outDir, 'test-run', 'report.md'))).toBe(true);
    const results = JSON.parse(readFileSync(join(outDir, 'test-run', 'results.json'), 'utf8'));
    expect(results.config.model).toBe('stub-model');
    expect(results.config.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(results.config.split).toBe('dev');
    // Provenance: effort + mode are recorded so two runs are only
    // comparable when reasoning depth and execution path match (spec §3.4).
    expect(results.config.effort).toBe('high');
    expect(results.config.mode).toBe('sync');
    const report = readFileSync(join(outDir, 'test-run', 'report.md'), 'utf8');
    expect(report).toContain('errored');
  });

  it('refuses a holdout run containing assisted labels', async () => {
    const outDir = freshOutDir();
    const holdoutLabels: TriageGold[] = [
      { ticketId: 't2', provenance: 'assisted', kind: 'note' },
    ];
    const holdoutSample: SampleItem[] = [
      { itemId: 't2', stratum: 'random', split: 'holdout' },
    ];
    await expect(runEval({
      task: triageTask,
      corpus, labels: holdoutLabels, sample: holdoutSample, split: 'holdout',
      extractor: stub, extractorName: 'stub', model: 'stub-model',
      contextWindow: 0, outDir, runId: 'holdout-refuse', concurrency: 1,
    })).rejects.toThrow(/holdout eval refused/);
  });

  it('runs a batch extractor through the same scoring path', async () => {
    const outDir = freshOutDir();
    const batchExtractor = {
      batch: async (targets: Ticket[]) => new Map(targets.map((t) => [
        t.id, { prediction: { kind: 'note', certainty: 'high' } as TriagePred },
      ])),
    };
    const summary = await runEval({
      task: triageTask,
      corpus, labels, sample, split: 'dev',
      extractor: batchExtractor, extractorName: 'batch-stub', model: 'stub-model',
      contextWindow: 0, mode: 'batch', outDir, runId: 'batch-run', concurrency: 1,
    });
    expect(summary.items.every((i) => i.predicted !== null)).toBe(true);
  });

  it('prints the frozen-config warning on a clean holdout run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outDir = freshOutDir();
    const handLabels: TriageGold[] = [
      { ticketId: 't2', provenance: 'hand', kind: 'note' },
    ];
    const holdoutSample: SampleItem[] = [
      { itemId: 't2', stratum: 'random', split: 'holdout' },
    ];
    const trivial: TaskExtractor<Ticket, TriagePred> = async () => (
      { prediction: { kind: 'note', certainty: 'high' } }
    );
    await runEval({
      task: triageTask,
      corpus, labels: handLabels, sample: holdoutSample, split: 'holdout',
      extractor: trivial, extractorName: 'trivial', model: 'stub-model',
      contextWindow: 0, outDir, runId: 'holdout-clean', concurrency: 1,
    });
    expect(warn.mock.calls.flat().join(' ')).toContain('frozen');
    warn.mockRestore();
  });
});
