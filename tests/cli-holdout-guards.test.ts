import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression coverage for the two holdout-gate integrity guards in cmdEval:
//  P1 — refuse a holdout eval while any holdout item is still unlabeled.
//  P2 — refuse when the frozen operating threshold is no longer declared.
const dir = join(tmpdir(), 'goldgate-fixture-guards');
const CONFIG = 'tests/fixtures/goldgate.config-guards.ts';
const CONFIG_NOTHRESH = 'tests/fixtures/goldgate.config-guards-nothresh.ts';
const wfPath = join(dir, 'workflow.jsonl');

function cli(args: string[]): string {
  return execFileSync('npx', ['tsx', 'src/cli.ts', ...args], {
    shell: process.platform === 'win32', encoding: 'utf8',
  });
}
function cliFails(args: string[]): { status: number | null; stderr: string } {
  try {
    cli(args);
    return { status: 0, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status: number | null; stderr: string };
    return { status: err.status, stderr: String(err.stderr) };
  }
}
const events = (): Record<string, unknown>[] =>
  readFileSync(wfPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const holdoutEvals = (): Record<string, unknown>[] => events().filter((e) => e['type'] === 'holdout-eval');

describe('holdout gate guards (CLI, spawned end-to-end)', () => {
  let holdoutIds: string[];

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const texts = [
      'app crash on save', 'error 500 on export', 'the page is broken', 'login fails after reset',
      'add dark mode', 'please support CSV', 'meeting notes attached', 'what is the SLA',
      'thanks team', 'crash loop on startup', 'export is broken', 'feature bulk edit',
    ];
    writeFileSync(join(dir, 'corpus.jsonl'),
      texts.map((t, i) => JSON.stringify({ id: `t${i}`, text: t })).join('\n') + '\n', 'utf8');
    cli(['sample', '--config', CONFIG, '--total', '8', '--boosted-share', '0', '--holdout-share', '0.5', '--seed', '3']);
    const sample = readFileSync(join(dir, 'sample.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { itemId: string; split: string });
    holdoutIds = sample.filter((s) => s.split === 'holdout').map((s) => s.itemId);
    // Empty labels file so `eval` can read it while the holdout is unlabeled.
    writeFileSync(join(dir, 'labels.jsonl'), '', 'utf8');
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const labelHoldout = (): void =>
    writeFileSync(join(dir, 'labels.jsonl'),
      holdoutIds.map((id) => JSON.stringify({ ticketId: id, provenance: 'hand', kind: 'note' })).join('\n') + '\n', 'utf8');

  it('P1: refuses a holdout eval while any holdout item is unlabeled', () => {
    cli(['freeze', '--config', CONFIG, '--extractor', 'kw']);   // round 1, no threshold
    const r = cliFails(['eval', '--config', CONFIG, '--split', 'holdout', '--extractor', 'kw']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unlabeled/);
    expect(holdoutEvals()).toHaveLength(0);   // the refused run recorded nothing
  }, 60_000);

  it('P1: proceeds once the holdout is fully labeled', () => {
    labelHoldout();
    const out = cli(['eval', '--config', CONFIG, '--split', 'holdout', '--extractor', 'kw']);
    expect(out).toMatch(/gate @ threshold/);
    expect(holdoutEvals()).toHaveLength(1);
  }, 60_000);

  it('P2: refuses when the frozen threshold is no longer a declared confidence level', () => {
    cli(['freeze', '--config', CONFIG, '--extractor', 'kw', '--threshold', 'high']);   // round 2
    // eval with a config whose task dropped confidenceLevels (so 'high' is gone)
    const r = cliFails(['eval', '--config', CONFIG_NOTHRESH, '--split', 'holdout', '--extractor', 'kw']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no longer one of the task's confidenceLevels/);
    expect(holdoutEvals()).toHaveLength(1);   // still just the round-1 run
  }, 60_000);

  it('P2: --allow-unfrozen proceeds and records the run as unfrozen', () => {
    const out = cli(['eval', '--config', CONFIG_NOTHRESH, '--split', 'holdout', '--extractor', 'kw', '--allow-unfrozen']);
    expect(out).toMatch(/gate @ threshold/);
    const last = holdoutEvals().at(-1)!;
    expect(last['round']).toBe(2);
    expect(last['unfrozen']).toBe(true);
  }, 60_000);
});
