// Fixture config consumed by both tests/config.test.ts (loadConfig, direct
// jiti import) and tests/cli-sample.test.ts (loadConfig via a spawned CLI
// subprocess). paths point at a fixed OS-tmpdir location — stable across
// the two separate Node processes that load this same file.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '../../src/config.js';
import { triageTask } from './triage-task.js';

const dir = join(tmpdir(), 'goldgate-fixture-config');

export default defineConfig({
  task: triageTask,
  extractors: {
    echo: () => async (i) => ({ prediction: { kind: 'note', certainty: 'high' } }),
  },
  paths: {
    corpus: join(dir, 'corpus.jsonl'),
    labels: join(dir, 'labels.jsonl'),
    sample: join(dir, 'sample.jsonl'),
    outDir: join(dir, 'runs'),
  },
});
