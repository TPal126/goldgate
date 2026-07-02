#!/usr/bin/env node
// goldgate CLI — sample/label/eval subcommands over a defineConfig'd
// module (src/config.ts). Every file-path flag is an override with
// config.paths as the fallback.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { readJsonlFile, writeJsonlFile } from './corpus.js';
import { stratifiedSample } from './sample.js';
import type { SampleItem } from './sample.js';
import { runLabelSession } from './label.js';
import { runEval } from './runner.js';
import { isBatchExtractor } from './task.js';
import type { ExtractFn, LabelIO } from './task.js';

// --- argv helpers (ported from the original implementation) ---

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  // A following flag is not a value: `--split --extractor x` must not yield '--extractor'.
  if (next !== undefined && !next.startsWith('--')) return next;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

function argOpt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  if (next !== undefined && !next.startsWith('--')) return next;
  return undefined;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireSplit(): 'dev' | 'holdout' {
  const raw = arg('split');
  if (raw !== 'dev' && raw !== 'holdout') {
    console.error('--split must be dev or holdout');
    process.exit(1);
  }
  return raw;
}

// --- subcommands ---

async function cmdSample(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const corpusPath = argOpt('corpus') ?? config.paths.corpus;
  const outPath = argOpt('out') ?? config.paths.sample;

  const messages = readJsonlFile<{ id: string; text: string }>(corpusPath);
  const sample = stratifiedSample(messages, {
    total: parseInt(arg('total', '600'), 10),
    boostedShare: parseFloat(arg('boosted-share', '0.4')),
    holdoutShare: parseFloat(arg('holdout-share', '0.3')),
    seed: parseInt(arg('seed', '7'), 10),
    patterns: config.task.boostPatterns ?? [],
  });
  writeJsonlFile(outPath, sample);
  const counts = {
    dev: sample.filter((s) => s.split === 'dev').length,
    holdout: sample.filter((s) => s.split === 'holdout').length,
  };
  console.log(`sampled ${sample.length} (dev ${counts.dev} / holdout ${counts.holdout})`);
}

async function cmdLabel(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const corpusPath = argOpt('corpus') ?? config.paths.corpus;
  const samplePath = argOpt('sample') ?? config.paths.sample;
  const outPath = argOpt('out') ?? config.paths.labels;
  const split = requireSplit();
  const assistName = argOpt('assist');

  const corpus = readJsonlFile<{ id: string; text: string }>(corpusPath);
  const sample = readJsonlFile<SampleItem>(samplePath);
  const existingLabels = existsSync(outPath) ? readJsonlFile(outPath) : [];

  let assistFn: ExtractFn<{ id: string; text: string }, unknown> | undefined;
  if (assistName !== undefined) {
    const factory = config.extractors[assistName];
    if (factory === undefined) {
      console.error(`unknown extractor '${assistName}'`);
      process.exit(1);
    }
    const model = arg('model', config.defaultModel);
    const built = factory({ model, contextWindow: 5 });
    if (isBatchExtractor(built)) {
      console.error(`extractor '${assistName}' does not support --assist (batch-shaped)`);
      process.exit(1);
    }
    assistFn = built;
  }

  mkdirSync(dirname(outPath), { recursive: true });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: LabelIO = {
    ask: async (q, fallback) => {
      const a = await rl.question(`  ${q} [${fallback}]: `);
      return a.trim() || fallback;
    },
    say: (line) => console.log(line),
  };
  try {
    await runLabelSession({
      task: config.task, corpus, sample, existingLabels, split, out: outPath,
      ...(assistFn !== undefined ? { assist: assistFn } : {}), io,
    });
  } finally {
    rl.close();
  }
}

async function cmdEval(): Promise<void> {
  const config = await loadConfig(arg('config'));
  const corpusPath = argOpt('corpus') ?? config.paths.corpus;
  const labelsPath = argOpt('labels') ?? config.paths.labels;
  const samplePath = argOpt('sample') ?? config.paths.sample;
  const split = requireSplit();
  const extractorName = arg('extractor');
  const model = arg('model', config.defaultModel);
  const effort = argOpt('effort');
  const contextWindow = flag('no-context') ? 0 : parseInt(arg('context', '10'), 10);
  const mode = arg('mode', 'sync');
  const concurrency = parseInt(arg('concurrency', '4'), 10);

  const factory = config.extractors[extractorName];
  if (factory === undefined) {
    console.error(`unknown extractor '${extractorName}'`);
    process.exit(1);
  }
  const extractor = factory({ model, contextWindow, ...(effort !== undefined ? { effort } : {}) });
  if (mode === 'batch' && !isBatchExtractor(extractor)) {
    console.error(`extractor '${extractorName}' does not support batch mode`);
    process.exit(1);
  }

  const corpus = readJsonlFile<{ id: string; text: string }>(corpusPath);
  const labels = readJsonlFile(labelsPath);
  const sample = readJsonlFile<SampleItem>(samplePath);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const runId = `${stamp}-${extractorName}-${split}`;

  const costPer1MTokens = config.costPer1MTokens?.[model];

  const summary = await runEval({
    task: config.task, corpus, labels, sample, split,
    extractor, extractorName, model, contextWindow,
    ...(effort !== undefined ? { effort } : {}),
    mode,
    outDir: config.paths.outDir,
    runId,
    concurrency,
    configExtras: {
      corpusHash: sha256Hex(readFileSync(corpusPath, 'utf8')),
      labelsHash: sha256Hex(readFileSync(labelsPath, 'utf8')),
    },
    ...(costPer1MTokens !== undefined ? { costPer1MTokens } : {}),
  });
  console.log(`done: ${summary.items.length} items, ${summary.pooled.errored} errored`);
  console.log(`report: ${summary.reportPath}`);
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === 'sample') return cmdSample();
  if (sub === 'label') return cmdLabel();
  if (sub === 'eval') return cmdEval();
  console.error('usage: goldgate <sample|label|eval> --config <path> [...]');
  process.exit(2);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
