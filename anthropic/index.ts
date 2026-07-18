// goldgate's Anthropic (Claude) adapter — ported from the original
// implementation's sync parse path and batch mode (expires_at bail-out
// kept verbatim). @anthropic-ai/sdk and zod are optional peers; this
// module is the ONLY place in goldgate that imports them — the core
// (src/) never does.
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { ZodType } from 'zod';
import type { ExtractFn, BatchExtractor, TokenUsage } from '../src/task.js';

// Inlined sha256Hex — 12 lines, not worth a shared dependency for a
// single adapter file.
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Hash of the exact compiled output format sent to the API — recorded in
// every eval run config so schema drift is visible across runs.
export function schemaHash(schema: ZodType): string {
  return sha256Hex(JSON.stringify(zodOutputFormat(schema)));
}

// Per-MTok USD prices for cost reporting (estimate; actuals from
// invoices). Pricing stays consumer-side (by design, no pricing in core) —
// the harness report only prints cost when the caller supplies costPer1MTokens.
export const ANTHROPIC_PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/**
 * A STABLE, typed timeout error thrown when THIS adapter's own upstream timeout
 * fires. The Anthropic SDK converts an aborted request into an `APIUserAbortError`
 * ("Request was aborted.") whose name/message do not mention a timeout, so a
 * consumer cannot distinguish a genuine timeout from any other abort. Rethrowing
 * as `GoldgateTimeoutError` (recognizable `.name`) lets a server map a real
 * timeout to 504 rather than a generic 502.
 */
export class GoldgateTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldgateTimeoutError';
  }
}

export interface ClaudeExtractorOptions<Item> {
  /** consumer's Zod schema */
  schema: ZodType;
  systemPrompt: string;
  /** user-message builder seam */
  renderInput(input: { target: Item; context: Item[] }): string;
  model: string;
  effort?: 'low' | 'medium' | 'high';
  /** default 2000 */
  maxTokens?: number;
  apiKey?: string;
  /** Optional custom fetch, forwarded to the Anthropic client (a test seam / proxy
   * hook). Additive and backward-compatible; omit to use the SDK default. */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional per-call upstream timeout (milliseconds). The SDK's own request
   * `timeout` is threaded through AND a local AbortController is armed for the
   * same budget, so the underlying fetch is GENUINELY cancelled (the abort is
   * observable on the signal) rather than merely surfacing a late 504. Omit to
   * keep the SDK default (10 minutes) — additive and backward-compatible.
   */
  timeoutMs?: number;
  /**
   * Optional external AbortSignal. If it (or the timeout) fires, the in-flight
   * request is aborted. Merged into the local controller so a caller can cancel
   * a parse from outside (e.g. a server shutting down).
   */
  signal?: AbortSignal;
}

function anthropicClientFor(
  apiKey: string | undefined,
  fetchImpl?: typeof globalThis.fetch,
): Anthropic {
  const clientOpts: { apiKey?: string; fetch?: typeof globalThis.fetch } = {};
  if (apiKey !== undefined) clientOpts.apiKey = apiKey;
  if (fetchImpl !== undefined) clientOpts.fetch = fetchImpl;
  return new Anthropic(clientOpts);
}

export function createClaudeExtractFn<Item, Pred>(
  opts: ClaudeExtractorOptions<Item>,
): ExtractFn<Item, Pred> {
  const client = anthropicClientFor(opts.apiKey, opts.fetch);
  const format = zodOutputFormat(opts.schema);

  return async (input) => {
    // A locally-armed AbortController makes the timeout GENUINELY cancelling:
    // even if the SDK's own `timeout` did nothing, this signal aborts the fetch,
    // and the abort is observable on `controller.signal`. An external signal is
    // merged in so a caller can cancel from outside. The timer is always cleared
    // in `finally` so a resolved/rejected request leaves no dangling timer and no
    // late unhandled rejection.
    const controller = new AbortController();
    const external = opts.signal;
    const onExternalAbort = (): void => {
      controller.abort((external as AbortSignal | undefined)?.reason);
    };
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeoutMs = opts.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set when OUR timeout fired (vs. an external caller-driven abort) so the catch
    // can rethrow a recognizable GoldgateTimeoutError only for a genuine timeout.
    let timedOut = false;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`extraction timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Do not keep the event loop alive purely for this timer (Node only).
      (timer as { unref?: () => void }).unref?.();
    }
    try {
      const resp = await client.messages.parse(
        {
          model: opts.model,
          max_tokens: opts.maxTokens ?? 2000,
          thinking: { type: 'adaptive' },
          system: opts.systemPrompt,
          messages: [{ role: 'user', content: opts.renderInput(input) }],
          output_config: {
            format,
            ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          },
        },
        {
          signal: controller.signal,
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        },
      );
      // Conservative by refusal-to-fabricate: a non-end_turn stop or a null
      // parsed_output surfaces as a thrown error — callers (the eval runner)
      // record it as an errored item rather than fabricating a prediction.
      if (resp.stop_reason !== 'end_turn' || resp.parsed_output === null || resp.parsed_output === undefined) {
        throw new Error(`extraction failed (stop_reason=${resp.stop_reason ?? 'null'})`);
      }
      return {
        prediction: resp.parsed_output as Pred,
        usage: {
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens,
        },
      };
    } catch (err) {
      // If OUR timeout fired, the SDK surfaces the abort as an APIUserAbortError
      // (name/message with no timeout signal). Rethrow a stable GoldgateTimeoutError
      // so a server maps a real timeout to 504, not a generic 502. An EXTERNAL abort
      // (timedOut === false) is left as-is — it is a caller cancel, not a timeout.
      if (timedOut) {
        throw new GoldgateTimeoutError(`extraction timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort);
    }
  };
}

// --- batch mode ---

export interface ClaudeBatchOptions<Item> extends ClaudeExtractorOptions<Item> {
  /** Context assembly for batch requests; omit = no context. */
  context?(corpus: Item[], target: Item, window: number): Item[];
  contextWindow: number;
  /** default 60_000 */
  pollIntervalMs?: number;
}

interface BatchRequest {
  custom_id: string;
  params: MessageCreateParamsNonStreaming;
}

// Provider-neutral shape extracted from batch results so mapping stays
// testable independent of the SDK's exact result typing.
interface BatchResultEntry {
  custom_id: string;
  kind: 'succeeded' | 'errored' | 'expired' | 'canceled';
  text: string | null;
  usage: TokenUsage | null;
}

export function createClaudeBatch<Item extends { id: string }, Pred>(
  opts: ClaudeBatchOptions<Item>,
): BatchExtractor<Item, Pred> {
  // AutoParseableOutputFormat<T> extends JSONOutputFormat, so this cast is
  // sound — same cast style as the original implementation's batch module.
  const format = zodOutputFormat(opts.schema) as MessageCreateParamsNonStreaming['output_config'] extends
    { format?: infer F | null } ? NonNullable<F> : never;

  function buildBatchRequests(targets: Item[], corpus: Item[]): BatchRequest[] {
    return targets.map((target) => ({
      custom_id: target.id,
      params: {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2000,
        thinking: { type: 'adaptive' as const },
        system: opts.systemPrompt,
        messages: [{
          role: 'user' as const,
          content: opts.renderInput({
            target,
            context: opts.context?.(corpus, target, opts.contextWindow) ?? [],
          }),
        }],
        output_config: {
          format,
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        },
      },
    }));
  }

  // Live execution: create the batch, poll until ended, stream results
  // into BatchResultEntry shape. The expires_at bail-out is kept VERBATIM
  // from the original implementation's runBatch: an unattended run must
  // not poll forever past the API's 24h batch expiry.
  async function runBatch(requests: BatchRequest[]): Promise<BatchResultEntry[]> {
    const client = anthropicClientFor(opts.apiKey);
    const pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    const batch = await client.messages.batches.create({ requests });
    console.log(`batch ${batch.id} created (${requests.length} requests)`);
    for (;;) {
      const b = await client.messages.batches.retrieve(batch.id);
      if (b.processing_status === 'ended') break;
      // A stuck batch must not poll forever on an unattended run: the API
      // expires batches at 24h — once past expires_at, bail loudly.
      if (b.expires_at !== null && Date.now() >= new Date(b.expires_at).getTime()) {
        throw new Error(`batch ${batch.id} passed expires_at without ending (status: ${b.processing_status})`);
      }
      console.log(`batch ${batch.id}: ${b.processing_status} (${JSON.stringify(b.request_counts)})`);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    const entries: BatchResultEntry[] = [];
    for await (const result of await client.messages.batches.results(batch.id)) {
      if (result.result.type === 'succeeded') {
        const msg = result.result.message;
        const textBlock = msg.content.find((c: { type: string }) => c.type === 'text');
        entries.push({
          custom_id: result.custom_id,
          kind: 'succeeded',
          text: textBlock !== undefined && 'text' in textBlock ? (textBlock as { text: string }).text : null,
          usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
        });
      } else {
        entries.push({
          custom_id: result.custom_id,
          kind: result.result.type,
          text: null,
          usage: null,
        });
      }
    }
    return entries;
  }

  function mapBatchResults(
    entries: BatchResultEntry[],
  ): Map<string, { prediction: Pred | null; usage?: TokenUsage; error?: string }> {
    const out = new Map<string, { prediction: Pred | null; usage?: TokenUsage; error?: string }>();
    for (const e of entries) {
      if (e.kind !== 'succeeded' || e.text === null) {
        out.set(e.custom_id, {
          prediction: null,
          ...(e.usage !== null ? { usage: e.usage } : {}),
          error: `batch result: ${e.kind}`,
        });
        continue;
      }
      try {
        const parsed = opts.schema.safeParse(JSON.parse(e.text));
        if (!parsed.success) {
          out.set(e.custom_id, {
            prediction: null,
            ...(e.usage !== null ? { usage: e.usage } : {}),
            error: `schema validation failed: ${parsed.error.message.slice(0, 200)}`,
          });
        } else {
          out.set(e.custom_id, {
            prediction: parsed.data as Pred,
            ...(e.usage !== null ? { usage: e.usage } : {}),
          });
        }
      } catch {
        out.set(e.custom_id, {
          prediction: null,
          ...(e.usage !== null ? { usage: e.usage } : {}),
          error: 'schema: result was not valid JSON',
        });
      }
    }
    return out;
  }

  return {
    batch: async (targets, corpus) => {
      const entries = await runBatch(buildBatchRequests(targets, corpus));
      return mapBatchResults(entries);
    },
  };
}
