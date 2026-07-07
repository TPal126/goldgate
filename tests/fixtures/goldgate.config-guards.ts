// Fixture config for tests/cli-holdout-guards.test.ts (spawned CLI). Its own
// fixed tmpdir, separate from the other CLI fixtures so it can run in parallel.
// Uses the full triageTask (confidenceLevels ['low','high']).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '../../src/config.js';
import { triageTask } from './triage-task.js';

const dir = join(tmpdir(), 'goldgate-fixture-guards');

export default defineConfig({
  task: triageTask,
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
