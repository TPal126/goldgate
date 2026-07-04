import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provenanceFor, pendingItems, assertAssistAllowed, kindForKey, runLabelSession } from '../src/label.js';
import type { SampleItem } from '../src/sample.js';
import type { LabelPrompt } from '../src/task.js';
import { triageTask, type TriageGold } from './fixtures/triage-task.js';

describe('kindForKey', () => {
  it('maps 1-based digits onto task.kinds and rejects everything else', () => {
    const kinds = ['note', 'bug', 'feature'];
    expect(kindForKey(kinds, '1')).toBe('note');
    expect(kindForKey(kinds, '3')).toBe('feature');
    expect(kindForKey(kinds, '4')).toBeUndefined();
    expect(kindForKey(kinds, '0')).toBeUndefined();
    expect(kindForKey(kinds, 'd')).toBeUndefined();
  });
});

describe('provenanceFor', () => {
  it('is assisted only when a proposal was shown and accepted unchanged', () => {
    expect(provenanceFor(true, true)).toBe('assisted');
    expect(provenanceFor(true, false)).toBe('hand');
    expect(provenanceFor(false, false)).toBe('hand');
  });
});

describe('pendingItems', () => {
  it('returns sample items of the chosen split that lack a label', () => {
    const sample: SampleItem[] = [
      { itemId: 'a', stratum: 'random', split: 'dev' },
      { itemId: 'b', stratum: 'random', split: 'dev' },
      { itemId: 'c', stratum: 'boosted', split: 'holdout' },
    ];
    const labels: TriageGold[] = [{ ticketId: 'a', provenance: 'hand', kind: 'note' }];
    expect(pendingItems(sample, labels, 'dev', triageTask).map((i) => i.itemId)).toEqual(['b']);
    expect(pendingItems(sample, labels, 'holdout', triageTask).map((i) => i.itemId)).toEqual(['c']);
  });
});

describe('assertAssistAllowed', () => {
  it('refuses assistance on the holdout split (blind labeling)', () => {
    expect(() => assertAssistAllowed('holdout', true)).toThrow(/blind/i);
    expect(() => assertAssistAllowed('dev', true)).not.toThrow();
    expect(() => assertAssistAllowed('holdout', false)).not.toThrow();
  });
});

describe('runLabelSession with a structured askKind IO', () => {
  it('passes a structured prompt, suppresses item say lines, and still routes field asks through ask()', async () => {
    const outFile = join(tmpdir(), `goldgate-label-askkind-${process.pid}.jsonl`);
    const prompts: LabelPrompt[] = [];
    const sayLines: string[] = [];
    const askAnswers = ['ui'];
    const io = {
      say: (l: string) => { sayLines.push(l); },
      ask: async (_q: string, fallback: string) => askAnswers.shift() ?? fallback,
      askKind: async (p: LabelPrompt) => { prompts.push(p); return '2'; },   // kinds[1] = 'bug'
    };
    try {
      await runLabelSession({
        task: triageTask,
        corpus: [{ id: 't1', text: 'the app crashes when saving a draft', queue: 'support' }],
        sample: [{ itemId: 't1', stratum: 'random', split: 'dev' }],
        existingLabels: [], split: 'dev', out: outFile, io,
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        itemId: 't1', index: 1, total: 1, stratum: 'random',
        kinds: ['note', 'bug', 'feature'], proposal: null,
      });
      expect(prompts[0]!.rendered).toContain('crashes');
      // the structured prompt carries the item display — no '---' header says
      expect(sayLines.filter((l) => l.includes('---'))).toHaveLength(0);
      const lines = readFileSync(outFile, 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0]!)).toMatchObject({ ticketId: 't1', kind: 'bug', component: 'ui', provenance: 'hand' });
    } finally {
      rmSync(outFile, { force: true });
    }
  });
});

describe('runLabelSession', () => {
  it('drives a full item through scripted IO and appends a gold line', async () => {
    const outFile = join(tmpdir(), `goldgate-label-test-${process.pid}.jsonl`);
    // '2' selects kinds[1] = 'bug'; promptGold then asks for 'component'.
    const answers = ['2', 'ui'];
    const io = {
      ask: async (_q: string, fallback: string) => answers.shift() ?? fallback,
      say: () => {},
    };
    try {
      await runLabelSession({
        task: triageTask,
        corpus: [{ id: 't1', text: 'the app crashes when saving a draft', queue: 'support' }],
        sample: [{ itemId: 't1', stratum: 'random', split: 'dev' }],
        existingLabels: [], split: 'dev', out: outFile, io,
      });
      const lines = readFileSync(outFile, 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0]!)).toMatchObject({ ticketId: 't1', kind: 'bug', provenance: 'hand' });
    } finally {
      rmSync(outFile, { force: true });
    }
  });
});
