import { describe, it, expect } from 'vitest';
import { stratifiedSample, mulberry32 } from '../src/sample.js';

// Sampler contracts are task-agnostic (SampleOptions.patterns is a plain
// RegExp[]), so the toy pattern from the brief stands in for the source
// pipeline's DEFAULT_BOOST_PATTERNS.
const BOOST_PATTERNS = [/crash/i];

function corpus(n: number): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (let i = 0; i < n; i++) {
    // Every 5th ticket mentions a crash; the rest are mundane requests.
    const boosted = i % 5 === 0;
    out.push({
      id: `t${i}`,
      text: boosted ? `ticket ${i}: the app crashes on save` : `mundane request number ${i}`,
    });
  }
  return out;
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42); const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('stratifiedSample', () => {
  const tickets = corpus(1000);
  const opts = { total: 200, boostedShare: 0.4, holdoutShare: 0.3, seed: 7, patterns: BOOST_PATTERNS };

  it('is deterministic for a given seed', () => {
    expect(stratifiedSample(tickets, opts)).toEqual(stratifiedSample(tickets, opts));
  });

  it('produces the requested total with no duplicates', () => {
    const s = stratifiedSample(tickets, opts);
    expect(s).toHaveLength(200);
    expect(new Set(s.map((i) => i.itemId)).size).toBe(200);
  });

  it('records strata: boosted items match a boost pattern', () => {
    const s = stratifiedSample(tickets, opts);
    const byId = new Map(tickets.map((m) => [m.id, m]));
    const boosted = s.filter((i) => i.stratum === 'boosted');
    expect(boosted.length).toBe(80); // 40% of 200
    for (const item of boosted) {
      const text = byId.get(item.itemId)!.text;
      expect(BOOST_PATTERNS.some((p) => p.test(text))).toBe(true);
    }
  });

  it('splits ~70/30 dev/holdout within each stratum', () => {
    const s = stratifiedSample(tickets, opts);
    const holdout = s.filter((i) => i.split === 'holdout');
    expect(holdout.length).toBeGreaterThanOrEqual(55);
    expect(holdout.length).toBeLessThanOrEqual(65);
    const boostedHoldout = s.filter((i) => i.stratum === 'boosted' && i.split === 'holdout');
    expect(boostedHoldout.length).toBeGreaterThanOrEqual(20);
    expect(boostedHoldout.length).toBeLessThanOrEqual(28);
  });

  it('redistributes a boosted-pool shortfall into the random stratum (never a silent short-sample)', () => {
    // 1000 tickets, every 25th boosted -> pool of 40 < nBoosted (80).
    const sparse = corpus(1000).map((m, i) => ({
      ...m,
      text: i % 25 === 0 ? `ticket ${i}: the app crashes on save` : `mundane request number ${i}`,
    }));
    const s = stratifiedSample(sparse, opts);
    expect(s).toHaveLength(200); // full total despite the shortfall
    expect(s.filter((i) => i.stratum === 'boosted').length).toBe(40);
    expect(s.filter((i) => i.stratum === 'random').length).toBe(160);
  });

  it('throws loudly when the corpus is smaller than the requested total', () => {
    expect(() => stratifiedSample(corpus(50), opts)).toThrow(/corpus too small/i);
  });
});
