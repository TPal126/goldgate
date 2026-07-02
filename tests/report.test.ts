import { describe, it, expect } from 'vitest';
import { renderReport } from '../src/report.js';

const block = {
  threshold: 'low' as string | null,
  perKind: [{ kind: 'bug', tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1, precisionWilsonLower: 0.2 }],
  pooled: { tp: 1, fp: 0, fn: 0, predictedPositives: 1, precision: 1, precisionWilsonLower: 0.2, recall: 1, errored: 0 },
  confusion: { bug: { bug: 1 } },
  negativeFpRate: 0.1 as number | null,
  fields: null,
  gate: { pass: false, reasons: ['undersized denominator: 1 pooled predicted positives < 40'] },
};

describe('renderReport', () => {
  it('derives the pooled label from meta and prints cost only when pricing is given', () => {
    const withCost = renderReport({ runId: 'r' }, [block], null, { inputTokens: 1_000_000, outputTokens: 0 }, 1, 100,
      { gatedLabel: 'bug+feature', costPer1MTokens: { in: 5, out: 25 } });
    expect(withCost).toContain('Pooled (bug+feature)');
    expect(withCost).toContain('est. $5.00');
    const noCost = renderReport({ runId: 'r' }, [block], null, { inputTokens: 1_000_000, outputTokens: 0 }, 1, 100,
      { gatedLabel: 'bug+feature' });
    expect(noCost).not.toContain('est. $');
  });

  it('omits field and calibration sections when null', () => {
    const out = renderReport({ runId: 'r' }, [block], null, { inputTokens: 0, outputTokens: 0 }, 1, 0,
      { gatedLabel: 'x' });
    expect(out).not.toContain('structured fields');
    expect(out).toContain('no calibration');
  });
});
