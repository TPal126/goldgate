// Run-directory scanning for `goldgate status` and the serve dashboards.
// Reads only what the runner wrote (results.json per run dir) — the run
// artifacts stay the single source of truth; nothing is indexed or cached
// where it could drift.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ThresholdBlock } from './report.js';
import type { CalibrationRow, EvalItem } from './metrics.js';
import type { TokenUsage } from './task.js';

/** Shape of a run dir's results.json — what runner.ts writes. */
export interface RunResults {
  config: Record<string, unknown> & {
    runId: string; split: string; extractor: string; model: string;
    contextWindow: number; effort: string; mode: string;
    itemCount: number; itemsSampledForSplit: number; itemsSkipped: number;
  };
  perThreshold: ThresholdBlock[];
  calibration: CalibrationRow[] | null;
  totalUsage: TokenUsage;
  items: EvalItem<unknown, unknown>[];
}

export interface RunThresholdSummary {
  threshold: string | null;
  pass: boolean;
  precision: number;
  precisionWilsonLower: number;
  recall: number;
  predictedPositives: number;
}

export interface RunListing {
  runId: string;
  at: string;                 // ISO mtime of results.json
  split: string;
  extractor: string;
  model: string;
  mode: string;
  effort: string;
  contextWindow: number;
  itemCount: number;
  errored: number;
  totalUsage: TokenUsage;
  thresholds: RunThresholdSummary[];
}

// Run ids come from the filesystem and go back into paths — keep them to a
// conservative charset so a crafted directory name can't traverse.
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

export function isSafeRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId) && !runId.includes('..');
}

/** Full parsed results.json for one run, or null if absent/invalid. */
export function readRun(outDir: string, runId: string): RunResults | null {
  if (!isSafeRunId(runId)) return null;
  const path = join(resolve(outDir), runId, 'results.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunResults;
  } catch {
    return null;
  }
}

/** All runs under outDir, newest first. Unparseable dirs are skipped —
 *  they are surfaced as `skipped` so a corrupt run never vanishes silently. */
export function listRuns(outDir: string): { runs: RunListing[]; skipped: string[] } {
  const runs: RunListing[] = [];
  const skipped: string[] = [];
  if (!existsSync(outDir)) return { runs, skipped };

  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeRunId(entry.name)) continue;
    const resultsPath = join(outDir, entry.name, 'results.json');
    if (!existsSync(resultsPath)) continue;   // not a run dir
    const r = readRun(outDir, entry.name);
    if (r === null || r.config === undefined || !Array.isArray(r.perThreshold)) {
      skipped.push(entry.name);
      continue;
    }
    // A results.json can parse yet still be shaped wrong (a truncated write,
    // a hand-edited file, a future/older schema). Building the summary is
    // wrapped so one malformed run is surfaced in `skipped` rather than
    // 500-ing every dashboard endpoint that lists runs.
    try {
      runs.push({
        runId: r.config.runId ?? entry.name,
        at: statSync(resultsPath).mtime.toISOString(),
        split: String(r.config.split),
        extractor: String(r.config.extractor),
        model: String(r.config.model),
        mode: String(r.config.mode),
        effort: String(r.config.effort),
        contextWindow: Number(r.config.contextWindow),
        itemCount: Number(r.config.itemCount),
        errored: r.perThreshold[0]?.pooled?.errored ?? 0,
        totalUsage: r.totalUsage,
        thresholds: r.perThreshold.map((b) => ({
          threshold: b.threshold,
          pass: b.gate.pass,
          precision: b.pooled.precision,
          precisionWilsonLower: b.pooled.precisionWilsonLower,
          recall: b.pooled.recall,
          predictedPositives: b.pooled.predictedPositives,
        })),
      });
    } catch {
      skipped.push(entry.name);
    }
  }
  runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { runs, skipped };
}
