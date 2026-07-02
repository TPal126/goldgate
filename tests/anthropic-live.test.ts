import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createClaudeExtractFn } from '../anthropic/index.js';

// Live schema-compilation smoke test (ported from the original
// implementation's live-test gating pattern). Run explicitly with:
//   ANTHROPIC_API_KEY=... GOLDGATE_LIVE=1 npm test -- tests/anthropic-live.test.ts
// Excluded from default runs.
const live = process.env['ANTHROPIC_API_KEY'] !== undefined && process.env['GOLDGATE_LIVE'] === '1';

const schema = z.object({
  kind: z.enum(['note', 'commitment']),
  certainty: z.enum(['low', 'high']),
});

describe.skipIf(!live)('live API smoke', () => {
  it('compiles the schema and extracts an obvious commitment', async () => {
    const fn = createClaudeExtractFn<{ id: string; text: string }, z.infer<typeof schema>>({
      schema,
      systemPrompt: 'Classify the message as a commitment or a plain note.',
      renderInput: ({ target }) => target.text,
      model: 'claude-opus-4-8',
      effort: 'low',
    });
    const r = await fn({
      target: {
        id: 'live1',
        text: "I'll have the migration script finished and merged by 2026-06-19.",
      },
      context: [],
    });
    expect(r.prediction.kind).toBe('commitment');
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
  }, 120_000);
});
