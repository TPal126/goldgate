import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must match tests/fixtures/goldgate.config-workflow.ts's `dir` computation.
const dir = join(tmpdir(), 'goldgate-fixture-workflow');
const CONFIG = 'tests/fixtures/goldgate.config-workflow.ts';
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

describe('goldgate workflow (CLI, spawned end-to-end)', () => {
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const texts = [
      'app crash on save', 'add dark mode', 'error 500 on export', 'meeting notes attached',
      'search is broken past page 3', 'thanks for the fix', 'login fails after rotation',
      'what is the SLA', 'csv import please', 'crash loop on startup',
    ];
    writeFileSync(join(dir, 'corpus.jsonl'),
      texts.map((t, i) => JSON.stringify({ id: `t${i}`, text: t, queue: 'q' })).join('\n') + '\n', 'utf8');

    cli(['sample', '--config', CONFIG, '--total', '8', '--boosted-share', '0', '--holdout-share', '0.25', '--seed', '7']);
    // Hand-label everything sampled (provenance 'hand' keeps the holdout evaluable).
    const sample = readFileSync(join(dir, 'sample.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { itemId: string });
    writeFileSync(join(dir, 'labels.jsonl'),
      sample.map((s) => JSON.stringify({ ticketId: s.itemId, provenance: 'hand', kind: 'note' })).join('\n') + '\n', 'utf8');
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a holdout eval before any freeze', () => {
    const r = cliFails(['eval', '--config', CONFIG, '--split', 'holdout', '--extractor', 'kw']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no frozen configuration/);
    expect(existsSync(wfPath)).toBe(false);
  }, 60_000);

  it('freeze records round 1 into the event log', () => {
    // Single-token note: shell:true on Windows re-splits multi-word args.
    const out = cli(['freeze', '--config', CONFIG, '--extractor', 'kw', '--note', 'dev-done']);
    expect(out).toContain('frozen (round 1)');
    const ev = events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'freeze', round: 1,
      frozen: { extractor: 'kw', model: 'stub', contextWindow: 10, mode: 'sync' },
      note: 'dev-done',
    });
  }, 60_000);

  it('a matching holdout eval runs and is recorded with its gate verdict', () => {
    const out = cli(['eval', '--config', CONFIG, '--split', 'holdout', '--extractor', 'kw']);
    expect(out).toContain('done:');
    expect(out).toMatch(/gate @ threshold/);
    const ev = events();
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({ type: 'holdout-eval', round: 1, repeat: false });
    expect((ev[1] as { gate: { pass: boolean } }).gate).toHaveProperty('pass');
    expect((ev[1] as { runId: string }).runId).toMatch(/-kw-holdout$/);
  }, 60_000);

  it('refuses a holdout eval whose configuration drifts from the freeze', () => {
    const r = cliFails(['eval', '--config', CONFIG, '--split', 'holdout', '--extractor', 'kw', '--context', '5']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/differs from round 1 freeze/);
    expect(events()).toHaveLength(2);   // the refused run recorded nothing
  }, 60_000);

  it('decide records the decision against the gate run', () => {
    const out = cli(['decide', '--config', CONFIG, '--ship', '--note', 'gate-held']);
    expect(out).toContain('SHIP');
    const ev = events();
    expect(ev[2]).toMatchObject({ type: 'decision', round: 1, ship: true, note: 'gate-held' });
    expect((ev[2] as { runId: string }).runId).toBe((ev[1] as { runId: string }).runId);
  }, 60_000);

  it('status reports the completed round', () => {
    const out = cli(['status', '--config', CONFIG]);
    expect(out).toContain('stage: done');
    expect(out).toContain('round: 1');
    expect(out).toMatch(/decision: SHIP/);
  }, 60_000);
});
