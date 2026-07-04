// Fixture config for tests/cli-workflow.test.ts (spawned CLI subprocess).
// Its own fixed tmpdir location, separate from goldgate.config.ts's, so the
// two CLI test files can run in parallel without clobbering each other.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '../../src/config.js';
import { triageTask } from './triage-task.js';

const dir = join(tmpdir(), 'goldgate-fixture-workflow');

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
