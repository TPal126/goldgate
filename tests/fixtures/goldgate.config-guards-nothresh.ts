// Same paths as goldgate.config-guards.ts, but the task drops confidenceLevels
// — simulating the task being edited after a freeze at `--threshold high`, so
// the frozen threshold is no longer declared. The holdout eval must refuse.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '../../src/config.js';
import type { TaskSpec } from '../../src/task.js';
import { triageTask, type Ticket, type TriageGold, type TriagePred } from './triage-task.js';

const dir = join(tmpdir(), 'goldgate-fixture-guards');

const task: TaskSpec<Ticket, TriageGold, TriagePred> = { ...triageTask };
delete task.confidenceLevels;
delete task.confidenceOfPred;

export default defineConfig({
  task,
  defaultModel: 'stub',
  extractors: {
    kw: () => async ({ target }) => ({
      prediction: {
        kind: /crash|error|broken|fails?/i.test(target.text) ? ('bug' as const) : ('note' as const),
        certainty: 'high' as const,
      },
    }),
  },
  paths: {
    corpus: join(dir, 'corpus.jsonl'),
    labels: join(dir, 'labels.jsonl'),
    sample: join(dir, 'sample.jsonl'),
    outDir: join(dir, 'runs'),
  },
});
