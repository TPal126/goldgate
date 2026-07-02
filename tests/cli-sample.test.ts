import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must match tests/fixtures/goldgate.config.ts's `dir` computation exactly —
// that fixture's paths.corpus/paths.sample live here.
const dir = join(tmpdir(), 'goldgate-fixture-config');
const corpusPath = join(dir, 'corpus.jsonl');
const samplePath = join(dir, 'sample.jsonl');

describe('goldgate sample (CLI, spawned end-to-end)', () => {
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('samples a corpus through the real CLI subprocess and writes itemId/stratum/split rows', () => {
    mkdirSync(dir, { recursive: true });
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, text: `ticket number ${i}` }));
    writeFileSync(corpusPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    execFileSync('npx', [
      'tsx', 'src/cli.ts', 'sample',
      '--config', 'tests/fixtures/goldgate.config.ts',
      '--total', '4', '--boosted-share', '0.5', '--holdout-share', '0.5', '--seed', '1',
    ], { shell: process.platform === 'win32' });

    const lines = readFileSync(samplePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(row).toHaveProperty('itemId');
      expect(row).toHaveProperty('stratum');
      expect(row).toHaveProperty('split');
    }
  }, 30_000);
});
