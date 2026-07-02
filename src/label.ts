// Generic labeling machinery (spec §3.3, restructured around TaskSpec
// seams for Phase 3's goldgate harness). Dev split: optional model
// assistance (--assist). Holdout split: blind by construction —
// assistance refused. Appends to the label file after every item
// (crash-safe). Interactive control flow lives here; `LabelIO` (a single
// ask/say seam) is what makes runLabelSession scriptable/testable —
// readline itself belongs only to the CLI shim that bridges into it.
import { appendFileSync } from 'node:fs';
import type { TaskSpec, ExtractFn, LabelIO } from './task.js';
import type { SampleItem } from './sample.js';

// --- pure core (unit-tested) ---

export function provenanceFor(
  proposalShown: boolean, acceptedUnchanged: boolean,
): 'hand' | 'assisted' {
  return proposalShown && acceptedUnchanged ? 'assisted' : 'hand';
}

export function pendingItems<I extends { id: string; text: string }, G, P>(
  sample: SampleItem[], labels: G[], split: 'dev' | 'holdout', task: TaskSpec<I, G, P>,
): SampleItem[] {
  const labeled = new Set(labels.map((l) => task.idOfGold(l)));
  return sample.filter((s) => s.split === split && !labeled.has(s.itemId));
}

export function assertAssistAllowed(split: 'dev' | 'holdout', assist: boolean): void {
  if (split === 'holdout' && assist) {
    throw new Error('holdout labeling is blind (spec §3.3): --assist is not allowed with --split holdout');
  }
}

// 1-based numbered menu onto task.kinds — replaces the old fixed m/d/c/r/s map.
export function kindForKey(kinds: readonly string[], key: string): string | undefined {
  if (!/^[0-9]+$/.test(key)) return undefined;
  const idx = Number(key) - 1;
  return kinds[idx];
}

export function menuLine(kinds: readonly string[], hasProposal: boolean): string {
  const kindPart = kinds.map((k, i) => `${i + 1}=${k}`).join(', ');
  const proposalPart = hasProposal ? 'a=accept proposal, ' : '';
  return `label [${proposalPart}${kindPart}, k=skip, q=quit]`;
}

// --- session loop (unit-tested via scripted LabelIO) ---

export interface LabelSessionOptions<I extends { id: string; text: string }, G, P> {
  task: TaskSpec<I, G, P>;
  corpus: I[];
  sample: SampleItem[];
  existingLabels: G[];
  split: 'dev' | 'holdout';
  out: string;              // JSONL appended after every item (crash-safe)
  assist?: ExtractFn<I, P>;
  io: LabelIO;
  contextWindow?: number;   // default 5 (matches the old label display)
}

export async function runLabelSession<I extends { id: string; text: string }, G, P>(
  opts: LabelSessionOptions<I, G, P>,
): Promise<void> {
  const { task, corpus, sample, existingLabels, split, out, assist, io } = opts;
  const contextWindow = opts.contextWindow ?? 5;

  if (task.labeling === undefined) {
    throw new Error('labeling hooks missing from TaskSpec — required for goldgate label');
  }
  const labeling = task.labeling;

  assertAssistAllowed(split, assist !== undefined);

  const byId = new Map(corpus.map((m) => [m.id, m]));
  const pending = pendingItems(sample, existingLabels, split, task);
  io.say(`\n${pending.length} items pending in ${split} split (${existingLabels.length} already labeled)\n`);

  if (pending.length === 0) {
    io.say('Nothing to label. Done.');
    return;
  }

  const total = pending.length;
  for (let idx = 0; idx < pending.length; idx++) {
    const item = pending[idx]!;
    const target = byId.get(item.itemId);
    if (target === undefined) {
      io.say(`  [WARN] messageId ${item.itemId} not found in corpus, skipping`);
      continue;
    }

    io.say(`\n--- ${idx + 1}/${total} [${item.stratum}] ${item.itemId} ---`);

    const context = task.context?.(corpus, target, contextWindow) ?? [];
    io.say(labeling.renderItem?.(target, context) ?? '>>> ' + target.text);

    // Attempt extraction if assist
    let proposal: P | null = null;
    if (assist !== undefined) {
      try {
        const result = await assist({ target, context });
        proposal = result.prediction;
        io.say(`proposal: ${JSON.stringify(proposal)}`);
      } catch {
        io.say('proposal: (extraction failed)');
      }
    }

    const key = await io.ask(menuLine(task.kinds, proposal !== null), 'k');

    if (key === 'q') break;
    if (key === 'k') continue;

    if (key === 'a' && proposal !== null) {
      const label = labeling.goldFromPrediction(target.id, proposal, 'assisted');
      appendFileSync(out, JSON.stringify(label) + '\n', 'utf8');
      io.say(`  saved (${task.kindOfGold(label)}, assisted)`);
      continue;
    }

    const kind = kindForKey(task.kinds, key);
    if (kind === undefined) {
      io.say('unrecognized key, skipping');
      continue;
    }

    const label = await labeling.promptGold({
      target, context, kind, ...(proposal !== null ? { proposal } : {}), io,
    });
    appendFileSync(out, JSON.stringify(label) + '\n', 'utf8');
    io.say(`  saved (${task.kindOfGold(label)}, ${task.provenanceOfGold(label)})`);
  }

  io.say('\nLabeling session complete.');
}
