import type { CalibrationRow, KindMetrics, PooledMetrics, GateResult, FieldScores } from './metrics.js';
import type { TokenUsage } from './task.js';

export interface ThresholdBlock {
  threshold: string | null;
  perKind: KindMetrics[];
  pooled: PooledMetrics;
  confusion: Record<string, Record<string, number>>;
  negativeFpRate: number | null;
  fields: FieldScores | null;
  gate: GateResult;
}

export interface ReportMeta {
  gatedLabel: string;
  costPer1MTokens?: { in: number; out: number };
}

const pct = (x: number): string => (x * 100).toFixed(1) + '%';

export function renderReport(
  config: Record<string, unknown>,
  blocks: ThresholdBlock[],
  calibration: CalibrationRow[] | null,
  usage: TokenUsage,
  itemCount: number,
  latencySumMs: number,
  meta: ReportMeta,
): string {
  const lines: string[] = [];
  lines.push(`# Eval run ${String(config['runId'])}`);
  lines.push('');
  lines.push('## Config');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(config, null, 2));
  lines.push('```');
  lines.push('');
  const price = meta.costPer1MTokens;
  const cost = price === undefined ? null :
    (usage.inputTokens / 1_000_000) * price.in + (usage.outputTokens / 1_000_000) * price.out;
  lines.push(`Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out` +
    (cost !== null ? ` — est. $${cost.toFixed(2)}` : '') +
    ` · mean latency ${itemCount === 0 ? 0 : Math.round(latencySumMs / itemCount)}ms/item`);
  lines.push('');
  for (const b of blocks) {
    lines.push(`## Threshold ≥ ${b.threshold ?? '(none)'}`);
    lines.push('');
    const summary = [
      `Pooled (${meta.gatedLabel}): precision ${pct(b.pooled.precision)} ` +
        `(Wilson95 lower ${pct(b.pooled.precisionWilsonLower)}, n=${b.pooled.predictedPositives}) · ` +
        `recall ${pct(b.pooled.recall)}`,
    ];
    if (b.negativeFpRate !== null) {
      summary.push(`negative-kind FP rate (random stratum) ${pct(b.negativeFpRate)}`);
    }
    if (b.fields !== null) {
      summary.push(`structured fields ${pct(b.fields.structuredExactMatch)} (${b.fields.comparisons} comparisons)`);
    }
    summary.push(`errored items: ${b.pooled.errored}`);
    lines.push(summary.join(' · '));
    lines.push('');
    lines.push(`Gate: ${b.gate.pass ? 'PASS' : 'FAIL'}`);
    for (const r of b.gate.reasons) lines.push(`- ${r}`);
    lines.push('');
    lines.push('| kind | tp | fp | fn | precision | Wilson95↓ | recall | f1 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const k of b.perKind) {
      lines.push(`| ${k.kind} | ${k.tp} | ${k.fp} | ${k.fn} | ${pct(k.precision)} | ${pct(k.precisionWilsonLower)} | ${pct(k.recall)} | ${pct(k.f1)} |`);
    }
    lines.push('');
    if (b.fields !== null && b.fields.mismatches.length > 0) {
      lines.push('<details><summary>Field mismatches (human review)</summary>');
      lines.push('');
      for (const mm of b.fields.mismatches) {
        lines.push(`- ${mm.itemId} ${mm.field}: gold="${mm.gold}" predicted="${mm.predicted}"`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }
  lines.push('## Calibration (self-reported confidence vs observed precision)');
  lines.push('');
  if (calibration !== null) {
    lines.push('| confidence | typed predictions | correct | observed precision |');
    lines.push('|---|---|---|---|');
    for (const c of calibration) {
      lines.push(`| ${c.confidence} | ${c.predictions} | ${c.correct} | ${pct(c.observedPrecision)} |`);
    }
  } else {
    lines.push('_(no calibration — task declares no confidence levels)_');
  }
  lines.push('');
  return lines.join('\n');
}
