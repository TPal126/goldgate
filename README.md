# goldgate

[![CI](https://github.com/TPal126/goldgate/actions/workflows/test.yml/badge.svg)](https://github.com/TPal126/goldgate/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/goldgate)](https://www.npmjs.com/package/goldgate)

**A statistically-gated eval harness for LLM classification and extraction tasks.** You bring a task (a label taxonomy plus a handful of accessor functions) and a corpus; goldgate stratifies and seals a holdout, runs a blind-labeling CLI, and reports per-kind and pooled precision/recall with Wilson 95% lower bounds, a calibration table, and a pass/fail release gate that refuses to run on an undersized denominator. It is built to answer one question honestly: *is this extractor good enough to ship, and how sure are we?*

---

## Why this exists

Most "eval scripts" quietly lie. They report a bare `0.90` precision computed over 20 predictions, silently drop the items the model errored on, and let the same data that tuned the prompt also grade it. goldgate is a set of design invariants against exactly those failure modes:

- **Sealed holdouts, enforced twice.** The dev/holdout split is made at *sampling* time, before any labeling or extraction — the holdout file is sealed until dev work (prompt, model, thresholds) is frozen. It is re-checked at *eval* time: the runner refuses a holdout evaluation if any in-scope label carries `provenance: 'assisted'`, and warns that the configuration must be frozen from the dev run.
- **Blind labeling.** On the dev set, an extractor may pre-label to speed review (`--assist`). On the holdout, assistance is *refused* — the label CLI throws rather than show you a proposal, so holdout ground truth is formed against guidelines, not against model output.
- **Wilson lower bounds on every headline proportion.** No bare point estimates. A precision is reported as `92.5% (Wilson95 lower 82.1%, n=53)` — the interval and its raw denominator travel together, everywhere.
- **Precision-at-budget release gates.** The gate pools precision/recall over your "gated" kinds and checks a point estimate, its Wilson lower bound, recall, a negative-class false-positive rate, and structured-field exact match — each threshold overridable per task. If the holdout yields fewer than the minimum pooled predicted positives (default 40), the gate **refuses to run** and tells you to label more and re-seal, rather than blessing a number computed over too little data.
- **Calibration tables.** Every run with declared confidence levels emits observed precision at each self-reported confidence level, so `high`/`low` is validated against outcomes instead of trusted as self-report.
- **No silent truncation, as an invariant.** An undersized corpus *throws* at sampling time. Sampled items missing a label or corpus row are skipped and the skip count is recorded in the run config. Items the extractor errored on are scored as errors and counted visibly in the report — never dropped to flatter a number.

## Quickstart

The toy task below is a three-way ticket triage (`note` / `bug` / `feature`), adapted from the fixtures in `tests/`. It runs end-to-end with **no API key** — the `keyword` extractor is a deterministic offline stub so you can see the whole pipeline before wiring a model.

```bash
npm i -D goldgate
```

Create `goldgate.config.ts`:

```ts
import { defineConfig } from 'goldgate';
import type { TaskSpec, FieldComparison } from 'goldgate';

interface Ticket { id: string; text: string }
interface Gold { ticketId: string; provenance: 'hand' | 'assisted'; kind: 'note' | 'bug' | 'feature'; component?: string }
interface Pred { kind: 'note' | 'bug' | 'feature'; certainty: 'low' | 'high'; component?: string }

const RANK = { low: 0, high: 1 } as const;

const triageTask: TaskSpec<Ticket, Gold, Pred> = {
  kinds: ['note', 'bug', 'feature'],
  negativeKind: 'note',                        // the "nothing to file" class
  gatedKinds: ['bug', 'feature'],              // what the release gate pools
  confidenceLevels: ['low', 'high'],           // enables thresholding + calibration
  idOfGold: (g) => g.ticketId,
  kindOfGold: (g) => g.kind,
  provenanceOfGold: (g) => g.provenance,
  kindOfPred: (p, min) =>
    p.kind === 'note' || min === undefined
      ? p.kind
      : RANK[p.certainty] >= RANK[min as 'low' | 'high'] ? p.kind : 'note',
  confidenceOfPred: (p) => p.certainty,
  compareFields: (g, p): FieldComparison[] =>
    g.kind === 'bug' && p.kind === 'bug'
      ? [{ field: 'component', type: 'structured', gold: g.component ?? '(absent)', predicted: p.component ?? '(absent)' }]
      : [],
  boostPatterns: [/\b(crash|error|broken|fails?)\b/i],   // oversample likely bugs
  labeling: {
    goldFromPrediction: (ticketId, p, provenance) => ({
      ticketId, provenance, kind: p.kind, ...(p.component ? { component: p.component } : {}),
    }),
    promptGold: async ({ target, kind, io }) => ({
      ticketId: target.id, provenance: 'hand', kind: kind as Gold['kind'],
      ...(kind === 'bug' ? { component: await io.ask('component', 'core') } : {}),
    }),
  },
};

export default defineConfig({
  defaultModel: 'keyword',  // recorded in run config; any label works for API-free extractors
  task: triageTask,
  // Factory receives { model, effort?, contextWindow }; returns an ExtractFn.
  extractors: {
    keyword: () => async ({ target }) => ({
      prediction: {
        kind: /\b(crash|error|broken|fails?)\b/i.test(target.text) ? 'bug'
          : /\b(add|support|please|feature)\b/i.test(target.text) ? 'feature' : 'note',
        certainty: 'high',
      },
    }),
  },
  paths: {
    corpus: 'corpus/tickets.jsonl',   // one { "id", "text" } object per line
    sample: 'work/sample.jsonl',
    labels: 'work/labels.jsonl',
    outDir: 'work/runs',
  },
});
```

Provision a test corpus file `corpus/tickets.jsonl` with sample items (one per line):

```jsonl
{"id":"t-001","text":"app crash on save when disk is full","queue":"mobile"}
{"id":"t-002","text":"add dark mode to the settings screen","queue":"mobile"}
{"id":"t-003","text":"login fails with SSO after password rotation","queue":"web"}
{"id":"t-004","text":"error 500 from the export endpoint on large files","queue":"web"}
{"id":"t-005","text":"thanks for the quick turnaround last week","queue":"web"}
{"id":"t-006","text":"search results pagination is broken past page 3","queue":"web"}
{"id":"t-007","text":"could we get CSV import for bulk tickets","queue":"mobile"}
{"id":"t-008","text":"meeting notes from the retro attached","queue":"web"}
{"id":"t-009","text":"crash loop on startup after the 2.3 update","queue":"mobile"}
{"id":"t-010","text":"what is the SLA for enterprise plans","queue":"web"}
```

Then run the three stages:

```bash
# 1. Stratify + seal. Split (dev/holdout) is decided here, once, before labeling.
npx goldgate sample --config goldgate.config.ts \
  --total 8 --boosted-share 0.25 --holdout-share 0.25 --seed 7

# 2. Label the dev set in a small CLI. Add --assist keyword to pre-fill proposals
#    (proposals are refused on --split holdout — holdout is blind by construction).
npx goldgate label --config goldgate.config.ts --split dev

# 3. Evaluate. --context 10 (or --no-context), --mode sync|batch, --concurrency N.
npx goldgate eval --config goldgate.config.ts --split dev --extractor keyword
```

`eval` writes `work/runs/<run-id>/report.md` and `results.json`. With this quickstart corpus and config, the report looks like:

```
# Eval run 2026-07-02-15-03-keyword-dev

Tokens: 0 in / 0 out · mean latency 0ms/item

## Threshold ≥ low

Pooled (bug+feature): precision 100.0% (Wilson95 lower 43.8%, n=3) · recall 100.0% · negative-kind FP rate (random stratum) 0.0% · structured fields 100.0% (2 comparisons) · errored items: 0

Gate: FAIL
- undersized denominator: 3 pooled predicted positives < 40 — label more and re-seal before evaluating
- Wilson 95% lower bound 0.438 < 0.8

| kind | tp | fp | fn | precision | Wilson95↓ | recall | f1 |
|---|---|---|---|---|---|---|---|
| note | 2 | 0 | 0 | 100.0% | 34.2% | 100.0% | 100.0% |
| bug | 2 | 0 | 0 | 100.0% | 34.2% | 100.0% | 100.0% |
| feature | 1 | 0 | 0 | 100.0% | 20.7% | 100.0% | 100.0% |

## Calibration (self-reported confidence vs observed precision)

| confidence | typed predictions | correct | observed precision |
|---|---|---|---|
| high | 3 | 3 | 100.0% |
| low | 0 | 0 | 0.0% |
```

Once the dev configuration is frozen, evaluate the sealed holdout **once**: `npx goldgate eval --config goldgate.config.ts --split holdout --extractor keyword`. That single run is your gate decision.

## Bring your own task

Everything task-specific lives in one `TaskSpec<Item, Gold, Pred>` object (`Item` must have `id: string` and `text: string`; `Gold` and `Pred` are entirely your shapes — the harness only ever reads them through your accessors). Required fields have no default; each optional field, when omitted, cleanly disables the machinery that depends on it:

| Field | Req? | What it does — and what omitting it turns off |
|---|---|---|
| `kinds` | yes | The full label taxonomy (drives the confusion matrix and per-kind metrics). |
| `gatedKinds` | yes | Kinds pooled into the decisive release-gate precision/recall. |
| `idOfGold` | yes | Stable id of a gold label (joins labels to sampled items). |
| `kindOfGold` | yes | The gold kind of a label. |
| `provenanceOfGold` | yes | `'hand' \| 'assisted'` — the holdout blind-labeling guard reads this. |
| `kindOfPred` | yes | The predicted kind at an optional confidence threshold (`undefined` = raw kind). |
| `negativeKind` | no | The "nothing here" class. **Omit** → the negative-class FP-rate metric and its gate criterion are skipped (all-positive task). |
| `confidenceLevels` | no | Ordered low→high confidence bands. **Omit** → no thresholding and no calibration table. |
| `confidenceOfPred` | no | The confidence of a prediction. **Omit** → no calibration table. |
| `compareFields` | no | Structured/free-text field comparisons on true positives. **Omit** → no field scoring and the structured-exact-match gate criterion is skipped. |
| `boostPatterns` | no | Regexes for stratified oversampling of rare kinds. **Omit** → the boosted stratum is empty (random sampling only). |
| `context` | no | Assembles a context window for the extractor/labeler. **Omit** → items are judged in isolation. |
| `gate` | no | Per-task overrides for any `DEFAULT_GATE` threshold. **Omit** → the defaults below apply. |
| `configHashes` | no | Static provenance (e.g. `promptHash`, `schemaHash`) recorded verbatim into every run config. |
| `labeling` | no | `goldFromPrediction` + `promptGold` (+ optional `renderItem`). **Omit** → the `label` subcommand is unavailable (bring your own labels). |

The gate thresholds default to `DEFAULT_GATE` and are overridable per criterion via `task.gate`:

| Criterion | Default | Skipped when |
|---|---|---|
| `minPooledPrecision` | `0.90` | — |
| `minWilsonLower` (pooled precision) | `0.80` | — |
| `minPooledRecall` | `0.60` | — |
| `minPredictedPositives` | `40` | — (below this, the gate refuses to run) |
| `maxNegativeFpRate` | `0.05` | `negativeKind` absent |
| `minStructuredExactMatch` | `0.85` | `compareFields` absent |

## Anthropic adapter

The optional `goldgate/anthropic` entrypoint turns a Zod schema + prompt into an extractor. `@anthropic-ai/sdk` and `zod` are optional peer dependencies — install them only if you use this adapter; the core never imports them.

```ts
import { z } from 'zod';
import { createClaudeExtractFn, createClaudeBatch, schemaHash, ANTHROPIC_PRICES } from 'goldgate/anthropic';

const schema = z.object({
  kind: z.enum(['note', 'bug', 'feature']),
  certainty: z.enum(['low', 'high']),
  component: z.string().optional(),
});

// In your goldgate.config.ts `extractors` map:
const claude = ({ model }: { model: string }) =>
  createClaudeExtractFn({
    schema,
    systemPrompt: 'Classify the ticket. Prefer "note" when unsure.',
    renderInput: ({ target, context }) =>
      [...context.map((c) => c.text), `>>> ${target.text}`].join('\n'),
    model,                       // e.g. 'claude-opus-4-8'
    // effort?: 'low' | 'medium' | 'high'; maxTokens defaults to 2000; apiKey defaults to env
  });

// Batch mode: one API call sees all targets up front (Anthropic Batches API,
// ~50% cheaper) — ideal for full-corpus and multi-model sweeps.
const claudeBatch = ({ model }: { model: string }) =>
  createClaudeBatch({ schema, systemPrompt: '…', renderInput: (i) => i.target.text, model, contextWindow: 10 });
```

Run batch mode with `npx goldgate eval … --extractor claudeBatch --mode batch`. In sync extraction, a non-`end_turn` stop or null parse throws and the runner records it as an *errored item* (visible in the report); in batch mode, non-succeeded results and schema-invalid outputs are marked as errored entries. Both paths end as errored items in the report, never silently dropped. `schemaHash(schema)` gives a stable digest of the compiled output format for your `task.configHashes`, and `ANTHROPIC_PRICES` is a starter price table you can pass through the config's `costPer1MTokens` so the report prints estimated dollar cost.

## Case study

goldgate was built for and extracted from a production communications-extraction pipeline — an LLM layer that types real, messy workplace messages into decisions, commitments, risks, and status updates. That project needed to convert "the model is good enough" from an assertion into a defensible number, which is where the sealed-holdout / blind-labeling / Wilson-bound-gate protocol comes from. The generic harness was carved out of it and migrated with numeric-equivalence verification: During the migration, the original pipeline's pinned reference evals — a deterministic fixture corpus with recorded predictions — were re-run through goldgate's scoring path at every refactor step; every metric matched the pre-extraction numbers exactly.

## License

MIT © 2026 Thomas Palacios. See [LICENSE](./LICENSE).
