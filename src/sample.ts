// Stratified sampling (spec §3.3): a random base plus keyword-boosted
// oversampling so rare kinds appear in labelable quantity. The dev/holdout
// split happens HERE, at sampling time, before any labeling or extraction —
// the holdout stays sealed until dev work is frozen (spec §3.5 protocol).

export interface SampleItem {
  itemId: string;
  stratum: 'random' | 'boosted';
  split: 'dev' | 'holdout';
}

export interface SampleOptions {
  total: number;
  boostedShare: number;   // fraction of total drawn from keyword matches
  holdoutShare: number;   // fraction of each stratum sealed as holdout
  seed: number;
  patterns?: RegExp[];
}

// Small deterministic PRNG — no Math.random so samples are reproducible.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]!; a[i] = a[j]!; a[j] = tmp;
  }
  return a;
}

export function stratifiedSample(
  messages: { id: string; text: string }[],
  opts: SampleOptions,
): SampleItem[] {
  const patterns = opts.patterns ?? [];
  const rand = mulberry32(opts.seed);

  const nBoosted = Math.round(opts.total * opts.boostedShare);

  const boostedPool = messages.filter((m) => patterns.some((p) => p.test(m.text)));
  const boostedPick = shuffled(boostedPool, rand).slice(0, nBoosted);
  const picked = new Set(boostedPick.map((m) => m.id));

  // Redistribute any boosted-pool shortfall into the random stratum so the
  // sample never comes back silently short of opts.total. If the whole
  // corpus is smaller than opts.total, fail loudly — an undersized sample
  // feeding the eval is exactly the silent-truncation hazard to avoid.
  const nRandom = opts.total - boostedPick.length;
  const randomPool = messages.filter((m) => !picked.has(m.id));
  if (randomPool.length < nRandom) {
    throw new Error(
      `corpus too small: requested total ${opts.total} but only ` +
      `${boostedPick.length + randomPool.length} messages available`,
    );
  }
  const randomPick = shuffled(randomPool, rand).slice(0, nRandom);

  const assign = (pick: { id: string; text: string }[], stratum: 'random' | 'boosted'): SampleItem[] => {
    const ordered = shuffled(pick, rand);
    const nHoldout = Math.round(ordered.length * opts.holdoutShare);
    return ordered.map((m, i) => ({
      itemId: m.id,
      stratum,
      split: i < nHoldout ? 'holdout' as const : 'dev' as const,
    }));
  };

  // Fixed order (boosted first) — the shared PRNG advances through the
  // boosted assignment before the random one, so holdout membership in the
  // random stratum depends on (seed, boosted size). Deterministic, but
  // changing boostedShare reshuffles the random stratum's split too.
  return [...assign(boostedPick, 'boosted'), ...assign(randomPick, 'random')];
}
