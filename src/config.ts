// Config-driven CLI: a single defineConfig'd module
// wires a task + named extractor factories + default file paths, and the
// three CLI subcommands (sample/label/eval) load it via jiti so it can be
// authored in plain TypeScript with no build step of its own.
//
// Deliberately NO config-level configHashes hook: static hashes
// (promptHash, schemaHash, guidelinesHash, …) live on task.configHashes;
// the CLI eval command computes corpusHash/labelsHash itself (sha256 of
// the exact file bytes it read) and passes them via RunOptions.configExtras.
// sdkVersion is not recorded by the generic CLI — it was Anthropic-specific;
// consumers wanting it can run programmatically.
import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import type { TaskSpec, TaskExtractor } from './task.js';

export interface GoldgateConfig<
  I extends { id: string; text: string } = { id: string; text: string },
  G = unknown,
  P = unknown,
> {
  task: TaskSpec<I, G, P>;
  /** name → factory; CLI flags flow in. */
  extractors: Record<string, (opts: { model: string; effort?: string; contextWindow: number }) => TaskExtractor<I, P>>;
  /** workflow (optional) is the append-only protocol event log; defaults
   *  to a `workflow.jsonl` sibling of the sample file. */
  paths: { corpus: string; labels: string; sample: string; outDir: string; workflow?: string };
  defaultModel?: string;
  costPer1MTokens?: Record<string, { in: number; out: number }>;
}

export function defineConfig<I extends { id: string; text: string }, G, P>(
  c: GoldgateConfig<I, G, P>,
): GoldgateConfig<I, G, P> {
  return c;
}

export async function loadConfig(path: string): Promise<GoldgateConfig> {
  const absPath = resolve(path);
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import(absPath);
  // Not `mod.default === undefined`: jiti's CJS-interop proxy falls back
  // `.default` to the whole module namespace when no default export
  // exists, so a plain property read never observes `undefined` here.
  // `in` bypasses that fallback and reflects the real own-property set.
  if (!('default' in (mod as object))) {
    throw new Error(
      `goldgate config at ${path} has no default export — ` +
      `expected \`export default defineConfig({ task, extractors, paths, ... })\``,
    );
  }
  return (mod as { default: GoldgateConfig }).default;
}
