import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJsonl, parseJsonl, readJsonlFile, writeJsonlFile } from '../src/corpus.js';

describe('corpus JSONL round-trip', () => {
  it('toJsonl/parseJsonl round-trip a list of objects, including one with a unicode string', () => {
    const items = [
      { id: 't1', text: 'plain ascii ticket' },
      { id: 't2', text: 'emoji + accents: café ☕ 日本語 — “quoted”' },
      { id: 't3', text: 'trailing newline in value\n' },
    ];
    const jsonl = toJsonl(items);
    expect(jsonl.endsWith('\n')).toBe(true);
    const parsed = parseJsonl<{ id: string; text: string }>(jsonl);
    expect(parsed).toEqual(items);
  });

  it('parseJsonl tolerates blank lines (leading, trailing, and in the middle)', () => {
    const text = '\n{"id":"a"}\n\n{"id":"b"}\n\n\n';
    const parsed = parseJsonl<{ id: string }>(text);
    expect(parsed).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('parseJsonl returns an empty array for blank/empty input', () => {
    expect(parseJsonl('')).toEqual([]);
    expect(parseJsonl('\n\n\n')).toEqual([]);
  });

  it('writeJsonlFile/readJsonlFile round-trip through a temp file, creating parent dirs as needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goldgate-corpus-test-'));
    try {
      const path = join(dir, 'nested', 'corpus.jsonl');
      const items = [
        { id: 'u1', text: 'unicode: naïve café résumé 你好' },
        { id: 'u2', text: 'second row' },
      ];
      writeJsonlFile(path, items);
      const roundTripped = readJsonlFile<{ id: string; text: string }>(path);
      expect(roundTripped).toEqual(items);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
