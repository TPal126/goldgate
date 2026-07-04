// goldgate serve — the local reviewer / workflow / dashboard server.
// Plain node:http, no dependencies, bound to loopback by default: this is
// a single-reviewer local tool, not a hosted service.
//
// The labeling endpoints do not reimplement labeling: they drive the same
// runLabelSession the CLI uses, through a web-backed LabelIO whose
// structured askKind hook suspends until the browser answers. Blind-holdout
// enforcement, provenance, and crash-safe per-item appends therefore live
// in exactly one code path, whichever frontend is in front of it.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldgateConfig } from './config.js';
import { readJsonlFile } from './corpus.js';
import type { SampleItem } from './sample.js';
import { runLabelSession, assertAssistAllowed } from './label.js';
import { isBatchExtractor } from './task.js';
import type { ExtractFn, LabelIO, LabelPrompt } from './task.js';
import { DEFAULT_GATE } from './metrics.js';
import {
  readWorkflow, appendWorkflowEvent, workflowPath, deriveStatus,
  buildFreezeEvent, buildDecisionEvent,
} from './workflow.js';
import { listRuns, readRun } from './runs.js';

export interface ServeOptions {
  config: GoldgateConfig;
  /** Shown in the UI header so the reviewer knows which project this is. */
  configPath?: string;
  /** Override the bundled UI file (tests). */
  uiPath?: string;
}

// One label session at a time: the session owns an exclusive append handle
// on the labels file, and this is a single-reviewer tool by design.
interface LabelSessionState {
  split: 'dev' | 'holdout';
  assist: string | null;
  startedAt: string;
  transcript: string[];
  prompt: LabelPrompt | null;                          // awaiting a kind key
  question: { text: string; fallback: string } | null; // awaiting free text
  resolveAnswer: ((value: string) => void) | null;
  // Bumped every time a new prompt/question is presented. An answer must
  // echo the token it is responding to; a stale answer (double-press, key
  // auto-repeat) whose token no longer matches is rejected instead of
  // landing on the next item — the reviewer must SEE every item they label.
  token: number;
  stopRequested: boolean;
  done: boolean;
  error: string | null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return true;   // some clients omit Host
  const host = hostHeader.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** CSRF / DNS-rebinding guard for state-changing requests. A local tool
 *  binds loopback, but a browser on a hostile page can still POST to
 *  127.0.0.1 — and forging audit-log events or injecting label answers
 *  would defeat exactly the integrity goldgate exists to protect. Three
 *  cheap checks close it: the Host must resolve to loopback (blocks
 *  rebinding via an attacker domain), a present Origin must be loopback
 *  (blocks classic cross-origin POST), and the body must be JSON (a
 *  content-type cross-origin fetch cannot set without a CORS preflight we
 *  never answer). The same-origin UI satisfies all three. */
function guardStateChange(req: IncomingMessage): void {
  if (!isLoopbackHost(req.headers.host)) {
    throw new HttpError(403, 'refused: non-loopback Host header (possible DNS-rebinding)');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null') {
    let ok = false;
    try { ok = isLoopbackHost(new URL(origin).host); } catch { ok = false; }
    if (!ok) throw new HttpError(403, 'refused: cross-origin request to a local-only tool');
  }
  const ct = req.headers['content-type'] ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'state-changing requests must be application/json');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolvePromise({});
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'body must be a JSON object'));
        }
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Let the suspended session loop advance to its next ask/askKind (or to
 *  completion) before we serialize state back to the browser. Microtasks
 *  drain before setImmediate, so a synchronous stretch of the loop settles
 *  in one hop; an async stretch (network assist) reports working:true and
 *  the UI polls. */
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export function createGoldgateServer(opts: ServeOptions): Server {
  const { config } = opts;
  const paths = config.paths;
  const wfPath = workflowPath(paths);
  const uiFile = opts.uiPath ?? fileURLToPath(new URL('./ui/app.html', import.meta.url));

  let session: LabelSessionState | null = null;

  const sessionState = (): Record<string, unknown> => {
    if (session === null) return { active: false, done: false, error: null };
    const s = session;
    return {
      active: !s.done,
      done: s.done,
      error: s.error,
      split: s.split,
      assist: s.assist,
      startedAt: s.startedAt,
      token: s.token,
      prompt: s.prompt,
      question: s.question,
      // Neither a prompt nor a question pending while active = the session
      // loop is off doing async work (an assist extraction) — keep polling.
      working: !s.done && s.prompt === null && s.question === null,
      transcript: s.transcript.slice(-100),
    };
  };

  const readSample = (): SampleItem[] =>
    existsSync(paths.sample) ? readJsonlFile<SampleItem>(paths.sample) : [];
  const readLabels = (): unknown[] =>
    existsSync(paths.labels) ? readJsonlFile<unknown>(paths.labels) : [];

  const overview = (): unknown => {
    const sample = readSample();
    const labels = readLabels();
    const events = readWorkflow(wfPath);
    const { runs, skipped } = listRuns(paths.outDir);
    return {
      configPath: opts.configPath ?? null,
      task: {
        kinds: config.task.kinds,
        negativeKind: config.task.negativeKind ?? null,
        gatedKinds: config.task.gatedKinds,
        confidenceLevels: config.task.confidenceLevels ?? null,
        gate: { ...DEFAULT_GATE, ...config.task.gate },
        hasLabeling: config.task.labeling !== undefined,
        hasCompareFields: config.task.compareFields !== undefined,
      },
      extractors: Object.keys(config.extractors),
      defaultModel: config.defaultModel ?? null,
      workflow: deriveStatus({ events, sample, labels, task: config.task }),
      events,
      runs,
      skippedRuns: skipped,
      labelSession: sessionState(),
    };
  };

  const startLabelSession = (body: Record<string, unknown>): void => {
    if (session !== null && !session.done) {
      throw new HttpError(409, 'a label session is already active — stop it first');
    }
    const split = body['split'];
    if (split !== 'dev' && split !== 'holdout') throw new HttpError(400, "split must be 'dev' or 'holdout'");
    if (config.task.labeling === undefined) {
      throw new HttpError(400, 'this task declares no labeling hooks — labels must be brought externally');
    }
    if (!existsSync(paths.sample)) {
      throw new HttpError(400, `no sample file at ${paths.sample} — run \`goldgate sample\` first`);
    }
    if (!existsSync(paths.corpus)) throw new HttpError(400, `no corpus file at ${paths.corpus}`);

    const assistName = typeof body['assist'] === 'string' && body['assist'] !== '' ? body['assist'] : null;
    let assistFn: ExtractFn<{ id: string; text: string }, unknown> | undefined;
    if (assistName !== null) {
      // Same guard the CLI applies — thrown here so the browser gets the
      // exact blind-holdout refusal message instead of a dead session.
      try {
        assertAssistAllowed(split, true);
      } catch (e: unknown) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      const factory = config.extractors[assistName];
      if (factory === undefined) throw new HttpError(400, `unknown extractor '${assistName}'`);
      const model = typeof body['model'] === 'string' && body['model'] !== '' ? body['model'] : config.defaultModel;
      if (model === undefined) throw new HttpError(400, 'no model given and config has no defaultModel');
      const built = factory({ model, contextWindow: 5 });
      if (isBatchExtractor(built)) {
        throw new HttpError(400, `extractor '${assistName}' is batch-shaped and cannot assist labeling`);
      }
      assistFn = built;
    }

    const corpus = readJsonlFile<{ id: string; text: string }>(paths.corpus);
    const sample = readSample();
    const existingLabels = readLabels();

    // The CLI mkdirs the label dir before running; the server must too, or
    // the very first crash-safe append throws ENOENT and kills the session.
    mkdirSync(dirname(paths.labels), { recursive: true });

    const state: LabelSessionState = {
      split, assist: assistName, startedAt: new Date().toISOString(),
      transcript: [], prompt: null, question: null, resolveAnswer: null,
      token: 0, stopRequested: false, done: false, error: null,
    };
    const io: LabelIO = {
      say: (line) => { state.transcript.push(line); },
      ask: (question, fallback) => new Promise<string>((resolveAsk) => {
        state.question = { text: question, fallback };
        state.token++;
        state.resolveAnswer = (value) => {
          state.question = null;
          state.resolveAnswer = null;
          resolveAsk(value.trim() === '' ? fallback : value.trim());
        };
      }),
      askKind: (prompt) => new Promise<string>((resolveKind) => {
        if (state.stopRequested) return resolveKind('q');
        state.prompt = prompt;
        state.token++;
        state.resolveAnswer = (value) => {
          state.prompt = null;
          state.resolveAnswer = null;
          resolveKind(value);
        };
      }),
    };
    session = state;
    void runLabelSession({
      task: config.task, corpus, sample, existingLabels, split, out: paths.labels,
      ...(assistFn !== undefined ? { assist: assistFn } : {}), io,
    }).then(
      () => { state.done = true; },
      (e: unknown) => {
        state.error = e instanceof Error ? e.message : String(e);
        state.done = true;
      },
    );
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Every mutating route goes through the CSRF / rebinding guard first.
    if (method === 'POST') guardStateChange(req);

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      if (!existsSync(uiFile)) {
        return sendJson(res, 500, { error: `UI asset missing at ${uiFile} — was the package built with dist/ui?` });
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end(readFileSync(uiFile, 'utf8'));
      return;
    }

    if (method === 'GET' && path === '/api/overview') return sendJson(res, 200, overview());

    if (method === 'GET' && path === '/api/runs') return sendJson(res, 200, listRuns(paths.outDir));

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && runMatch !== null) {
      const run = readRun(paths.outDir, decodeURIComponent(runMatch[1]!));
      if (run === null) return sendJson(res, 404, { error: 'run not found' });
      return sendJson(res, 200, run);
    }

    if (method === 'GET' && path === '/api/label/state') return sendJson(res, 200, sessionState());

    if (method === 'POST' && path === '/api/label/start') {
      startLabelSession(await readBody(req));
      await settle();
      return sendJson(res, 200, sessionState());
    }

    if (method === 'POST' && path === '/api/label/answer') {
      const body = await readBody(req);
      if (session === null || session.resolveAnswer === null) {
        throw new HttpError(409, 'no pending question');
      }
      const value = body['value'];
      if (typeof value !== 'string') throw new HttpError(400, "body must carry a string 'value'");
      // Token correlation: the answer must target the prompt currently on
      // screen. If it doesn't, the prompt advanced between render and click
      // (double-press / auto-repeat) — reject rather than label an item the
      // reviewer never saw. A client may omit the token only when it can't
      // have raced (there was exactly one prompt); the UI always sends it.
      const token = body['token'];
      if (token !== undefined && token !== session.token) {
        throw new HttpError(409, 'stale answer: the prompt has advanced — re-read the current item and answer again');
      }
      session.resolveAnswer(value);
      await settle();
      return sendJson(res, 200, sessionState());
    }

    if (method === 'POST' && path === '/api/label/stop') {
      if (session === null || session.done) throw new HttpError(409, 'no active label session');
      if (session.question !== null) {
        throw new HttpError(400, 'a field question is mid-entry — answer it first, then stop');
      }
      session.stopRequested = true;
      if (session.prompt !== null && session.resolveAnswer !== null) {
        session.resolveAnswer('q');
      } else {
        // No prompt pending = the loop is parked in async work (a slow/hung
        // assist extraction). We can't cancel that promise, but marking the
        // session done frees a new session to start; if the parked loop ever
        // wakes, its askKind sees stopRequested and quits without writing.
        session.done = true;
      }
      await settle();
      return sendJson(res, 200, sessionState());
    }

    if (method === 'POST' && path === '/api/workflow/freeze') {
      const body = await readBody(req);
      const extractor = body['extractor'];
      if (typeof extractor !== 'string' || extractor === '') {
        throw new HttpError(400, "body must carry a string 'extractor'");
      }
      const model = typeof body['model'] === 'string' && body['model'] !== '' ? body['model'] : config.defaultModel;
      if (model === undefined) throw new HttpError(400, 'no model given and config has no defaultModel');
      const contextWindow = typeof body['contextWindow'] === 'number' ? body['contextWindow'] : 10;
      try {
        const event = buildFreezeEvent(config, readWorkflow(wfPath), {
          extractor, model, contextWindow,
          ...(typeof body['effort'] === 'string' ? { effort: body['effort'] } : {}),
          ...(typeof body['threshold'] === 'string' && body['threshold'] !== '' ? { threshold: body['threshold'] } : {}),
          ...(typeof body['note'] === 'string' && body['note'] !== '' ? { note: body['note'] } : {}),
        }, new Date().toISOString());
        appendWorkflowEvent(wfPath, event);
        return sendJson(res, 200, { event });
      } catch (e: unknown) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }

    if (method === 'POST' && path === '/api/workflow/decide') {
      const body = await readBody(req);
      const ship = body['ship'];
      if (typeof ship !== 'boolean') throw new HttpError(400, "body must carry a boolean 'ship'");
      try {
        const event = buildDecisionEvent(readWorkflow(wfPath), {
          ship,
          ...(typeof body['note'] === 'string' && body['note'] !== '' ? { note: body['note'] } : {}),
        }, new Date().toISOString());
        appendWorkflowEvent(wfPath, event);
        return sendJson(res, 200, { event });
      } catch (e: unknown) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });
}

/** Listen and resolve with the bound port (pass port 0 for an ephemeral
 *  one — tests do). Loopback-only unless a host is given explicitly. */
export function startServer(
  opts: ServeOptions & { port: number; host?: string },
): Promise<{ server: Server; port: number; url: string }> {
  const host = opts.host ?? '127.0.0.1';
  return new Promise((resolvePromise, reject) => {
    const server = createGoldgateServer(opts);
    server.on('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolvePromise({ server, port, url: `http://${host}:${String(port)}/` });
    });
  });
}
