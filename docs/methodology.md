# goldgate methodology

This document is the long form of the protocol goldgate implements: how a corpus is sampled and sealed, how ground truth is labeled, which numbers are reported and how, and how a single release gate is decided. It is written task-agnostically — wherever it says "kind," substitute your own label taxonomy; wherever it says "gated kinds," substitute the classes whose precision actually gates your release. The protocol was extracted from a production communications-extraction pipeline and generalized; none of that project's private data, corpora, or prompts appear here.

The through-line: **an eval is only worth what its discipline is worth.** A precision number computed on data that also tuned the prompt, over a denominator too small to bound, with the errored items quietly discarded, is not evidence. goldgate is the set of mechanisms that make the discipline enforceable rather than aspirational.

---

## 1. Sampling

### 1.1 Stratified sampling

A purely random sample under-represents rare kinds — the ones you most need to measure. goldgate draws a **random base** plus a **keyword-boosted oversample**: items whose text matches your `boostPatterns` are pooled and sampled preferentially, so the rare kinds appear in labelable quantity. Every sampled item records its **stratum** — `random` or `boosted` — because some metrics may only be computed on one stratum (see §3.3). Boosted-pool shortfall is redistributed into the random stratum, so the sample never comes back silently short of the requested total.

Sampling is **deterministic**: a small seeded PRNG (not `Math.random`) drives selection, holdout assignment, and shuffling, so a given `(corpus, total, boostedShare, holdoutShare, seed)` always yields the identical sample. Reproducibility is a precondition for the "run once on the holdout" discipline below.

### 1.2 The dev/holdout split, locked at sampling time

The split into **dev** and **holdout** happens *inside the sampler*, before any labeling or extraction touches the data. A fraction of each stratum (`holdoutShare`, default 30%) is sealed as holdout. This ordering is the whole point: the holdout cannot be contaminated by choices made while watching model output, because it is set aside before any such output exists.

The holdout is then **sealed** — not read, not extracted against, not inspected — until dev work (prompt, model choice, confidence thresholds, field-normalization rules) is frozen. The gate is evaluated exactly **once** on the holdout. Any further tuning after that run restarts the protocol and must be declared as a new round in its report.

### 1.3 No silent truncation, starting here

If the corpus is smaller than the requested total, the sampler **throws** — an undersized sample feeding the eval is exactly the silent-truncation hazard the harness exists to prevent. An eval that quietly evaluates 180 items when you asked for 400 is worse than one that fails loudly, because the former ships a number you'll trust.

---

## 2. Labeling

### 2.1 Guidelines before labels

Write and freeze your labeling guidelines *before* labeling begins — each kind defined with positive and negative examples and explicit edge-case rulings. Labels are made against the guidelines, not against intuitions formed while watching an extractor's output. If you record a guidelines hash in `task.configHashes`, it travels into every run config, so "which rulebook was this graded against" is never ambiguous.

### 2.2 Dev set: model-assisted; holdout: blind

- **Dev set** — labeling may be model-assisted. With `--assist <extractor>`, the extractor pre-labels each item and a human reviews it in a small CLI (accept the proposal / choose a different kind / edit fields / skip). Assistance accelerates review; the reviewer still judges every item.
- **Holdout** — labeling is **blind by construction.** The label CLI *refuses* `--assist` on `--split holdout` and throws: no proposal is ever shown. Holdout ground truth is formed against the guidelines alone.

Every gold label records `provenance: 'hand' | 'assisted'`. On the dev set, `assisted` marks a label the reviewer accepted unchanged from a proposal (an edited or freshly-typed label is `hand`); on the holdout, every label is `hand`. This keeps assistance bias auditable and lets the gate refuse to depend on an assisted label (§4.1). Labels are appended to the label file after every item, so an interrupted session loses nothing.

### 2.3 The single-annotator caveat

If one person labels the whole corpus, blind holdout labeling and pre-committed guidelines *bound* annotator bias but do not eliminate it. Name that limitation in every report rather than hiding it. The moment a second labeler is available, the harness's first use is inter-annotator agreement on the holdout.

---

## 3. Metrics

Every metric below is computed only over **scored** items — items the extractor returned a prediction for. Items that errored (a thrown extraction, a non-terminal stop reason, a schema-invalid batch result) are held separately and surfaced as a visible **errored count**; they are never silently folded into a denominator or dropped.

### 3.1 Per-kind and pooled, always with intervals

For each kind the report gives true positives, false positives, and false negatives, precision, recall, F1 — and the **Wilson 95% lower bound** on precision. The decisive number is the **pooled** precision/recall, micro-averaged across your `gatedKinds`, because at realistic corpus sizes per-kind denominators are too small for stable point estimates; per-kind figures are advisory detail, pooled is the gate input.

**Every headline proportion carries a Wilson 95% interval and its raw denominator.** A precision of `0.90` computed over 22 predictions is reported as exactly that — `90.0% (Wilson95 lower ~71%, n=22)` — never as a bare `0.90`. The Wilson score interval (rather than a normal approximation) is used because it behaves correctly at small `n` and near the 0/1 boundaries, which is precisely the regime a release decision lives in.

### 3.2 Confidence thresholds and calibration

If your task declares ordered `confidenceLevels`, the whole metric block is recomputed at each threshold (predictions below the threshold collapse to the negative kind), so the precision/recall tradeoff is a visible curve rather than a single operating point. The consumer picks the operating threshold on the dev set; the holdout is graded at that frozen threshold.

The **calibration table** reports, for each self-reported confidence level, how many typed predictions were made at that level and what fraction were actually correct — observed precision vs. claimed confidence. This validates the `high`/`low` dial against outcomes instead of trusting it as self-report. (Absent `confidenceLevels`/`confidenceOfPred`, the table is simply omitted.)

### 3.3 Stratum discipline for the negative class

The **negative-class false-positive rate** — how often a truly-negative item gets typed as something — is computed on the **random stratum only.** Keyword-boosted items have deliberately inflated positive prevalence, so including them would flatter this rate. The harness enforces this regardless of caller: boosted items are dropped from this metric by contract. (Absent a `negativeKind`, the metric and its gate criterion are skipped for all-positive tasks.)

### 3.4 Field scoring

On **true positives only** (kind correct at the operating threshold), structured fields are scored by normalized exact match and free-text fields by token-overlap similarity. Every field mismatch is dumped into the run directory for human inspection — the similarity score ranks, the human eye decides. Field correctness matters because a correct kind with the wrong owner or date can still be actively harmful downstream, so structured-field exact match is a gate criterion, not a footnote. (Absent `compareFields`, field scoring and its gate criterion are skipped.)

### 3.5 Provenance in the run config

Each run writes `report.md` (human) and `results.json` (machine) into a per-run directory, with an exhaustive recorded config: run id, split, extractor, model, context size, effort, mode, item counts (including how many sampled items were **skipped** for want of a label or corpus row), plus any static hashes you supply and the corpus/label content hashes the CLI computes from the exact bytes it read. Two runs are comparable only when these match; any difference is visible.

---

## 4. The release gate

### 4.1 Protocol

All tuning — prompt iteration, model choice, effort, confidence threshold, field-normalization — happens on the **dev set.** When dev work is frozen (the choices written down first), the harness runs **once** against the sealed holdout with that frozen configuration. That single run is the gate decision. The runner enforces the seal at eval time: a holdout run **refuses** if any in-scope label is `assisted`, and it warns that results are comparable only against the frozen dev configuration. Any subsequent tuning is a declared new round.

### 4.2 Criteria

The gate pools over `gatedKinds` and checks each criterion against `DEFAULT_GATE` (overridable per criterion via `task.gate`):

| Criterion | Default | Meaning |
|---|---|---|
| Pooled precision | ≥ `0.90` | Micro-averaged point estimate over gated kinds. |
| Pooled precision, Wilson 95% lower | ≥ `0.80` | The real bar — a small denominator cannot sneak a lucky point estimate past it. |
| Pooled recall | ≥ `0.60` | Recall over the same kinds. |
| Pooled predicted positives | ≥ `40` | Minimum denominator; below this the gate **refuses to run**. |
| Negative-class FP rate (random stratum) | ≤ `0.05` | Skipped if the task has no `negativeKind`. |
| Structured-field exact match | ≥ `0.85` | Skipped if the task declares no `compareFields`. |

### 4.3 The undersized-denominator refusal

If the frozen configuration yields fewer than `minPredictedPositives` pooled predicted positives on the holdout, the corpus is undersized for the claim. The gate does not compute a hopeful precision over 12 predictions and pass it — it **refuses**, with a message telling you to label more (extending both sets under the same split discipline), re-seal, and only then evaluate. A gate that runs on a denominator too small to bound is not a gate. The Wilson-lower-bound criterion reinforces this: at `n=40` it effectively demands roughly 37/40 correct; larger denominators relax the required point estimate back toward the nominal threshold.

### 4.4 Reading the outcome honestly

A gate pass means the capability holds *on this corpus under this configuration* — necessary, not sufficient. It is not a claim that every downstream question is settled; external validity on a different data distribution is a separate gate on a separate corpus, run with the same code and the same frozen thresholds. Stratum effects (precision broken out by random vs. boosted stratum) are reported alongside so a boosted-inflated number is never mistaken for the real one. The failure mode this whole protocol eliminates is not a low score — it is *not knowing* what the score is worth.
