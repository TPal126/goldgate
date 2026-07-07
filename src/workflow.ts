// Workflow layer: the methodology's lifecycle (sample → label dev →
// iterate → freeze → blind-label holdout → one gate run → decision) made
// mechanical instead of aspirational. State is an append-only JSONL event
// log — never rewritten, so it doubles as an audit trail — plus a status
// derived fresh from (events, sample, labels) on every read. Nothing here
// is duplicated state that can drift from the files it describes.
//
// Rounds: each `freeze` event begins a new round; holdout evals and the
// decision attach to the round they ran in. Re-freezing after a gate run
// is exactly the methodology's "declared new round".
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlFile } from './corpus.js';
import type { SampleItem } from './sample.js';
import type { TaskSpec } from './task.js';
import { isBatchExtractor } from './task.js';
import type { GateResult } from './metrics.js';
import type { GoldgateConfig } from './config.js';

// --- events ---

/** The dev-time choices a holdout run must match. threshold is the chosen
 *  operating point (informational — every run computes all thresholds). */
export interface FrozenConfig {
  extractor: string;
  model: string;
  effort?: string;
  contextWindow: number;
  mode: 'sync' | 'batch';
  threshold?: string;
  configHashes?: Record<string, string>;
}

export type WorkflowEvent =
  | { at: string; type: 'freeze'; round: number; frozen: FrozenConfig; note?: string }
  | {
      at: string; type: 'holdout-eval'; round: number | null; runId: string;
      gate: GateResult | null; repeat: boolean; unfrozen?: boolean;
    }
  | { at: string; type: 'decision'; round: number | null; runId?: string; ship: boolean; note?: string };

/** paths.workflow when set, else a sibling of the sample file. */
export function workflowPath(paths: { sample: string; workflow?: string }): string {
  return paths.workflow ?? join(dirname(paths.sample), 'workflow.jsonl');
}

export function readWorkflow(path: string): WorkflowEvent[] {
  return existsSync(path) ? readJsonlFile<WorkflowEvent>(path) : [];
}

export function appendWorkflowEvent(path: string, event: WorkflowEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n', 'utf8');
}

// --- pure event-log queries ---

export function currentRound(events: WorkflowEvent[]): number {
  return events.filter((e) => e.type === 'freeze').length;
}

export function latestFreeze(events: WorkflowEvent[]): Extract<WorkflowEvent, { type: 'freeze' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'freeze') return e;
  }
  return undefined;
}

export function holdoutEvalsInRound(events: WorkflowEvent[], round: number | null): Extract<WorkflowEvent, { type: 'holdout-eval' }>[] {
  return events.filter((e): e is Extract<WorkflowEvent, { type: 'holdout-eval' }> =>
    e.type === 'holdout-eval' && e.round === round);
}

export function decisionInRound(events: WorkflowEvent[], round: number | null): Extract<WorkflowEvent, { type: 'decision' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'decision' && e.round === round) return e;
  }
  return undefined;
}

// --- event builders (shared by the CLI and the serve API) ---

export interface FreezeInput {
  extractor: string;
  model: string;
  effort?: string;
  contextWindow: number;
  threshold?: string;
  note?: string;
}

/** Validates the input against the config and derives mode from the
 *  extractor's actual shape (a batch extractor always runs — and records —
 *  'batch'). Throws a user-facing message on any invalid input. */
export function buildFreezeEvent(
  config: GoldgateConfig, events: WorkflowEvent[], input: FreezeInput, at: string,
): Extract<WorkflowEvent, { type: 'freeze' }> {
  const factory = config.extractors[input.extractor];
  if (factory === undefined) throw new Error(`unknown extractor '${input.extractor}'`);
  if (!Number.isInteger(input.contextWindow) || input.contextWindow < 0) {
    // A NaN/negative context window would be written into the append-only
    // log verbatim and could never be matched at eval time — refuse it here.
    throw new Error(`context window must be a non-negative integer (got ${String(input.contextWindow)})`);
  }
  const built = factory({
    model: input.model, contextWindow: input.contextWindow,
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  const mode = isBatchExtractor(built) ? 'batch' as const : 'sync' as const;
  if (input.threshold !== undefined) {
    const levels = config.task.confidenceLevels;
    if (levels === undefined || !levels.includes(input.threshold)) {
      throw new Error(
        `threshold '${input.threshold}' is not one of the task's confidenceLevels ` +
        `(${levels === undefined ? 'none declared' : levels.join(', ')})`,
      );
    }
  }
  const frozen: FrozenConfig = {
    extractor: input.extractor,
    model: input.model,
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    contextWindow: input.contextWindow,
    mode,
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(config.task.configHashes !== undefined ? { configHashes: config.task.configHashes } : {}),
  };
  return {
    at, type: 'freeze', round: currentRound(events) + 1, frozen,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

/** A decision must reference a gate run: refuses when the current round has
 *  no completed holdout eval. Ties itself to the round's FIRST completed
 *  holdout eval — the seal declares that run the gate decision, so a later
 *  repeat run (warned about) can never launder the first run's verdict. */
export function buildDecisionEvent(
  events: WorkflowEvent[], input: { ship: boolean; note?: string }, at: string,
): Extract<WorkflowEvent, { type: 'decision' }> {
  const round = latestFreeze(events)?.round ?? null;
  const evals = holdoutEvalsInRound(events, round);
  const gateRun = evals[0];
  if (gateRun === undefined) {
    throw new Error('no holdout eval recorded in the current round — a release decision must reference a gate run');
  }
  return {
    at, type: 'decision', round, runId: gateRun.runId, ship: input.ship,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

// --- the holdout guard ---

/** What the eval CLI is about to run — compared field-by-field against the
 *  frozen configuration. configHashes are the task's static provenance
 *  (promptHash, schemaHash, guidelinesHash, …) at eval time; they are part
 *  of the seal, so drift in any of them is drift from the freeze. */
export interface HoldoutRunConfig {
  extractor: string;
  model: string;
  effort?: string;
  contextWindow: number;
  mode: 'sync' | 'batch';
  configHashes?: Record<string, string>;
}

/** Order-independent equality of two hash maps (undefined ≡ empty). */
function sameHashes(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const ak = a === undefined ? [] : Object.keys(a).sort();
  const bk = b === undefined ? [] : Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => bk[i] === k && a![k] === b![k]);
}

export type HoldoutVerdict =
  | { ok: true; round: number | null; repeat: boolean; unfrozen: boolean; warnings: string[] }
  | { ok: false; reasons: string[] };

/** Refusal-first: a holdout run with no frozen configuration, or one whose
 *  configuration differs from the freeze, is refused — that is the seal.
 *  `allowUnfrozen` is the explicit escape hatch; the run then proceeds but
 *  is recorded as unfrozen, visibly, in the event log. Repeat runs within
 *  a round are allowed (a crashed first attempt must be re-runnable) but
 *  warned about and recorded — the first completed run is the gate. */
export function checkHoldoutRun(
  events: WorkflowEvent[], run: HoldoutRunConfig, allowUnfrozen: boolean,
): HoldoutVerdict {
  const freeze = latestFreeze(events);
  const warnings: string[] = [];

  if (freeze === undefined) {
    if (!allowUnfrozen) {
      return {
        ok: false,
        reasons: [
          'holdout eval refused: no frozen configuration — run `goldgate freeze` when dev work is done ' +
          '(or pass --allow-unfrozen to proceed anyway; the run will be recorded as unfrozen)',
        ],
      };
    }
    warnings.push('holdout run without a frozen configuration — recorded as unfrozen in the workflow log');
    return { ok: true, round: null, repeat: false, unfrozen: true, warnings };
  }

  const f = freeze.frozen;
  const mismatches: string[] = [];
  if (run.extractor !== f.extractor) mismatches.push(`extractor '${run.extractor}' ≠ frozen '${f.extractor}'`);
  if (run.model !== f.model) mismatches.push(`model '${run.model}' ≠ frozen '${f.model}'`);
  if ((run.effort ?? '(n/a)') !== (f.effort ?? '(n/a)')) {
    mismatches.push(`effort '${run.effort ?? '(n/a)'}' ≠ frozen '${f.effort ?? '(n/a)'}'`);
  }
  if (run.contextWindow !== f.contextWindow) {
    mismatches.push(`context window ${run.contextWindow} ≠ frozen ${f.contextWindow}`);
  }
  if (run.mode !== f.mode) mismatches.push(`mode '${run.mode}' ≠ frozen '${f.mode}'`);
  if (!sameHashes(run.configHashes, f.configHashes)) {
    mismatches.push('config hashes (promptHash/schemaHash/guidelines/…) differ from the freeze');
  }

  if (mismatches.length > 0 && !allowUnfrozen) {
    return {
      ok: false,
      reasons: [
        `holdout eval refused: configuration differs from round ${freeze.round} freeze (${freeze.at}):`,
        ...mismatches.map((m) => `  - ${m}`),
        'match the frozen configuration, or re-run `goldgate freeze` to declare a new round',
      ],
    };
  }
  if (mismatches.length > 0) {
    warnings.push(`holdout run differs from the round ${freeze.round} freeze (${mismatches.join('; ')}) — recorded as unfrozen`);
  }

  const prior = holdoutEvalsInRound(events, freeze.round);
  const repeat = prior.length > 0;
  if (repeat) {
    warnings.push(
      `holdout already evaluated ${prior.length} time(s) in round ${freeze.round} — the first completed run is ` +
      'the gate decision; further tuning requires a declared new round (`goldgate freeze`)',
    );
  }
  return { ok: true, round: freeze.round, repeat, unfrozen: mismatches.length > 0, warnings };
}

// --- derived status ---

export interface SplitProgress {
  total: number;      // sampled items in the split
  labeled: number;    // of those, how many have a gold label
  pending: number;
  hand: number;       // provenance breakdown of the labeled ones
  assisted: number;
}

export type WorkflowStage =
  | 'sample' | 'label-dev' | 'dev' | 'label-holdout' | 'holdout-eval' | 'decide' | 'done';

export interface WorkflowStatus {
  stage: WorkflowStage;
  round: number;      // 0 = never frozen
  frozen: (FrozenConfig & { at: string; note?: string }) | null;
  holdoutEvalsThisRound: number;
  decision: { ship: boolean; at: string; runId?: string; note?: string } | null;
  dev: SplitProgress;
  holdout: SplitProgress;
  nextStep: string;
}

function splitProgress<I extends { id: string; text: string }, G, P>(
  sample: SampleItem[], labels: G[], split: 'dev' | 'holdout', task: TaskSpec<I, G, P>,
): SplitProgress {
  const inSplit = sample.filter((s) => s.split === split);
  const byId = new Map(labels.map((l) => [task.idOfGold(l), l]));
  let labeled = 0, hand = 0, assisted = 0;
  for (const s of inSplit) {
    const g = byId.get(s.itemId);
    if (g === undefined) continue;
    labeled++;
    if (task.provenanceOfGold(g) === 'assisted') assisted++; else hand++;
  }
  return { total: inSplit.length, labeled, pending: inSplit.length - labeled, hand, assisted };
}

export function deriveStatus<I extends { id: string; text: string }, G, P>(input: {
  events: WorkflowEvent[];
  sample: SampleItem[];   // [] when the sample file doesn't exist yet
  labels: G[];
  task: TaskSpec<I, G, P>;
}): WorkflowStatus {
  const { events, sample, labels, task } = input;
  const dev = splitProgress(sample, labels, 'dev', task);
  const holdout = splitProgress(sample, labels, 'holdout', task);
  const freeze = latestFreeze(events);
  const round = currentRound(events);
  const evals = freeze === undefined ? [] : holdoutEvalsInRound(events, freeze.round);
  const decision = freeze === undefined ? undefined : decisionInRound(events, freeze.round);

  let stage: WorkflowStage;
  let nextStep: string;
  if (sample.length === 0) {
    stage = 'sample';
    nextStep = 'run `goldgate sample` to stratify the corpus and seal the dev/holdout split';
  } else if (freeze === undefined) {
    if (dev.labeled === 0) {
      stage = 'label-dev';
      nextStep = `label the dev split (${dev.pending} pending) — \`goldgate label --split dev\``;
    } else {
      stage = 'dev';
      nextStep = 'iterate on the dev split (label, eval, tune); run `goldgate freeze` when the configuration is final';
    }
  } else if (holdout.pending > 0) {
    stage = 'label-holdout';
    nextStep = `blind-label the holdout (${holdout.pending} pending) — \`goldgate label --split holdout\` (assist is refused)`;
  } else if (evals.length === 0) {
    stage = 'holdout-eval';
    nextStep = 'run the single gate eval — `goldgate eval --split holdout` with the frozen configuration';
  } else if (decision === undefined) {
    stage = 'decide';
    nextStep = 'record the release decision — `goldgate decide --ship` or `--no-ship`';
  } else {
    stage = 'done';
    nextStep = 'round complete; further tuning starts a declared new round (`goldgate freeze`)';
  }

  return {
    stage,
    round,
    frozen: freeze === undefined ? null
      : { ...freeze.frozen, at: freeze.at, ...(freeze.note !== undefined ? { note: freeze.note } : {}) },
    holdoutEvalsThisRound: evals.length,
    decision: decision === undefined ? null
      : {
          ship: decision.ship, at: decision.at,
          ...(decision.runId !== undefined ? { runId: decision.runId } : {}),
          ...(decision.note !== undefined ? { note: decision.note } : {}),
        },
    dev,
    holdout,
    nextStep,
  };
}
