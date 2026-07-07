import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startServer } from '../src/server.js';
import { defineConfig } from '../src/config.js';
import type { GoldgateConfig } from '../src/config.js';
import { triageTask } from './fixtures/triage-task.js';

const dir = join(tmpdir(), `goldgate-server-test-${process.pid}`);
const paths = {
  corpus: join(dir, 'corpus.jsonl'),
  labels: join(dir, 'labels.jsonl'),
  sample: join(dir, 'sample.jsonl'),
  outDir: join(dir, 'runs'),
};

const config = defineConfig({
  task: triageTask,
  extractors: {
    kw: () => async ({ target }) => ({
      prediction: {
        kind: /crash|error|broken/i.test(target.text) ? ('bug' as const) : ('note' as const),
        certainty: 'high' as const,
      },
    }),
    batchy: () => ({ batch: async () => new Map() }),
  },
  paths,
  defaultModel: 'stub',
}) as unknown as GoldgateConfig;

let server: Server;
let base: string;

const get = async (p: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};
const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  const corpus = [
    { id: 't1', text: 'app crash on save when disk is full', queue: 'mobile' },
    { id: 't2', text: 'add dark mode to the settings screen', queue: 'mobile' },
    { id: 't3', text: 'meeting notes from the retro attached', queue: 'web' },
    { id: 't4', text: 'error 500 from the export endpoint', queue: 'web' },
  ];
  writeFileSync(paths.corpus, corpus.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const sample = [
    { itemId: 't1', stratum: 'boosted', split: 'dev' },
    { itemId: 't2', stratum: 'random', split: 'dev' },
    { itemId: 't4', stratum: 'random', split: 'dev' },
    { itemId: 't3', stratum: 'random', split: 'holdout' },
  ];
  writeFileSync(paths.sample, sample.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const started = await startServer({ config, configPath: 'test.config.ts', port: 0 });
  server = started.server;
  base = started.url.slice(0, -1);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('goldgate serve', () => {
  it('serves the UI at /', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('<title>goldgate</title>');
  });

  it('GET /api/overview reflects task, workflow status, and progress', async () => {
    const { status, body } = await get('/api/overview');
    expect(status).toBe(200);
    expect(body.task.kinds).toEqual(['note', 'bug', 'feature']);
    expect(body.task.gate.minPredictedPositives).toBe(40);
    expect(body.extractors).toEqual(['kw', 'batchy']);
    expect(body.workflow.stage).toBe('label-dev');
    expect(body.workflow.dev).toMatchObject({ total: 3, labeled: 0, pending: 3 });
    expect(body.workflow.holdout).toMatchObject({ total: 1, pending: 1 });
    expect(body.events).toEqual([]);
  });

  it('refuses assisted labeling on the holdout (blind by construction)', async () => {
    const { status, body } = await post('/api/label/start', { split: 'holdout', assist: 'kw' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/blind/i);
  });

  it('refuses a batch-shaped assist extractor', async () => {
    const { status, body } = await post('/api/label/start', { split: 'dev', assist: 'batchy' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/batch-shaped/);
  });

  it('drives an assisted dev session over HTTP: accept, manual kind + field, stop', async () => {
    // start — first pending dev item with an extractor proposal
    const start = await post('/api/label/start', { split: 'dev', assist: 'kw' });
    expect(start.status).toBe(200);
    expect(start.body.active).toBe(true);
    expect(start.body.prompt).toMatchObject({
      itemId: 't1', index: 1, total: 3, kinds: ['note', 'bug', 'feature'],
      proposal: { kind: 'bug', certainty: 'high' },
    });

    // a second session while one is active is refused
    const again = await post('/api/label/start', { split: 'dev' });
    expect(again.status).toBe(409);

    // accept the proposal — provenance must record as assisted
    const afterAccept = await post('/api/label/answer', { value: 'a' });
    expect(afterAccept.status).toBe(200);
    expect(afterAccept.body.prompt).toMatchObject({ itemId: 't2', index: 2, proposal: { kind: 'note' } });
    const line1 = JSON.parse(readFileSync(paths.labels, 'utf8').trim().split('\n')[0]!);
    expect(line1).toMatchObject({ ticketId: 't1', kind: 'bug', provenance: 'assisted' });

    // pick 'bug' manually — promptGold then asks for the component field
    const afterKind = await post('/api/label/answer', { value: '2' });
    expect(afterKind.body.prompt).toBeNull();
    expect(afterKind.body.question).toMatchObject({ text: 'component', fallback: 'core' });

    // empty answer falls back
    const afterField = await post('/api/label/answer', { value: '' });
    expect(afterField.body.prompt).toMatchObject({ itemId: 't4', index: 3 });
    const line2 = JSON.parse(readFileSync(paths.labels, 'utf8').trim().split('\n')[1]!);
    expect(line2).toMatchObject({ ticketId: 't2', kind: 'bug', component: 'core', provenance: 'hand' });

    // stop mid-session at a kind prompt
    const stopped = await post('/api/label/stop', {});
    expect(stopped.body.done).toBe(true);

    // with the session over, answers have nowhere to go
    const stray = await post('/api/label/answer', { value: '1' });
    expect(stray.status).toBe(409);
  });

  it('progress reflects the appended labels', async () => {
    const { body } = await get('/api/overview');
    expect(body.workflow.dev).toMatchObject({ labeled: 2, pending: 1, hand: 1, assisted: 1 });
    expect(body.workflow.stage).toBe('dev');
  });

  it('runs a blind holdout session (no proposal ever present)', async () => {
    const start = await post('/api/label/start', { split: 'holdout' });
    expect(start.status).toBe(200);
    expect(start.body.prompt).toMatchObject({ itemId: 't3', total: 1, proposal: null });
    const done = await post('/api/label/answer', { value: '1' });
    expect(done.body.done).toBe(true);
    const lines = readFileSync(paths.labels, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[2]!)).toMatchObject({ ticketId: 't3', kind: 'note', provenance: 'hand' });
  });

  it('freeze via the API starts round 1; decide without a gate run is refused', async () => {
    const frozen = await post('/api/workflow/freeze', { extractor: 'kw', note: 'ready' });
    expect(frozen.status).toBe(200);
    expect(frozen.body.event).toMatchObject({ type: 'freeze', round: 1, frozen: { extractor: 'kw', model: 'stub', mode: 'sync' } });

    const decided = await post('/api/workflow/decide', { ship: true });
    expect(decided.status).toBe(400);
    expect(decided.body.error).toMatch(/no holdout eval/);

    const { body } = await get('/api/overview');
    expect(body.workflow.frozen).toMatchObject({ extractor: 'kw' });
    expect(body.workflow.stage).toBe('holdout-eval');   // holdout fully labeled, no gate run yet
    expect(body.events).toHaveLength(1);
  });

  it('unknown freeze extractor is a 400, not a crash', async () => {
    const { status, body } = await post('/api/workflow/freeze', { extractor: 'nope' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown extractor/);
  });

  it('serves run listings and detail, and refuses traversal ids', async () => {
    mkdirSync(join(paths.outDir, 'run-x'), { recursive: true });
    writeFileSync(join(paths.outDir, 'run-x', 'results.json'), JSON.stringify({
      config: {
        runId: 'run-x', split: 'dev', extractor: 'kw', model: 'stub', contextWindow: 10,
        effort: '(n/a)', mode: 'sync', itemCount: 3, itemsSampledForSplit: 3, itemsSkipped: 0,
      },
      perThreshold: [{
        threshold: 'low', perKind: [],
        pooled: { tp: 1, fp: 0, fn: 0, predictedPositives: 1, precision: 1, precisionWilsonLower: 0.207, recall: 1, errored: 0 },
        confusion: {}, negativeFpRate: 0, fields: null, gate: { pass: false, reasons: ['undersized'] },
      }],
      calibration: null, totalUsage: { inputTokens: 0, outputTokens: 0 }, items: [],
    }), 'utf8');

    const list = await get('/api/runs');
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0].runId).toBe('run-x');

    const detail = await get('/api/runs/run-x');
    expect(detail.status).toBe(200);
    expect(detail.body.config.runId).toBe('run-x');

    const sneaky = await get('/api/runs/..%2Frun-x');
    expect(sneaky.status).toBe(404);
  });

  it('404s unknown API paths', async () => {
    const { status } = await get('/api/nope');
    expect(status).toBe(404);
  });

  it('rejects a stale answer token (double-press cannot label the next item unseen)', async () => {
    // one dev item (t4) is still pending from the earlier stopped session
    const start = await post('/api/label/start', { split: 'dev' });
    expect(start.status).toBe(200);
    expect(start.body.prompt).toMatchObject({ itemId: 't4' });
    const token = start.body.token;
    expect(typeof token).toBe('number');

    // an answer carrying a stale token is refused, session unchanged
    const stale = await post('/api/label/answer', { value: '1', token: token - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/stale answer/);
    const still = await get('/api/label/state');
    expect(still.body.prompt).toMatchObject({ itemId: 't4' });

    // the correct token advances (t4 → note finishes the dev split)
    const ok = await post('/api/label/answer', { value: '1', token });
    expect(ok.status).toBe(200);
    expect(ok.body.done).toBe(true);
  });

  it('CSRF guard: rejects non-JSON content-type and cross-origin POSTs', async () => {
    const plain = await fetch(base + '/api/label/start', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'split=dev',
    });
    expect(plain.status).toBe(415);

    const crossOrigin = await fetch(base + '/api/workflow/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ ship: true }),
    });
    expect(crossOrigin.status).toBe(403);

    // a same-origin loopback Origin is accepted (reaches the handler: 400 for no gate run, not 403)
    const sameOrigin = await fetch(base + '/api/workflow/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ship: true }),
    });
    expect(sameOrigin.status).toBe(400);
  });
});
