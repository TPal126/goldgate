// The generic contract: everything task-specific lives in one TaskSpec
// object; sample/metrics/runner/label/report are parameterized by it. Gold
// and Pred are entirely task-shaped — the harness reads them only through
// accessors, which is what lets committed labels from the source pipeline
// (keyed by message id) migrate with zero data changes.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface FieldComparison {
  field: string;
  type: 'structured' | 'freetext';
  gold: string;
  predicted: string;
}

export interface GateThresholds {
  minPooledPrecision: number;
  minWilsonLower: number;
  minPooledRecall: number;
  minPredictedPositives: number;
  maxNegativeFpRate: number;
  minStructuredExactMatch: number;
}

export interface LabelIO {
  ask(question: string, fallback: string): Promise<string>;
  say(line: string): void;
}

export type ExtractFn<Item, Pred> = (input: { target: Item; context: Item[] }) =>
  Promise<{ prediction: Pred; usage?: TokenUsage }>;

// Batch variant: one call sees all targets up front —
// how the Anthropic Batches API works. Keyed by Item.id.
export interface BatchExtractor<Item, Pred> {
  batch(targets: Item[], corpus: Item[]): Promise<Map<string, {
    prediction: Pred | null;
    usage?: TokenUsage;
    error?: string;
  }>>;
}

export type TaskExtractor<Item, Pred> = ExtractFn<Item, Pred> | BatchExtractor<Item, Pred>;

export function isBatchExtractor<Item, Pred>(
  e: TaskExtractor<Item, Pred>,
): e is BatchExtractor<Item, Pred> {
  return typeof e !== 'function';
}

export interface TaskSpec<Item extends { id: string; text: string }, Gold, Pred> {
  /** Label taxonomy. */
  kinds: readonly string[];
  /** The "nothing here" class; omit for all-positive tasks — the
   *  negative-FP-rate metric and gate criterion then don't apply. */
  negativeKind?: string;
  /** Kinds pooled for the release gate. */
  gatedKinds: readonly string[];
  /** Ordered low → high. Omit = no confidence thresholding, no calibration. */
  confidenceLevels?: readonly string[];

  idOfGold(g: Gold): string;
  kindOfGold(g: Gold): string;
  provenanceOfGold(g: Gold): 'hand' | 'assisted';
  /** Kind at a confidence threshold; undefined threshold = raw kind. */
  kindOfPred(p: Pred, minConfidence?: string): string;
  /** Drives the calibration table; omit = no calibration. */
  confidenceOfPred?(p: Pred): string | undefined;

  /** Structured/freetext field comparisons on true positives; omit = no
   *  field scoring and the structured-exact-match gate criterion is skipped. */
  compareFields?(g: Gold, p: Pred): FieldComparison[];
  /** Overrides for DEFAULT_GATE (harness/metrics.ts). */
  gate?: Partial<GateThresholds>;

  /** Context assembly for the extractor; omit = no context. */
  context?(corpus: Item[], target: Item, window: number): Item[];
  /** Recorded verbatim into every run config (promptHash, schemaHash, …). */
  configHashes?: Record<string, string>;

  /** Stratified-oversampling patterns; omit = boosted stratum is empty. */
  boostPatterns?: RegExp[];

  /** Required only to use the labeling CLI. */
  labeling?: {
    renderItem?(target: Item, context: Item[]): string;
    goldFromPrediction(itemId: string, p: Pred, provenance: 'hand' | 'assisted'): Gold;
    promptGold(input: {
      target: Item;
      context: Item[];
      kind: string;
      proposal?: Pred;
      io: LabelIO;
    }): Promise<Gold>;
  };
}
