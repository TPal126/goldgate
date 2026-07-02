// Mocked-SDK tests for the goldgate/anthropic adapter (spec Phase 3 lift,
// Task 15). @anthropic-ai/sdk's default export is mocked; the pure
// zodOutputFormat helper (no network) is left real. See
// tests/anthropic-live.test.ts for the (skipped-by-default) live smoke test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

const mockParse = vi.fn();
const mockBatchCreate = vi.fn();
const mockBatchRetrieve = vi.fn();
const mockBatchResults = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      parse: mockParse,
      batches: {
        create: mockBatchCreate,
        retrieve: mockBatchRetrieve,
        results: mockBatchResults,
      },
    },
  })),
}));

const { createClaudeExtractFn, createClaudeBatch, schemaHash, ANTHROPIC_PRICES } =
  await import('../anthropic/index.js');

interface Item { id: string; text: string }
const schema = z.object({ kind: z.enum(['note', 'commitment']), certainty: z.enum(['low', 'high']) });

function fakeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < items.length ? { value: items[i++] as T, done: false } : { value: undefined, done: true }),
      };
    },
  };
}

beforeEach(() => {
  mockParse.mockReset();
  mockBatchCreate.mockReset();
  mockBatchRetrieve.mockReset();
  mockBatchResults.mockReset();
});

describe('createClaudeExtractFn', () => {
  it('returns { prediction, usage } on a parsed end_turn response', async () => {
    mockParse.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      parsed_output: { kind: 'commitment', certainty: 'high' },
      usage: { input_tokens: 120, output_tokens: 40 },
    });
    const fn = createClaudeExtractFn<Item, { kind: string; certainty: string }>({
      schema, systemPrompt: 'sys', renderInput: ({ target }) => `T:${target.text}`, model: 'claude-opus-4-8',
    });
    const r = await fn({ target: { id: 't1', text: 'hi' }, context: [] });

    expect(r.prediction).toEqual({ kind: 'commitment', certainty: 'high' });
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    const call = mockParse.mock.calls[0]![0] as { model: string; system: string; messages: { content: string }[] };
    expect(call.model).toBe('claude-opus-4-8');
    expect(call.system).toBe('sys');
    expect(call.messages[0]!.content).toBe('T:hi');
  });

  it('throws when stop_reason is not end_turn (errored-item path)', async () => {
    mockParse.mockResolvedValueOnce({
      stop_reason: 'refusal',
      parsed_output: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const fn = createClaudeExtractFn<Item, unknown>({
      schema, systemPrompt: 'sys', renderInput: () => 'x', model: 'claude-opus-4-8',
    });
    await expect(fn({ target: { id: 't1', text: 'hi' }, context: [] })).rejects.toThrow(/stop_reason/);
  });

  it('throws when parsed_output is null even with end_turn', async () => {
    mockParse.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      parsed_output: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const fn = createClaudeExtractFn<Item, unknown>({
      schema, systemPrompt: 'sys', renderInput: () => 'x', model: 'claude-opus-4-8',
    });
    await expect(fn({ target: { id: 't1', text: 'hi' }, context: [] })).rejects.toThrow();
  });
});

describe('createClaudeBatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls until ended, maps a succeeded entry through schema.safeParse, marks an errored entry', async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: 'batch_1' });
    mockBatchRetrieve
      .mockResolvedValueOnce({
        processing_status: 'in_progress',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        request_counts: { processing: 2 },
      })
      .mockResolvedValueOnce({ processing_status: 'ended', expires_at: null, request_counts: { succeeded: 1, errored: 1 } });
    mockBatchResults.mockResolvedValueOnce(fakeAsyncIterable([
      {
        custom_id: 'x1',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: JSON.stringify({ kind: 'commitment', certainty: 'high' }) }],
            usage: { input_tokens: 50, output_tokens: 10 },
          },
        },
      },
      { custom_id: 'x2', result: { type: 'errored' } },
    ]));

    const batchExtractor = createClaudeBatch<Item & { id: string }, { kind: string; certainty: string }>({
      schema, systemPrompt: 'sys', renderInput: ({ target }) => target.text, model: 'claude-opus-4-8',
      contextWindow: 0, pollIntervalMs: 1000,
    });

    const targets = [{ id: 'x1', text: 'a' }, { id: 'x2', text: 'b' }];
    const promise = batchExtractor.batch(targets, targets);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.get('x1')!.prediction).toEqual({ kind: 'commitment', certainty: 'high' });
    expect(result.get('x1')!.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    expect(result.get('x2')!.prediction).toBeNull();
    expect(result.get('x2')!.error).toBe('batch result: errored');
  });

  it('throws once Date.now() >= expires_at while processing_status is still not ended', async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: 'batch_2' });
    mockBatchRetrieve.mockResolvedValue({
      processing_status: 'in_progress',
      expires_at: new Date(Date.now() - 1).toISOString(),
      request_counts: { processing: 1 },
    });
    const batchExtractor = createClaudeBatch<Item & { id: string }, unknown>({
      schema, systemPrompt: 'sys', renderInput: ({ target }) => target.text, model: 'claude-opus-4-8',
      contextWindow: 0, pollIntervalMs: 1000,
    });
    await expect(batchExtractor.batch([{ id: 'x1', text: 'a' }], [])).rejects.toThrow(/expires_at/);
  });

  it('maps schema-invalid succeeded text to prediction: null with a schema-validation error', async () => {
    mockBatchCreate.mockResolvedValueOnce({ id: 'batch_3' });
    mockBatchRetrieve.mockResolvedValueOnce({ processing_status: 'ended', expires_at: null, request_counts: { succeeded: 1 } });
    mockBatchResults.mockResolvedValueOnce(fakeAsyncIterable([
      {
        custom_id: 'x1',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: JSON.stringify({ kind: 'not-a-real-kind' }) }],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        },
      },
    ]));
    const batchExtractor = createClaudeBatch<Item & { id: string }, unknown>({
      schema, systemPrompt: 'sys', renderInput: ({ target }) => target.text, model: 'claude-opus-4-8',
      contextWindow: 0,
    });
    const result = await batchExtractor.batch([{ id: 'x1', text: 'a' }], []);
    expect(result.get('x1')!.prediction).toBeNull();
    expect(result.get('x1')!.error).toMatch(/schema validation failed/);
  });
});

describe('schemaHash', () => {
  it('is a stable sha256 hex digest of the compiled output format', () => {
    const h1 = schemaHash(schema);
    const h2 = schemaHash(schema);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });

  it('differs for a differently-shaped schema', () => {
    const other = z.object({ kind: z.literal('note') });
    expect(schemaHash(schema)).not.toBe(schemaHash(other));
  });
});

describe('ANTHROPIC_PRICES', () => {
  it('has in/out USD-per-1M-token entries for the current model lineup', () => {
    expect(ANTHROPIC_PRICES['claude-opus-4-8']).toEqual({ in: 5, out: 25 });
    expect(ANTHROPIC_PRICES['claude-sonnet-4-6']).toEqual({ in: 3, out: 15 });
    expect(ANTHROPIC_PRICES['claude-haiku-4-5']).toEqual({ in: 1, out: 5 });
  });
});
