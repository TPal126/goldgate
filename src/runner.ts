import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskSpec, TaskExtractor, ExtractFn, TokenUsage } from './task.js';
import { isBatchExtractor } from './task.js';
import type { SampleItem } from './sample.js';
import {
  type EvalItem, perKindMetrics, pooledGatedMetrics, confusionMatrix,
  negativeFpRate, calibrationTable, fieldScores, checkGate,
  type PooledMetrics,
} from './metrics.js';
import { renderReport } from './report.js';
import type { ThresholdBlock } from './report.js';

export interface RunOptions<I extends { id: string; text: string }, G, P> {
  task: TaskSpec<I, G, P>;
  corpus: I[];
  labels: G[];
  sample: SampleItem[];
  split: 'dev' | 'holdout';
  extractor: TaskExtractor<I, P>;
  extractorName: string;       // 'claude' | 'heuristic' | 'stub'
  model: string;               // model id or 'heuristic'
  contextWindow: number;       // 0 = --no-context
  // Recorded in the run config so two runs are only comparable when these
  // match. effort is '(n/a)' when omitted. mode is accepted here for
  // backward compatibility, but the value actually recorded is derived
  // from the extractor's shape (batch vs sync) — see the config object
  // built below — not read back from this field.
  effort?: string;
  mode?: string;               // 'sync' | 'batch'
  outDir: string;
  runId: string;
  concurrency: number;
  costPer1MTokens?: { in: number; out: number };
  // promptVersion, promptHash, schemaHash, guidelinesHash, corpusHash,
  // labelsHash, sdkVersion, … — task-agnostic provenance the caller wants
  // recorded verbatim in the run config.
  configExtras?: Record<string, string>;
}

export interface RunSummary<G, P> {
  items: EvalItem<G, P>[];
  pooled: PooledMetrics;       // at thresholds[0] (most inclusive)
  perThreshold: ThresholdBlock[];  // full metric blocks, one per threshold
  totalUsage: TokenUsage;
  reportPath: string;
}

export async function runEval<I extends { id: string; text: string }, G, P>(
  opts: RunOptions<I, G, P>,
): Promise<RunSummary<G, P>> {
  const byId = new Map(opts.corpus.map((m) => [m.id, m]));
  const labelById = new Map(opts.labels.map((l) => [opts.task.idOfGold(l), l]));
  const sampledForSplit = opts.sample.filter((s) => s.split === opts.split);
  const work = sampledForSplit.filter(
    (s) => labelById.has(s.itemId) && byId.has(s.itemId),
  );
  // No silent truncation: sampled items lacking a label or a corpus
  // message are skipped, and the skip count is recorded in config.
  const itemsSkipped = sampledForSplit.length - work.length;

  // Holdout guard: the holdout must be blind-labeled. Refuse before any
  // extraction runs if any in-scope label is 'assisted'.
  if (opts.split === 'holdout') {
    const assisted = work.filter((s) => opts.task.provenanceOfGold(labelById.get(s.itemId)!) === 'assisted');
    if (assisted.length > 0) {
      throw new Error(
        `holdout eval refused: ${assisted.length} label(s) have provenance 'assisted' — ` +
        `the holdout must be blind-labeled (relabel by hand and re-seal)`,
      );
    }
    console.warn(
      'holdout run: configuration must be frozen from the dev run — ' +
      'results are comparable only against that frozen configuration',
    );
  }

  const items: EvalItem<G, P>[] = new Array(work.length);
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let latencySumMs = 0;

  const extractor = opts.extractor;
  if (isBatchExtractor(extractor)) {
    const targets = work.map((s) => byId.get(s.itemId)!);
    const mapped = await extractor.batch(targets, opts.corpus);
    work.forEach((s, i) => {
      const gold = labelById.get(s.itemId)!;
      const r = mapped.get(s.itemId);
      if (r === undefined || r.prediction === null) {
        items[i] = {
          itemId: s.itemId, stratum: s.stratum, gold, predicted: null,
          error: r?.error ?? 'missing from batch results',
        };
      } else {
        if (r.usage !== undefined) {
          totalUsage.inputTokens += r.usage.inputTokens;
          totalUsage.outputTokens += r.usage.outputTokens;
        }
        items[i] = { itemId: s.itemId, stratum: s.stratum, gold, predicted: r.prediction };
      }
    });
  } else {
    // Simple bounded-concurrency pool. `fn` gets its own (non-narrowed)
    // declared type so the closure below doesn't need to re-derive the
    // narrowing of `extractor` across the function boundary.
    const fn: ExtractFn<I, P> = extractor;
    let next = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const i = next++;
        if (i >= work.length) return;
        const s = work[i]!;
        const target = byId.get(s.itemId)!;
        const gold = labelById.get(s.itemId)!;
        const started = Date.now();
        try {
          const r = await fn({
            target, context: opts.task.context?.(opts.corpus, target, opts.contextWindow) ?? [],
          });
          if (r.usage !== undefined) {
            totalUsage.inputTokens += r.usage.inputTokens;
            totalUsage.outputTokens += r.usage.outputTokens;
          }
          items[i] = { itemId: s.itemId, stratum: s.stratum, gold, predicted: r.prediction };
        } catch (e: unknown) {
          items[i] = {
            itemId: s.itemId, stratum: s.stratum, gold, predicted: null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        latencySumMs += Date.now() - started;
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  }

  const thresholds: (string | undefined)[] = opts.task.confidenceLevels !== undefined
    ? [...opts.task.confidenceLevels]
    : [undefined];

  const perThreshold = thresholds.map((t) => {
    const pooled = pooledGatedMetrics(items, opts.task, t);
    const msgFp = negativeFpRate(items, opts.task, t);
    const fields = fieldScores(items, opts.task, t);
    return {
      threshold: t ?? null,
      perKind: perKindMetrics(items, opts.task, t),
      pooled,
      confusion: confusionMatrix(items, opts.task, t),
      negativeFpRate: msgFp,
      fields,
      gate: checkGate({
        pooledPrecision: pooled.precision,
        pooledPrecisionWilsonLower: pooled.precisionWilsonLower,
        pooledRecall: pooled.recall,
        predictedPositives: pooled.predictedPositives,
        negativeFpRate: msgFp,
        structuredExactMatch: fields === null ? null : fields.structuredExactMatch,
      }, opts.task),
    };
  });

  const config = {
    runId: opts.runId,
    split: opts.split,
    extractor: opts.extractorName,
    model: opts.model,
    contextWindow: opts.contextWindow,
    effort: opts.effort ?? '(n/a)',
    // Derived from the actual dispatch, not opts.mode: what got recorded
    // must match what actually ran.
    mode: isBatchExtractor(opts.extractor) ? 'batch' : 'sync',
    itemCount: items.length,
    itemsSampledForSplit: sampledForSplit.length,
    itemsSkipped,
    ...opts.task.configHashes,
    ...opts.configExtras,
  };

  const calibration = calibrationTable(items, opts.task);
  const runDir = join(opts.outDir, opts.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'results.json'),
    JSON.stringify({ config, perThreshold, calibration, totalUsage, items }, null, 2),
    'utf8',
  );
  const reportPath = join(runDir, 'report.md');
  writeFileSync(reportPath, renderReport(
    config, perThreshold, calibration, totalUsage, items.length, latencySumMs,
    {
      gatedLabel: opts.task.gatedKinds.join('+'),
      ...(opts.costPer1MTokens !== undefined ? { costPer1MTokens: opts.costPer1MTokens } : {}),
    },
  ), 'utf8');

  return { items, pooled: pooledGatedMetrics(items, opts.task, thresholds[0]), perThreshold, totalUsage, reportPath };
}
