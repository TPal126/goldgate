#!/usr/bin/env node
// goldgate CLI — sample/label/eval/freeze/status/decide/serve subcommands
// over a defineConfig'd module (src/config.ts). Every file-path flag is an
// override with config.paths as the fallback.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { readJsonlFile, writeJsonlFile } from './corpus.js';
import { stratifiedSample } from './sample.js';
import type { SampleItem } from './sample.js';
import { runLabelSession, pendingItems } from './label.js';
import { runEval } from './runner.js';
import { isBatchExtractor } from './task.js';
import type { ExtractFn, LabelIO } from './task.js';
import {
  workflowPath, readWorkflow, appendWorkflowEvent, checkHoldoutRun,
  latestFreeze, holdoutEvalsInRound, buildFreezeEvent, buildDecisionEvent, deriveStatus,
} from './workflow.js';
import type { HoldoutVerdict, SplitProgress } from './workflow.js';
import { listRuns } from './runs.js';
import { startServer } from './server.js';

// --- argv helpers (ported from the original implementation) ---

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  // A following flag is not a value: `--split --extractor x` must not yield '--extractor'.
  if (next !== undefined && !next.startsWith('--')) return next;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

function argOpt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  if (next !== undefined && !next.startsWith('--')) return next;
  return undefined;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireSplit(): 'dev' | 'holdout' {
  const raw = arg('split');
  if (raw !== 'dev' && raw !== 'holdout') {
    console.error('--split must be dev or holdout');
    process.exit(1);
  }
  return raw;
}

// --- subcommands ---

async function cmdSample(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const corpusPath = argOpt('corpus') ?? config.paths.corpus;
  const outPath = argOpt('out') ?? config.paths.sample;

  const messages = readJsonlFile<{ id: string; text: string }>(corpusPath);
  const sample = stratifiedSample(messages, {
    total: parseInt(arg('total', '600'), 10),
    boostedShare: parseFloat(arg('boosted-share', '0.4')),
    holdoutShare: parseFloat(arg('holdout-share', '0.3')),
    seed: parseInt(arg('seed', '7'), 10),
    patterns: config.task.boostPatterns ?? [],
  });
  writeJsonlFile(outPath, sample);
  const counts = {
    dev: sample.filter((s) => s.split === 'dev').length,
    holdout: sample.filter((s) => s.split === 'holdout').length,
  };
  console.log(`sampled ${sample.length} (dev ${counts.dev} / holdout ${counts.holdout})`);
}

async function cmdLabel(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const corpusPath = argOpt('corpus') ?? config.paths.corpus;
  const samplePath = argOpt('sample') ?? config.paths.sample;
  const outPath = argOpt('out') ?? config.paths.labels;
  const split = requireSplit();
  const assistName = argOpt('assist');

  const corpus = readJsonlFile<{ id: string; text: string }>(corpusPath);
  const sample = readJsonlFile<SampleItem>(samplePath);
  const existingLabels = existsSync(outPath) ? readJsonlFile(outPath) : [];

  let assistFn: ExtractFn<{ id: string; text: string }, unknown> | undefined;
  if (assistName !== undefined) {
    const factory = config.extractors[assistName];
    if (factory === undefined) {
      console.error(`unknown extractor '${assistName}'`);
      process.exit(1);
    }
    const model = arg('model', config.defaultModel);
    const built = factory({ model, contextWindow: 5 });
    if (isBatchExtractor(built)) {
      console.error(`extractor '${assistName}' does not support --assist (batch-shaped)`);
      process.exit(1);
    }
    assistFn = built;
  }

  mkdirSync(dirname(outPath), { recursive: true });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: LabelIO = {
    ask: async (q, fallback) => {
      const a = await rl.question(`  ${q} [${fallback}]: `);
      return a.trim() || fallback;
    },
    say: (line) => console.log(line),
  };
  try {
    await runLabelSession({
      task: config.task, corpus, sample, existingLabels, split, out: outPath,
      ...(assistFn !== undefined ? { assist: assistFn } : {}), io,
    });
  } finally {
    rl.close();
  }
}

async function cmdEval(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const corpusPath = argOpt('corpus') ?? config.paths.corpus;
  const labelsPath = argOpt('labels') ?? config.paths.labels;
  const samplePath = argOpt('sample') ?? config.paths.sample;
  const split = requireSplit();
  const extractorName = arg('extractor');
  const model = arg('model', config.defaultModel);
  const effort = argOpt('effort');
  const contextWindow = flag('no-context') ? 0 : parseInt(arg('context', '10'), 10);
  if (!Number.isInteger(contextWindow) || contextWindow < 0) {
    console.error(`--context must be a non-negative integer (got ${arg('context', '10')})`);
    process.exit(1);
  }
  const mode = arg('mode', 'sync');
  const concurrency = parseInt(arg('concurrency', '4'), 10);

  const factory = config.extractors[extractorName];
  if (factory === undefined) {
    console.error(`unknown extractor '${extractorName}'`);
    process.exit(1);
  }
  const extractor = factory({ model, contextWindow, ...(effort !== undefined ? { effort } : {}) });
  if (mode === 'batch' && !isBatchExtractor(extractor)) {
    console.error(`extractor '${extractorName}' does not support batch mode`);
    process.exit(1);
  }

  // The workflow seal, enforced mechanically: a holdout run must match the
  // frozen configuration (goldgate freeze). --allow-unfrozen proceeds
  // anyway but the violation is recorded in the event log, visibly.
  const actualMode = isBatchExtractor(extractor) ? 'batch' as const : 'sync' as const;
  const allowUnfrozen = flag('allow-unfrozen');
  const wfPath = workflowPath(config.paths);
  const events = readWorkflow(wfPath);
  let holdoutVerdict: Extract<HoldoutVerdict, { ok: true }> | null = null;
  // Drift the frozen-config seal (checkHoldoutRun) doesn't cover: a stale
  // operating threshold or a partially-labeled holdout. Either forces the
  // recorded event to `unfrozen` when proceeding under --allow-unfrozen.
  let holdoutUnfrozen = false;
  if (split === 'holdout') {
    const verdict = checkHoldoutRun(events, {
      extractor: extractorName, model,
      ...(effort !== undefined ? { effort } : {}),
      contextWindow, mode: actualMode,
      ...(config.task.configHashes !== undefined ? { configHashes: config.task.configHashes } : {}),
    }, allowUnfrozen);
    if (!verdict.ok) {
      for (const r of verdict.reasons) console.error(r);
      process.exit(1);
    }
    for (const w of verdict.warnings) console.warn(w);
    holdoutVerdict = verdict;

    // The gate is recorded at the frozen operating threshold. If the task no
    // longer declares that threshold (confidenceLevels edited after the
    // freeze), the run emits no matching block and the verdict would be
    // silently recorded at a different threshold. Refuse before spending a run.
    const frozenThreshold = latestFreeze(events)?.frozen.threshold;
    if (frozenThreshold !== undefined && !(config.task.confidenceLevels ?? []).includes(frozenThreshold)) {
      const levels = (config.task.confidenceLevels ?? []).join(', ') || 'none';
      const msg =
        `holdout eval refused: frozen operating threshold '${frozenThreshold}' is no longer one of the ` +
        `task's confidenceLevels (${levels}) — the gate would be recorded at the wrong threshold; ` +
        `re-freeze to declare a new round`;
      if (!allowUnfrozen) {
        console.error(msg);
        process.exit(1);
      }
      console.warn(msg + ' — recorded as unfrozen');
      holdoutUnfrozen = true;
    }
  }

  const corpus = readJsonlFile<{ id: string; text: string }>(corpusPath);
  const labels = readJsonlFile(labelsPath);
  const sample = readJsonlFile<SampleItem>(samplePath);

  // The sealed holdout must be fully labeled before its single gate run. An
  // eval over a partially-labeled holdout silently scores only the labeled
  // subset (the rest are counted as itemsSkipped) — which would let `decide`
  // ship on a fraction of the test set. Refuse while any holdout item is
  // unlabeled, before spending a run.
  if (split === 'holdout') {
    const pending = pendingItems(sample, labels, 'holdout', config.task);
    if (pending.length > 0) {
      const msg =
        `holdout eval refused: ${pending.length} holdout item(s) still unlabeled — the sealed holdout ` +
        `must be fully labeled before its single gate run (goldgate label --split holdout)`;
      if (!allowUnfrozen) {
        console.error(msg);
        process.exit(1);
      }
      console.warn(msg + ' — proceeding and recording as unfrozen');
      holdoutUnfrozen = true;
    }
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const runId = `${stamp}-${extractorName}-${split}`;

  const costPer1MTokens = config.costPer1MTokens?.[model];

  const summary = await runEval({
    task: config.task, corpus, labels, sample, split,
    extractor, extractorName, model, contextWindow,
    ...(effort !== undefined ? { effort } : {}),
    mode,
    outDir: config.paths.outDir,
    runId,
    concurrency,
    configExtras: {
      corpusHash: sha256Hex(readFileSync(corpusPath, 'utf8')),
      labelsHash: sha256Hex(readFileSync(labelsPath, 'utf8')),
    },
    ...(costPer1MTokens !== undefined ? { costPer1MTokens } : {}),
  });
  console.log(`done: ${summary.items.length} items, ${summary.pooled.errored} errored`);
  console.log(`report: ${summary.reportPath}`);

  // Gate verdict at the frozen operating threshold when one was declared,
  // else at the most inclusive block. A frozen threshold with no matching
  // block was already refused above (unless --allow-unfrozen), so the
  // fallback here only applies to unfrozen/unthresholded runs.
  const frozenThreshold = split === 'holdout' ? latestFreeze(events)?.frozen.threshold : undefined;
  const block = (frozenThreshold !== undefined
    ? summary.perThreshold.find((b) => b.threshold === frozenThreshold)
    : undefined) ?? summary.perThreshold[0];
  if (block !== undefined) {
    console.log(`gate @ threshold ${block.threshold ?? '(none)'}: ${block.gate.pass ? 'PASS' : 'FAIL'}`);
    for (const r of block.gate.reasons) console.log(`  - ${r}`);
  }

  if (split === 'holdout' && holdoutVerdict !== null) {
    appendWorkflowEvent(wfPath, {
      at: new Date().toISOString(), type: 'holdout-eval',
      round: holdoutVerdict.round, runId, gate: block?.gate ?? null,
      repeat: holdoutVerdict.repeat,
      ...(holdoutVerdict.unfrozen || holdoutUnfrozen ? { unfrozen: true } : {}),
    });
  }
}

async function cmdFreeze(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const extractorName = arg('extractor');
  const model = arg('model', config.defaultModel);
  const effort = argOpt('effort');
  const contextWindow = flag('no-context') ? 0 : parseInt(arg('context', '10'), 10);
  if (!Number.isInteger(contextWindow) || contextWindow < 0) {
    console.error(`--context must be a non-negative integer (got ${arg('context', '10')})`);
    process.exit(1);
  }
  const threshold = argOpt('threshold');
  const note = argOpt('note');

  const wfPath = workflowPath(config.paths);
  const events = readWorkflow(wfPath);
  const prior = latestFreeze(events);
  const event = buildFreezeEvent(config, events, {
    extractor: extractorName, model,
    ...(effort !== undefined ? { effort } : {}),
    contextWindow,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(note !== undefined ? { note } : {}),
  }, new Date().toISOString());
  appendWorkflowEvent(wfPath, event);

  if (prior !== undefined && holdoutEvalsInRound(events, prior.round).length === 0) {
    console.warn(`round ${prior.round} was frozen but never holdout-evaluated — superseded by round ${event.round}`);
  }
  console.log(
    `frozen (round ${event.round}): ${event.frozen.extractor} / ${event.frozen.model}` +
    ` · context ${event.frozen.contextWindow} · mode ${event.frozen.mode}` +
    (event.frozen.effort !== undefined ? ` · effort ${event.frozen.effort}` : '') +
    (event.frozen.threshold !== undefined ? ` · threshold ≥ ${event.frozen.threshold}` : ''),
  );
  console.log('holdout is now evaluable with exactly this configuration: goldgate eval --split holdout');
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const samplePath = argOpt('sample') ?? config.paths.sample;
  const labelsPath = argOpt('labels') ?? config.paths.labels;
  const sample = existsSync(samplePath) ? readJsonlFile<SampleItem>(samplePath) : [];
  const labels = existsSync(labelsPath) ? readJsonlFile<unknown>(labelsPath) : [];
  const events = readWorkflow(workflowPath(config.paths));
  const status = deriveStatus({ events, sample, labels, task: config.task });

  const bar = (p: SplitProgress): string =>
    `${p.labeled}/${p.total} labeled (${p.hand} hand, ${p.assisted} assisted), ${p.pending} pending`;
  console.log(`stage: ${status.stage}   round: ${status.round}`);
  console.log(`dev:     ${bar(status.dev)}`);
  console.log(`holdout: ${bar(status.holdout)}`);
  if (status.frozen !== null) {
    const f = status.frozen;
    console.log(
      `frozen @ ${f.at}: ${f.extractor} / ${f.model} · context ${f.contextWindow} · mode ${f.mode}` +
      (f.threshold !== undefined ? ` · threshold ≥ ${f.threshold}` : ''),
    );
    console.log(`holdout evals this round: ${status.holdoutEvalsThisRound}`);
  }
  if (status.decision !== null) {
    console.log(
      `decision: ${status.decision.ship ? 'SHIP' : 'NO-SHIP'} @ ${status.decision.at}` +
      (status.decision.runId !== undefined ? ` (run ${status.decision.runId})` : ''),
    );
  }
  const { runs } = listRuns(config.paths.outDir);
  if (runs.length > 0) {
    const pctOf = (x: number): string => (x * 100).toFixed(1) + '%';
    console.log('\nlatest runs:');
    for (const r of runs.slice(0, 5)) {
      const t0 = r.thresholds[0];
      console.log(`  ${r.runId}  ${r.split}  ` + (t0 === undefined ? '(no metrics)' :
        `${t0.pass ? 'PASS' : 'FAIL'} precision ${pctOf(t0.precision)} (Wilson95↓ ${pctOf(t0.precisionWilsonLower)}, n=${t0.predictedPositives}) recall ${pctOf(t0.recall)}`));
    }
  }
  console.log(`\nnext: ${status.nextStep}`);
}

async function cmdDecide(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const ship = flag('ship');
  const noShip = flag('no-ship');
  if (ship === noShip) {
    console.error('pass exactly one of --ship / --no-ship');
    process.exit(1);
  }
  const note = argOpt('note');
  const wfPath = workflowPath(config.paths);
  const event = buildDecisionEvent(
    readWorkflow(wfPath),
    { ship, ...(note !== undefined ? { note } : {}) },
    new Date().toISOString(),
  );
  appendWorkflowEvent(wfPath, event);
  console.log(`decision recorded: ${ship ? 'SHIP' : 'NO-SHIP'} (round ${event.round ?? '(unfrozen)'}, run ${event.runId})`);
}

async function cmdServe(): Promise<void> {
  const configPath = arg('config');
  const config = await loadConfig(configPath);
  const port = parseInt(arg('port', '4770'), 10);
  const host = argOpt('host');
  const { url } = await startServer({ config, configPath, port, ...(host !== undefined ? { host } : {}) });
  console.log(`goldgate serve: ${url}`);
  console.log('workflow overview, run dashboards, and the labeling reviewer are in the browser · Ctrl-C to stop');
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === 'sample') return cmdSample();
  if (sub === 'label') return cmdLabel();
  if (sub === 'eval') return cmdEval();
  if (sub === 'freeze') return cmdFreeze();
  if (sub === 'status') return cmdStatus();
  if (sub === 'decide') return cmdDecide();
  if (sub === 'serve') return cmdServe();
  console.error('usage: goldgate <sample|label|eval|freeze|status|decide|serve> --config <path> [...]');
  process.exit(2);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
