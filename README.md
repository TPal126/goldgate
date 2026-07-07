# goldgate

[![CI](https://github.com/TPal126/goldgate/actions/workflows/test.yml/badge.svg)](https://github.com/TPal126/goldgate/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/goldgate)](https://www.npmjs.com/package/goldgate)

**A statistically-gated eval harness for LLM classification and extraction tasks.** You wrote a prompt that sorts text into categories (or pulls fields out of text). goldgate tells you whether it's good enough to ship — and gives you a number you can defend when someone asks *"how do you know?"*

It stratifies and seals a holdout, runs a blind-labeling reviewer, and reports per-kind and pooled precision/recall with Wilson 95% lower bounds, a calibration table, and a pass/fail release gate that refuses to run on too little data.

**New to eval? Read the [Walkthrough](#walkthrough-your-first-run) top to bottom — it assumes no stats background.** Already know your way around? Jump to [Bring your own task](#bring-your-own-task), the [gate reference](#the-release-gate), the [workflow & dashboards](#workflow-review-and-dashboards), or the [Anthropic adapter](#anthropic-adapter).

---

## Why you can't just eyeball it

The normal way people check a prompt: run it on 15–20 examples, see it get most of them right, and say "looks good, ship it." That number lies, for two reasons:

1. **Too few examples.** Getting 18 out of 20 right *feels* like 90%. But with only 20 tries, the real rate could easily be 75% or 98% — you can't tell the difference from 20 examples. goldgate makes you use enough examples that the number means something, and it *tells you* how sure you can be.

2. **Grading your own homework.** If you tweak your prompt while looking at the same examples you use to score it, of course the score goes up — you tuned it to those examples. goldgate splits your data in two up front: a **practice set** you're allowed to look at while tuning, and a **sealed test set** it hides until you're done. The final score comes only from the test set, which your prompt has never seen.

That's the idea. The [design invariants](#the-guarantees) section spells out exactly how each of those is enforced; the walkthrough below just shows you how to run it.

---

# Walkthrough: your first run

## First, the terminal

goldgate is run by typing commands, not by clicking. So you'll need a **terminal** — a window where you type a command, press Enter, and read what comes back.

- **On a Mac:** open the **Terminal** app (Spotlight → type "Terminal").
- **On Windows:** open **PowerShell** (Start menu → type "PowerShell").

Throughout this guide, every grey box like this is one command:

```bash
node --version
```

Type the line into your terminal and press Enter. **Don't type the word `bash`** — that's just a label on the box, not part of the command.

## What you need before you start

- **Node.js 20 or newer.** In your terminal, run `node --version`. You should see `v20.` or higher. If you see a lower number, or `command not found`, install Node first from [nodejs.org](https://nodejs.org) (pick the "LTS" version), then check again.
- **A folder for this project.** Make one and work inside it — all the files below live together in it.
- **A corpus file** — your examples to grade. It's a plain text file with **one example per line**, each written in curly braces like below. (This one-object-per-line format is called *JSONL*, which is why the file ends in `.jsonl`.) Each line needs an `id` (any unique name for that example) and a `text` (the words to classify):
  ```
  {"id": "t-001", "text": "app crashes when I hit save"}
  {"id": "t-002", "text": "please add a dark mode"}
  ```
  **Save this file as `corpus/tickets.jsonl`** — i.e. make a folder named `corpus` inside your project folder and put the file in it. (That exact path is what `paths.corpus` in the config points to; if you name it differently, change that line to match.) You want at least a couple hundred lines. You'll only hand-label a slice of them, not all.
- **About 20–30 minutes.**

> **Just want to try the tool without your own data?** Paste this 10-line corpus into `corpus/tickets.jsonl` and use a smaller `--total` (e.g. `--total 8`) in Step 1. The gate will fail on too-few-examples, which is the right lesson for a first tour:
> ```
> {"id":"t-001","text":"app crash on save when disk is full"}
> {"id":"t-002","text":"add dark mode to the settings screen"}
> {"id":"t-003","text":"login fails with SSO after password rotation"}
> {"id":"t-004","text":"error 500 from the export endpoint on large files"}
> {"id":"t-005","text":"thanks for the quick turnaround last week"}
> {"id":"t-006","text":"search results pagination is broken past page 3"}
> {"id":"t-007","text":"could we get CSV import for bulk tickets"}
> {"id":"t-008","text":"meeting notes from the retro attached"}
> {"id":"t-009","text":"crash loop on startup after the 2.3 update"}
> {"id":"t-010","text":"what is the SLA for enterprise plans"}
> ```

## The 30-second mental model

goldgate runs in five moves. Keep this picture in your head:

```
1. SAMPLE   → pick which examples to grade, and secretly set some aside as the test set
2. LABEL    → you decide the correct answer for each picked example (this is "ground truth")
3. EVAL     → run your prompt, compare its answers to yours, get a scorecard
   ↑ repeat 2–3 on the PRACTICE set while you improve your prompt
4. FREEZE   → declare "my prompt is final" — locks it in
5. TEST     → run once on the sealed test set. That score is your answer.
```

You do steps 1–3 as much as you want. You do step 5 **once**.

(One detail the picture simplifies: you label the *practice* set in step 2, and label the *sealed* set separately, right before the final test in step 5 — so you never see its score while you're still tuning.)

## Step 0 — install and configure

In your project folder, run:

```bash
npm i -D goldgate
```

`npm` is the tool that downloads goldgate into your folder (leave the `-D` exactly as written — it just means "a development tool"). From here on, every goldgate command starts with `npx goldgate …` — that's simply how you run the tool you just installed.

Now create a file called `goldgate.config.ts` in the same folder. This is where you describe *your* task. Here's a complete working example for sorting support tickets into `note` / `bug` / `feature`. Copy it, then read the comments:

```ts
import { defineConfig } from 'goldgate';
import type { TaskSpec } from 'goldgate';

// The shape of one example in your corpus file.
interface Ticket { id: string; text: string }
// The shape of a correct answer (what you'll fill in during labeling).
interface Gold { ticketId: string; provenance: 'hand' | 'assisted'; kind: 'note' | 'bug' | 'feature' }
// The shape of your prompt's output.
interface Pred { kind: 'note' | 'bug' | 'feature'; certainty: 'low' | 'high' }

const task: TaskSpec<Ticket, Gold, Pred> = {
  kinds: ['note', 'bug', 'feature'],   // all your categories
  gatedKinds: ['bug', 'feature'],      // the ones you actually care about being right
  negativeKind: 'note',                // the "nothing to do here" category

  // These just tell goldgate how to read your data. Leave them as-is
  // and rename the fields to match your own shapes.
  idOfGold: (g) => g.ticketId,
  kindOfGold: (g) => g.kind,
  provenanceOfGold: (g) => g.provenance,
  kindOfPred: (p) => p.kind,

  // How labeling works (fill in the correct answer for an item):
  labeling: {
    goldFromPrediction: (ticketId, p, provenance) => ({ ticketId, provenance, kind: p.kind }),
    promptGold: async ({ target, kind }) => ({ ticketId: target.id, provenance: 'hand', kind: kind as Gold['kind'] }),
  },
};

export default defineConfig({
  task,
  // Your prompt goes here. This example uses a dumb keyword matcher so you
  // can try the whole flow with NO API key. Replace it with a real model call later.
  defaultModel: 'keyword',
  extractors: {
    keyword: () => async ({ target }) => ({
      prediction: {
        kind: /crash|error|broken|fails?/i.test(target.text) ? 'bug'
          : /add|support|please|feature/i.test(target.text) ? 'feature'
          : 'note',
        certainty: 'high',
      },
    }),
  },
  // Where files live. These defaults are fine.
  paths: {
    corpus: 'corpus/tickets.jsonl',
    sample: 'work/sample.jsonl',
    labels: 'work/labels.jsonl',
    outDir: 'work/runs',
  },
});
```

> **When you're ready for a real model**, the `keyword` extractor is the only thing you replace — see the [Anthropic adapter](#anthropic-adapter) below. Everything else stays the same. And once your task needs confidence levels, field comparison, or oversampling of rare kinds, see [Bring your own task](#bring-your-own-task) for the full set of `TaskSpec` options.

## Step 1 — sample

```bash
npx goldgate sample --config goldgate.config.ts --total 80 --holdout-share 0.25
```

**What this does:** picks 80 examples from your corpus to grade, and secretly seals 25% of them (20 examples) as the test set. You'll never see which ones until the end.

**What you'll see:**
```
sampled 80 (dev 60 / holdout 20)
```
- `dev` = 60 practice examples (you tune against these)
- `holdout` = 20 test examples (sealed)

> **How many should you pick?** The gate needs at least 40 graded predictions of the categories you care about before it trusts a score. Start with `--total 80` for a real task and grow it if the gate says you're short.

## Step 2 — label the practice set

This is the part only a human can do: for each picked example, **you** decide the correct category. This becomes the answer key.

The friendliest way is in your browser:

```bash
npx goldgate serve --config goldgate.config.ts
```

This starts a small web page on your own computer. **The terminal will now look stuck** — no new prompt appears. That's normal: the web server is running and keeping that terminal busy. Leave it open.

Now open **http://127.0.0.1:4770/** in your web browser. Across the top you'll see three tabs — **Label**, **Runs**, and **Overview**. Click **Label**, pick the `dev` split, and start. You'll see one ticket at a time with a button for each category (keyboard shortcuts `1`, `2`, `3` work too). Click the right one.

> **For this first walkthrough, label about 8 tickets and stop** (close the browser tab). That's deliberately too few — just enough to see what a "not enough data yet" result looks like in the next step. For a real project you'd label them all.

Your answers are saved after every single item, so you can stop and come back any time.

When you're done, go back to the terminal running `serve` and press **Ctrl + C** to stop it — that frees the terminal for the next command. (Or open a second terminal window and leave `serve` running; either works.)

> **Prefer the terminal over the browser?** `npx goldgate label --config goldgate.config.ts --split dev` does the same labeling as a text prompt.

## Step 3 — run your prompt and score it

```bash
npx goldgate eval --config goldgate.config.ts --split dev --extractor keyword
```

**What this does:** runs your prompt on the practice examples, compares each answer to the one you gave, and writes a scorecard.

**What you'll see.** Because you only labeled about 8 tickets, you'll get something like this (real output — the annotations after it explain every line):

```
Pooled (bug+feature): precision 100.0% (Wilson95 lower 64.6%, n=7) · recall 100.0% · negative-kind FP rate (random stratum) 0.0% · errored items: 0

Gate: FAIL
- undersized denominator: 7 pooled predicted positives < 40 — label more and re-seal before evaluating
- Wilson 95% lower bound 0.646 < 0.8

| kind    | tp | fp | fn | precision | Wilson95↓ | recall | f1     |
|---------|----|----|----|-----------|-----------|--------|--------|
| note    | 1  | 0  | 0  | 100.0%    | 20.7%     | 100.0% | 100.0% |
| bug     | 2  | 0  | 0  | 100.0%    | 34.2%     | 100.0% | 100.0% |
| feature | 5  | 0  | 0  | 100.0%    | 56.6%     | 100.0% | 100.0% |
```

`Gate: FAIL` is the *expected* result here — you labeled only ~8 on purpose. (Here `denominator` just means "how many things your prompt flagged as bug or feature." You have 7; the gate needs at least 40 before it trusts any score.) Once you've labeled **40+** of your gated kinds, the same report flips to `Gate: PASS` with a much higher floor:

```
Pooled (bug+feature): precision 100.0% (Wilson95 lower 92.1%, n=45) · recall 100.0% · negative-kind FP rate (random stratum) 0.0% · errored items: 0

Gate: PASS
```

The full report is also saved as a file (the command prints its path). It also appears on the **Runs** tab in the browser — as long as `npx goldgate serve` is still running.

## How to read the scorecard

Take it one piece at a time.

### The headline line

> `Pooled (bug+feature): precision 100.0% (Wilson95 lower 64.6%, n=7) · recall 100.0% · negative-kind FP rate (random stratum) 0.0%`

This is the summary for the categories you said you care about (`bug` and `feature`), all lumped together. Reading left to right:

| You see | Plain meaning |
|---|---|
| **precision 100.0%** | When your prompt said "bug" or "feature", it was right 100% of the time. (No false alarms.) |
| **Wilson95 lower 64.6%** | The safe floor. Your prompt *looked* 100% accurate, but on only 7 examples the true rate could really be as low as **64.6%**. This gap means: *not enough data to trust the 100%.* Label more and the floor climbs toward the real number. (The "95" means the tool is 95% sure the real rate is at or above this floor — it's a confidence level, not a score.) |
| **n=7** | That precision is based on just **7** predictions. Tiny — which is exactly why the floor is so far below 100%. |
| **recall 100.0%** | Of the real bugs and features in the set, your prompt caught 100% of them. (Missed nothing.) |
| **negative-kind FP rate (random stratum) 0.0%** | How often it flagged a "nothing to do" item (`note`) as a bug or feature — a false alarm. "Random stratum" just means it's measured on a plain random slice of your items, so the rate isn't skewed. Lower is better; 0% means none. |
| **errored items: 0** | Your prompt didn't crash on any example. Good. (If this is above 0, something threw an error — investigate.) |

**The two words worth memorizing:**
- **Precision** = "when it raises its hand, is it right?" Low precision = crying wolf.
- **Recall** = "does it catch the real ones?" Low recall = missing wolves.

Which matters more depends on your task, but goldgate's gate demands high precision (90%) and only moderate recall (60%) — so **precision is the number to fight for first.**

### The per-category table

Same idea, broken out per category. The columns:
- **tp** (true positives) = it said X, and X was correct
- **fp** (false positives) = it said X, but X was wrong (a false alarm)
- **fn** (false negatives) = the answer was X, but it said something else (a miss)
- **precision / recall / f1** = the same rates for that one category (**f1** is just precision and recall blended into one number)
- **Wilson95↓** = the safe floor for that category's precision

Notice all three rows show 100% precision but very different floors (20.7% vs 34.2% vs 56.6%). The reason is the hidden count `tp + fp` — how many things it flagged for that row. `note` rests on just 1 flag, `feature` on 5. **Fewer examples → lower floor**, which is why `note`'s floor is the lowest even though its score is also 100%.

The per-category numbers are *detail*. The headline `Pooled` line is what the ship/no-ship decision is actually based on.

### The gate

> ```
> Gate: FAIL
> - undersized denominator: 7 pooled predicted positives < 40 ...
> - Wilson 95% lower bound 0.646 < 0.8
> ```

**This is the answer to "can I ship it?"** `PASS` or `FAIL`, plus the exact reasons for a fail.

A `FAIL` is **not a bug or an error** — it's the tool refusing to bless a result that isn't solid yet. Here it failed for the most common beginner reason: **only 7 examples.** Not enough to trust any score, so the gate won't even pretend. Label more examples and the number becomes real. (See the full list of gate criteria and how to change them in [The release gate](#the-release-gate).)

### Calibration (optional — skip this for now)

Your prompt outputs a `certainty` value, but the starter task doesn't ask goldgate to grade it, so your report just says *"no calibration — task declares no confidence levels"*. Ignore it for your first run.

Once you *do* wire up confidence grading (see [`confidenceLevels`](#bring-your-own-task)), this table appears and checks whether your prompt's confidence is honest. It would look like:

| confidence | typed predictions | correct | observed precision |
|---|---|---|---|
| high | 3 | 3 | 100.0% |

Read it as: "when my prompt said **high** confidence, it was actually right 100% of the time." If "high" confidence is only right 60% of the time, your prompt is overconfident and you shouldn't trust its `high` label.

## "My gate failed — what do I do?"

Look at the reason listed under `Gate: FAIL`:

- **"undersized denominator: N < 40"** → You don't have enough examples. Label more (repeat steps 1–2 with a bigger `--total`), then eval again.
- **"Wilson 95% lower bound ... < 0.8"** and n is small → same story: more examples will lift the floor. If n is already large (40+) and the floor is still low, your prompt genuinely isn't precise enough — improve the prompt.
- **"pooled precision ... < 0.9"** → Your prompt is wrong too often. Look at the `fp` (false positive) counts in the table to see which category it over-flags, and fix the prompt for those.
- **"pooled recall ... < 0.6"** → Your prompt misses too many. Look at the `fn` (false negative) counts — those are the ones it's not catching.

Then run `eval` again. Repeat until the practice-set gate passes and you're happy.

## Steps 4 & 5 — freeze, then take the real test

Do this only once you've labeled enough of the practice set, your gate passes, and you've **stopped changing your prompt.**

**Step 4 — freeze.** Lock in your final setup:

```bash
npx goldgate freeze --config goldgate.config.ts --extractor keyword
```

**Why freeze?** The test-set score is only trustworthy if you didn't peek at it and tune against it. `freeze` writes down exactly what your setup is right now. After that, goldgate **refuses** to score the test set with any *different* setup unless you freeze again (which openly starts a new round). It's a guardrail against accidentally cheating.

**Step 5a — now label the sealed test set.** You haven't given answers for these 20 held-back items yet. Do it now, *after* freezing:

```bash
npx goldgate label --config goldgate.config.ts --split holdout
```

(Or use the **Label** tab in `serve` and pick the `holdout` split.) Labeling the test set isn't peeking — you're only writing down the correct answers, and you won't see the *score* until you run the eval below. On the test set, goldgate won't offer you any model suggestions; you decide every answer yourself, so the answer key stays honest.

**Step 5b — score the test set, once.** This is your real answer:

```bash
npx goldgate eval --config goldgate.config.ts --split holdout --extractor keyword
```

Read this scorecard exactly like the practice one. **That gate result is your defensible answer** to "is it good enough to ship?"

Finally, record your decision so it's on the books:

```bash
npx goldgate decide --config goldgate.config.ts --ship      # or --no-ship
```

You can see the whole history — every freeze, test, and decision — with `npx goldgate status`, or on the **Overview** tab in the browser while `serve` is running. The next section covers that workflow in full.

---

# Reference

## Workflow, review, and dashboards

The protocol above (sample → label dev → iterate → freeze → blind-label holdout → one gate run → decision) is not just documentation — it is a mechanical workflow with an append-only audit log at `work/workflow.jsonl` (path overridable via `paths.workflow`):

```bash
npx goldgate status --config goldgate.config.ts    # stage, per-split label progress, rounds, latest runs
npx goldgate freeze --config goldgate.config.ts --extractor claude --model claude-opus-4-8 \
  --threshold high --note "prompt v3"              # records the dev choices; starts round N
npx goldgate eval   --config goldgate.config.ts --split holdout --extractor claude --model claude-opus-4-8
npx goldgate decide --config goldgate.config.ts --ship --note "gate held at n=53"
```

Enforcement is refusal-first, in the project's spirit:

- `eval --split holdout` **refuses** when: no configuration is frozen; the run's extractor / model / effort / context window / mode / config hashes differ from the frozen record; **any holdout item is still unlabeled** (a partial holdout would silently gate on a subset); or **the frozen operating threshold is no longer a declared confidence level** (the gate would be recorded at the wrong threshold). `--allow-unfrozen` is the explicit escape hatch for all of these — the run then proceeds but is recorded as `unfrozen` in the event log, visibly.
- Repeat holdout evals inside a round are allowed (a crashed run must be re-runnable) but loudly warned and recorded with `repeat: true` — the first completed run is the gate; further tuning is a declared new round (`goldgate freeze` again).
- `decide` refuses unless the round has a completed gate run, and ties itself to that round's first (gate) run id.

Every freeze, holdout eval (with its gate verdict), and decision is an event in `workflow.jsonl` — never rewritten, so *who evaluated the holdout, how many times, against what configuration* is always answerable.

### `goldgate serve` — reviewer UX and dashboards

```bash
npx goldgate serve --config goldgate.config.ts    # http://127.0.0.1:4770/ (local-only by default)
```

One dependency-free local web app over your existing files (nothing is indexed or duplicated; the JSONL artifacts stay the source of truth):

- **Overview** — the workflow pipeline with the current stage, per-split labeling progress (hand vs assisted), the latest gate verdict with its Wilson bound, and the full audit trail. Freeze and record decisions from here too.
- **Label** — a browser reviewer for the labeling loop: kind buttons with keyboard shortcuts (`1`–`9`, `a` accept proposal, `k` skip), model proposals on the dev split, structured field prompts. It drives the *same* `runLabelSession` as the CLI through a web-backed `LabelIO`, so the invariants hold identically: assist on the holdout is refused by the same guard, provenance is recorded by the same code, and labels append after every item.
- **Runs** — every run with its recorded config, per-threshold metrics, gate reasons, confusion heatmap, calibration table, field mismatches, and errored items.
- **Trends** — pooled precision (with the Wilson 95% lower-bound band) and recall across runs, holdout emphasized over dev context, filterable by threshold and extractor.

The server binds `127.0.0.1` and is single-reviewer by design — it is a local tool, not a hosted service. Cross-origin and non-JSON POSTs are refused so a page you visit can't forge audit events. Pass `--port`/`--host` to override the bind address.

## The guarantees

Most "eval scripts" quietly lie. They report a bare `0.90` precision computed over 20 predictions, silently drop the items the model errored on, and let the same data that tuned the prompt also grade it. goldgate is a set of design invariants against exactly those failure modes:

- **Sealed holdouts, enforced twice.** The dev/holdout split is made at *sampling* time, before any labeling or extraction — the holdout file is sealed until dev work (prompt, model, thresholds) is frozen. It is re-checked at *eval* time: the runner refuses a holdout evaluation if any in-scope label carries `provenance: 'assisted'`, and warns that the configuration must be frozen from the dev run.
- **Blind labeling.** On the dev set, an extractor may pre-label to speed review (`--assist`). On the holdout, assistance is *refused* — the label reviewer throws rather than show you a proposal, so holdout ground truth is formed against guidelines, not against model output.
- **Wilson lower bounds on every headline proportion.** No bare point estimates. A precision is reported as `92.5% (Wilson95 lower 82.1%, n=53)` — the interval and its raw denominator travel together, everywhere.
- **Precision-at-budget release gates.** The gate pools precision/recall over your "gated" kinds and checks a point estimate, its Wilson lower bound, recall, a negative-class false-positive rate, and structured-field exact match — each threshold overridable per task. If the holdout yields fewer than the minimum pooled predicted positives (default 40), the gate **refuses to run** and tells you to label more and re-seal, rather than blessing a number computed over too little data.
- **Calibration tables.** Every run with declared confidence levels emits observed precision at each self-reported confidence level, so `high`/`low` is validated against outcomes instead of trusted as self-report.
- **No silent truncation, as an invariant.** An undersized corpus *throws* at sampling time. Sampled items missing a label or corpus row are skipped and the skip count is recorded in the run config. Items the extractor errored on are scored as errors and counted visibly in the report — never dropped to flatter a number.

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
| `configHashes` | no | Static provenance (e.g. `promptHash`, `schemaHash`) recorded verbatim into every run config, and part of the frozen-configuration seal. |
| `labeling` | no | `goldFromPrediction` + `promptGold` (+ optional `renderItem`). **Omit** → the `label` subcommand is unavailable (bring your own labels). |

### A fuller example

The starter config in the walkthrough is deliberately minimal. Here is the same triage task with the optional features switched on — confidence thresholding + calibration (`confidenceLevels` / `confidenceOfPred`), a structured field comparison (`compareFields`), and oversampling of likely bugs (`boostPatterns`):

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
  defaultModel: 'keyword',
  task: triageTask,
  extractors: {
    keyword: () => async ({ target }) => ({
      prediction: {
        kind: /\b(crash|error|broken|fails?)\b/i.test(target.text) ? 'bug'
          : /\b(add|support|please|feature)\b/i.test(target.text) ? 'feature' : 'note',
        certainty: 'high',
      },
    }),
  },
  paths: { corpus: 'corpus/tickets.jsonl', sample: 'work/sample.jsonl', labels: 'work/labels.jsonl', outDir: 'work/runs' },
});
```

With `compareFields` on, the report additionally scores structured fields on true positives and lists every mismatch for human review; with `confidenceLevels` on, it recomputes the whole metric block at each threshold and emits the calibration table.

## The release gate

The gate thresholds default to `DEFAULT_GATE` and are overridable per criterion via `task.gate`:

| Criterion | Default | In plain words | Skipped when |
|---|---|---|---|
| `minPooledPrecision` | `0.90` | At least 9 of every 10 things it flags are correct | — |
| `minWilsonLower` (pooled precision) | `0.80` | Even accounting for bad luck, precision is ≥ 80% | — |
| `minPooledRecall` | `0.60` | It catches at least 60% of the real ones | — |
| `minPredictedPositives` | `40` | Enough data to trust — below this the gate **refuses to run** | — |
| `maxNegativeFpRate` | `0.05` | It rarely flags a "nothing" item as something | `negativeKind` absent |
| `minStructuredExactMatch` | `0.85` | Extracted fields (owner, date, …) match | `compareFields` absent |

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

## Glossary

- **Corpus** — your full pile of examples (the input file).
- **Sample** — the slice of the corpus goldgate actually grades.
- **Dev / practice set** — the examples you're allowed to look at while improving your prompt.
- **Holdout / test set** — examples sealed away until the end, so the final score can't be gamed.
- **Label / ground truth / gold** — the correct answer *you* provide for an example.
- **Extractor** — your prompt (the thing that produces an answer). Called "extractor" because it extracts a category or fields from text.
- **Precision** — of the things it flagged, how many were right. (Avoids false alarms.)
- **Recall** — of the real ones, how many it caught. (Avoids misses.)
- **Wilson lower bound** — the safe worst-case floor for a percentage, given how few examples it's based on. A big gap between the headline number and this floor means "trust me less — I need more data."
- **n** — the number of examples a score is based on. Small n = don't trust the score.
- **Gate** — the automatic PASS/FAIL that answers "is this good enough to ship?"
- **Freeze** — declaring your setup final, which unlocks the one honest test-set run.

## Common questions

**Do I need an API key to try this?** No. The example config's `keyword` extractor is a plain keyword matcher that runs offline. Swap in a real model when you're ready.

**Why did every number say 100% but the gate still failed?** Because it was based on only a handful of examples. 100% of 7 is meaningless. The gate is protecting you from shipping on a number that can't be trusted. Label more examples.

**Do I have to label everything in my corpus?** No — only the sample (e.g. 80 items), not the whole corpus.

**Can I just look at the test set to see how I'm doing?** That's the one thing the tool stops you from doing casually, because it's the fastest way to fool yourself. Tune on the practice set; the test set is a one-shot final exam.

## Case study

goldgate was built for and extracted from a production communications-extraction pipeline — an LLM layer that types real, messy workplace messages into decisions, commitments, risks, and status updates. That project needed to convert "the model is good enough" from an assertion into a defensible number, which is where the sealed-holdout / blind-labeling / Wilson-bound-gate protocol comes from. The generic harness was carved out of it and migrated with numeric-equivalence verification: during the migration, the original pipeline's pinned reference evals — a deterministic fixture corpus with recorded predictions — were re-run through goldgate's scoring path at every refactor step; every metric matched the pre-extraction numbers exactly.

For the long-form protocol — the reasoning behind each rule, the single-annotator caveat, and how to read a gate outcome honestly — see [docs/methodology.md](./docs/methodology.md).

## License

MIT © 2026 Thomas Palacios. See [LICENSE](./LICENSE).
