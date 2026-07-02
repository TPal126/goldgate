import type { TaskSpec, FieldComparison } from '../../src/task.js';

export interface Ticket { id: string; text: string; queue: string }
export interface TriageGold {
  ticketId: string;
  provenance: 'hand' | 'assisted';
  kind: 'note' | 'bug' | 'feature';
  component?: string;
  summary?: string;
}
export interface TriagePred {
  kind: 'note' | 'bug' | 'feature';
  certainty: 'low' | 'high';
  component?: string;
  summary?: string;
}

const RANK: Record<'low' | 'high', number> = { low: 0, high: 1 };

export const triageTask: TaskSpec<Ticket, TriageGold, TriagePred> = {
  kinds: ['note', 'bug', 'feature'],
  negativeKind: 'note',
  gatedKinds: ['bug', 'feature'],
  confidenceLevels: ['low', 'high'],
  idOfGold: (g) => g.ticketId,
  kindOfGold: (g) => g.kind,
  provenanceOfGold: (g) => g.provenance,
  kindOfPred: (p, min) => {
    if (p.kind === 'note') return 'note';
    if (min === undefined) return p.kind;
    return RANK[p.certainty] >= RANK[min as 'low' | 'high'] ? p.kind : 'note';
  },
  confidenceOfPred: (p) => p.certainty,
  compareFields: (g, p): FieldComparison[] => {
    const out: FieldComparison[] = [];
    if (g.kind === 'bug' && p.kind === 'bug') {
      out.push({ field: 'component', type: 'structured', gold: g.component ?? '(absent)', predicted: p.component ?? '(absent)' });
      if (g.summary !== undefined && p.summary !== undefined) {
        out.push({ field: 'summary', type: 'freetext', gold: g.summary, predicted: p.summary });
      }
    }
    return out;
  },
  labeling: {
    goldFromPrediction: (itemId, p, provenance) => ({
      ticketId: itemId, provenance, kind: p.kind,
      ...(p.component !== undefined ? { component: p.component } : {}),
      ...(p.summary !== undefined ? { summary: p.summary } : {}),
    }),
    promptGold: async ({ target, kind, io }) => ({
      ticketId: target.id, provenance: 'hand',
      kind: kind as 'note' | 'bug' | 'feature',
      ...(kind === 'bug' ? { component: await io.ask('component', 'core') } : {}),
    }),
  },
};
