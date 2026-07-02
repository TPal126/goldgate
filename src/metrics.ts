import type { TaskSpec, GateThresholds } from './task.js';

export interface EvalItem<Gold, Pred> {
  itemId: string;
  stratum: 'random' | 'boosted';
  gold: Gold;
  predicted: Pred | null;  // null = errored item (visible, never silent)
  error?: string;
}

type Task<G, P> = TaskSpec<{ id: string; text: string }, G, P>;

// Wilson score interval, lower bound, z=1.96 (95%). Every headline
// proportion carries this plus its raw denominator.
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (center - margin) / denom;
}

function scored<G, P>(items: EvalItem<G, P>[]): { item: EvalItem<G, P>; predicted: P }[] {
  return items.flatMap((i) => (i.predicted === null ? [] : [{ item: i, predicted: i.predicted }]));
}

export function confusionMatrix<G, P>(
  items: EvalItem<G, P>[], task: Task<G, P>, threshold?: string,
): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const g of task.kinds) {
    m[g] = {};
    for (const p of task.kinds) m[g]![p] = 0;
  }
  for (const { item, predicted } of scored(items)) {
    m[task.kindOfGold(item.gold)]![task.kindOfPred(predicted, threshold)]! += 1;
  }
  return m;
}

export interface KindMetrics {
  kind: string;
  tp: number; fp: number; fn: number;
  precision: number; recall: number; f1: number;
  precisionWilsonLower: number;
}

export function perKindMetrics<G, P>(items: EvalItem<G, P>[], task: Task<G, P>, threshold?: string): KindMetrics[] {
  return task.kinds.map((kind) => {
    let tp = 0, fp = 0, fn = 0;
    for (const { item, predicted } of scored(items)) {
      const p = task.kindOfPred(predicted, threshold);
      const g = task.kindOfGold(item.gold);
      if (p === kind && g === kind) tp++;
      else if (p === kind && g !== kind) fp++;
      else if (p !== kind && g === kind) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { kind, tp, fp, fn, precision, recall, f1, precisionWilsonLower: wilsonLower(tp, tp + fp) };
  });
}

export interface PooledMetrics {
  tp: number; fp: number; fn: number;
  predictedPositives: number;
  precision: number; precisionWilsonLower: number;
  recall: number;
  errored: number;
}

// Micro-averaged over the gated kinds — the decisive Gate 1 number.
export function pooledGatedMetrics<G, P>(items: EvalItem<G, P>[], task: Task<G, P>, threshold?: string): PooledMetrics {
  let tp = 0, fp = 0, fn = 0;
  for (const { item, predicted } of scored(items)) {
    const p = task.kindOfPred(predicted, threshold);
    const g = task.kindOfGold(item.gold);
    const pGated = task.gatedKinds.includes(p);
    const gGated = task.gatedKinds.includes(g);
    if (pGated && p === g) tp++;
    else if (pGated) fp++;            // wrong kind or gold not gated
    if (gGated && p !== g) fn++;      // gated gold not recovered exactly
  }
  const predictedPositives = tp + fp;
  const precision = predictedPositives === 0 ? 0 : tp / predictedPositives;
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    tp, fp, fn, predictedPositives, precision,
    precisionWilsonLower: wilsonLower(tp, predictedPositives),
    recall,
    errored: items.filter((i) => i.predicted === null).length,
  };
}

// Random-stratum-only negative-kind FP rate. Returns null when the task
// has no negativeKind (all-positive tasks) — the gate criterion is then
// skipped. Boosted items are dropped HERE regardless of caller (contract).
export function negativeFpRate<G, P>(items: EvalItem<G, P>[], task: Task<G, P>, threshold?: string): number | null {
  if (task.negativeKind === undefined) return null;
  const neg = task.negativeKind;
  const randomOnly = items.filter((i) => i.stratum === 'random');
  const goldNegative = scored(randomOnly).filter(({ item }) => task.kindOfGold(item.gold) === neg);
  if (goldNegative.length === 0) return 0;
  const fps = goldNegative.filter(({ predicted }) => task.kindOfPred(predicted, threshold) !== neg);
  return fps.length / goldNegative.length;
}

export interface CalibrationRow {
  confidence: string;
  predictions: number;        // typed (non-negative) predictions at this level
  correct: number;
  observedPrecision: number;
}

// Rows emitted highest-confidence-first (matches the historical table).
// Null when the task declares no confidence machinery.
export function calibrationTable<G, P>(items: EvalItem<G, P>[], task: Task<G, P>): CalibrationRow[] | null {
  if (task.confidenceLevels === undefined || task.confidenceOfPred === undefined) return null;
  const confOf = task.confidenceOfPred.bind(task);
  return [...task.confidenceLevels].reverse().map((confidence) => {
    const typed = scored(items).filter(
      ({ predicted }) => task.kindOfPred(predicted) !== task.negativeKind && confOf(predicted) === confidence,
    );
    const correct = typed.filter(({ item, predicted }) => task.kindOfPred(predicted) === task.kindOfGold(item.gold));
    return {
      confidence,
      predictions: typed.length,
      correct: correct.length,
      observedPrecision: typed.length === 0 ? 0 : correct.length / typed.length,
    };
  });
}

export const normalizeField = (s: string): string => s.trim().toLowerCase().replace(/^@/, '');
const tokens = (s: string): string[] => normalizeField(s).split(/[^a-z0-9]+/).filter((t) => t.length > 0);

export function tokenF1(a: string, b: string): number {
  const ta = tokens(a); const tb = new Set(tokens(b));
  if (ta.length === 0 || tb.size === 0) return 0;
  const overlap = ta.filter((t) => tb.has(t)).length;
  const p = overlap / ta.length;
  const r = overlap / tb.size;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export interface FieldScores {
  comparisons: number;          // structured-field comparisons made
  structuredMatches: number;
  structuredExactMatch: number; // Gate 1 criterion 4 input
  freeTextAvgTokenF1: number;
  mismatches: { itemId: string; field: string; gold: string; predicted: string }[];
}

// On true positives only (kind correct at threshold). Structured fields
// exact-match after normalization; free text scored by tokenF1 and dumped
// for human review. Null when the task declares no field comparisons.
export function fieldScores<G, P>(items: EvalItem<G, P>[], task: Task<G, P>, threshold?: string): FieldScores | null {
  if (task.compareFields === undefined) return null;
  const cmp = task.compareFields.bind(task);
  let comparisons = 0, structuredMatches = 0, freeTextSum = 0, freeTextN = 0;
  const mismatches: FieldScores['mismatches'] = [];

  for (const { item, predicted } of scored(items)) {
    if (task.kindOfPred(predicted, threshold) !== task.kindOfGold(item.gold)) continue;
    for (const c of cmp(item.gold, predicted)) {
      if (c.type === 'structured') {
        comparisons++;
        if (normalizeField(c.gold) === normalizeField(c.predicted)) structuredMatches++;
        else mismatches.push({ itemId: item.itemId, field: c.field, gold: c.gold, predicted: c.predicted });
      } else {
        freeTextSum += tokenF1(c.gold, c.predicted); freeTextN++;
      }
    }
  }
  return {
    comparisons,
    structuredMatches,
    structuredExactMatch: comparisons === 0 ? 0 : structuredMatches / comparisons,
    freeTextAvgTokenF1: freeTextN === 0 ? 0 : freeTextSum / freeTextN,
    mismatches,
  };
}

export interface GateInput {
  pooledPrecision: number;
  pooledPrecisionWilsonLower: number;
  pooledRecall: number;
  predictedPositives: number;
  negativeFpRate: number | null;        // null = criterion skipped
  structuredExactMatch: number | null;  // null = criterion skipped
}

export interface GateResult { pass: boolean; reasons: string[] }

// Gate 1: all criteria on the holdout, frozen configuration.
export const DEFAULT_GATE: GateThresholds = {
  minPooledPrecision: 0.90,
  minWilsonLower: 0.80,
  minPooledRecall: 0.60,
  minPredictedPositives: 40,
  maxNegativeFpRate: 0.05,
  minStructuredExactMatch: 0.85,
};

export function checkGate<G, P>(g: GateInput, task: Task<G, P>): GateResult {
  const t: GateThresholds = { ...DEFAULT_GATE, ...task.gate };
  const reasons: string[] = [];
  if (g.predictedPositives < t.minPredictedPositives) {
    reasons.push(
      `undersized denominator: ${g.predictedPositives} pooled predicted positives < ${t.minPredictedPositives} — label more and re-seal before evaluating`,
    );
  }
  if (g.pooledPrecision < t.minPooledPrecision) {
    reasons.push(`pooled precision ${g.pooledPrecision.toFixed(3)} < ${t.minPooledPrecision}`);
  }
  if (g.pooledPrecisionWilsonLower < t.minWilsonLower) {
    reasons.push(`Wilson 95% lower bound ${g.pooledPrecisionWilsonLower.toFixed(3)} < ${t.minWilsonLower}`);
  }
  if (g.pooledRecall < t.minPooledRecall) {
    reasons.push(`pooled recall ${g.pooledRecall.toFixed(3)} < ${t.minPooledRecall}`);
  }
  if (g.negativeFpRate !== null && g.negativeFpRate > t.maxNegativeFpRate) {
    reasons.push(`negative-kind FP rate (random stratum) ${g.negativeFpRate.toFixed(3)} > ${t.maxNegativeFpRate}`);
  }
  if (g.structuredExactMatch !== null && g.structuredExactMatch < t.minStructuredExactMatch) {
    reasons.push(`structured-field exact match ${g.structuredExactMatch.toFixed(3)} < ${t.minStructuredExactMatch}`);
  }
  return { pass: reasons.length === 0, reasons };
}
