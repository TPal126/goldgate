import { describe, it, expect } from 'vitest';
// Barrel-import assertion (spec: Task 17's goldgate.config.ts depends on
// defineConfig/GoldgateConfig/loadConfig being importable from 'goldgate').
import { defineConfig } from '../src/index.js';
import { loadConfig } from '../src/config.js';

describe('defineConfig (barrel import)', () => {
  it('is importable from the package barrel (src/index.ts) and is the identity function', () => {
    expect(typeof defineConfig).toBe('function');
    const c = { marker: 'passthrough' };
    expect(defineConfig(c as never)).toBe(c);
  });
});

describe('loadConfig', () => {
  it('loads the default export from a config file on disk', async () => {
    const cfg = await loadConfig('tests/fixtures/goldgate.config.ts');
    expect(cfg.task.kinds).toEqual(['note', 'bug', 'feature']);
    expect(typeof cfg.extractors['echo']).toBe('function');
    expect(cfg.paths.corpus).toMatch(/corpus\.jsonl$/);
    expect(cfg.paths.sample).toMatch(/sample\.jsonl$/);
  });

  it('rejects a config file with no default export, message names the missing default export', async () => {
    await expect(loadConfig('tests/fixtures/goldgate.config-no-default.ts'))
      .rejects.toThrow(/default export/);
  });
});
