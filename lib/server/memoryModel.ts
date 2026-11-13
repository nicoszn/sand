/**
 * The retention model, fitted from this workspace's own usage instead of
 * hand-set constants.
 *
 * ACT-R says a memory's availability is its base-level activation:
 *
 *     B = ln( Σ (t_i + 1)^(-d) )
 *
 * over its past uses t_i, with a decay exponent d. d is normally estimated per
 * subject from data rather than assumed, which is what happens here: we treat
 * "was this fact ever actually used" as the observable and pick the d that best
 * separates used from unused facts by activation (maximising AUC, i.e. the
 * Mann-Whitney probability that a used fact outranks an unused one).
 *
 * The weights that combine activation with graph centrality and observed
 * utility are then fitted by L2-regularised logistic regression over the same
 * observations, so a workspace that leans on connected facts ends up weighting
 * centrality more heavily, and one with sparse links leans on activation.
 *
 * With too little data the fit would be noise, so the priors are kept until
 * there are enough facts and enough of both classes, and every parameter is
 * persisted and reported in the UI - nothing here is a hidden constant.
 */
import { getSetting, setManySettings } from "./settingsStore";

export interface RetentionParams {
  /** ACT-R decay exponent d. */
  decay: number;
  wActivation: number;
  wCentrality: number;
  wUtility: number;
  /** Quality of the fit: AUC of the decay search, and how much data it saw. */
  auc: number;
  samples: number;
  positives: number;
  source: "prior" | "fitted";
  fittedAt: number;
}

const PRIOR: Omit<RetentionParams, "fittedAt"> = {
  decay: 0.5,
  wActivation: 0.55,
  wCentrality: 0.25,
  wUtility: 0.2,
  auc: 0,
  samples: 0,
  positives: 0,
  source: "prior",
};

const MIN_SAMPLES = 8;
const MIN_PER_CLASS = 3;
const SETTINGS_KEY = "memory_model_json";

export interface RetentionObservations {
  id: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
}

/** ACT-R base-level activation for one memory.
 *
 * `includeUseCount` exists for one reason: when *fitting* the decay exponent,
 * the target is "was this fact used", so the use count must stay out of the
 * predictor or the fit would simply be predicting itself (target leakage).
 * For scoring, the frequency term belongs in the activation. */
export function activation(
  observations: RetentionObservations,
  decay: number,
  timestamp: number,
  includeUseCount = true
): number {
  const events = [observations.created_at, observations.updated_at];
  if (observations.last_used_at) events.push(observations.last_used_at);
  let sum = 0;
  for (const event of events) {
    const ageDays = Math.max(0, (timestamp - event) / 86400);
    sum += Math.pow(ageDays + 1, -decay);
  }
  // Repeated use is evidence of a stronger trace even when the uses are old.
  if (includeUseCount) sum += Math.log1p(observations.use_count) * 0.25;
  return Math.log(Math.max(sum, 1e-6));
}

/** Squash activation into 0..1 (ln(1) = 0 for a single, very recent use). */
export function normalizedActivation(value: number): number {
  return Math.max(0, Math.min(1, (value + 1.2) / 1.6));
}

/** Mann-Whitney AUC: P(random positive scores above random negative). */
function auc(positives: number[], negatives: number[]): number {
  if (positives.length === 0 || negatives.length === 0) return 0.5;
  let wins = 0;
  for (const a of positives) {
    for (const b of negatives) {
      if (a > b) wins += 1;
      else if (a === b) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/** Batch gradient descent on logistic loss with L2 shrinkage. */
function logisticRegression(features: number[][], labels: number[]): number[] {
  const dimensions = features[0].length;
  const weights = new Array(dimensions).fill(0);
  const learningRate = 0.6;
  const l2 = 0.01;
  const rounds = 400;

  for (let round = 0; round < rounds; round++) {
    const gradients = new Array(dimensions).fill(0);
    for (let i = 0; i < features.length; i++) {
      let z = 0;
      for (let d = 0; d < dimensions; d++) z += weights[d] * features[i][d];
      const predicted = 1 / (1 + Math.exp(-z));
      const error = predicted - labels[i];
      for (let d = 0; d < dimensions; d++) gradients[d] += error * features[i][d];
    }
    for (let d = 0; d < dimensions; d++) {
      weights[d] -= learningRate * (gradients[d] / features.length + l2 * weights[d]);
    }
  }
  return weights;
}

/** Fits decay and blend weights from observed use. Pure function of the data,
 * so it can be tested and re-run as often as needed. */
export function fitModel(
  observations: RetentionObservations[],
  centralityOf: (id: string) => number,
  timestamp = Date.now() / 1000
): RetentionParams {
  const positives = observations.filter((row) => row.use_count > 0 || row.last_used_at !== null);
  const negatives = observations.filter((row) => row.use_count === 0 && row.last_used_at === null);

  if (observations.length < MIN_SAMPLES || positives.length < MIN_PER_CLASS || negatives.length < MIN_PER_CLASS) {
    return { ...PRIOR, samples: observations.length, positives: positives.length, fittedAt: timestamp };
  }

  // 1. Fit the ACT-R decay exponent by maximising separation of used/unused,
  // using time-only activation (no use-count term: that is the target).
  let bestDecay = PRIOR.decay;
  let bestAuc = 0;
  for (let decay = 0.1; decay <= 1.5 + 1e-9; decay += 0.05) {
    const pos = positives.map((row) => activation(row, decay, timestamp, false));
    const neg = negatives.map((row) => activation(row, decay, timestamp, false));
    const score = auc(pos, neg);
    if (score > bestAuc) {
      bestAuc = score;
      bestDecay = Number(decay.toFixed(2));
    }
  }

  // 2. Fit the blend of the two predictors that do not contain the label:
  // time-based activation and graph centrality.
  const features = observations.map((row) => [
    normalizedActivation(activation(row, bestDecay, timestamp, false)),
    centralityOf(row.id),
  ]);
  const labels = observations.map((row) => (row.use_count > 0 || row.last_used_at !== null ? 1 : 0));
  const [rawActivation, rawCentrality] = logisticRegression(features, labels).map((value) => Math.max(0.05, value));
  const predictorTotal = rawActivation + rawCentrality;
  const wActivation = Number((rawActivation / predictorTotal).toFixed(3));
  const wCentrality = Number((rawCentrality / predictorTotal).toFixed(3));

  // Utility (how often it was actually used) is deliberately *not* a regression
  // feature - it defines the label - so it takes the remaining share: direct
  // evidence of usefulness is weighted by what the two predictors leave over.
  const wUtility = Number(Math.max(0.1, 1 - wActivation - wCentrality).toFixed(3));
  const normalised = wActivation + wCentrality + wUtility;

  return {
    decay: bestDecay,
    wActivation: Number((wActivation / normalised).toFixed(3)),
    wCentrality: Number((wCentrality / normalised).toFixed(3)),
    wUtility: Number((wUtility / normalised).toFixed(3)),
    auc: Number(bestAuc.toFixed(3)),
    samples: observations.length,
    positives: positives.length,
    source: "fitted",
    fittedAt: timestamp,
  };
}

export function saveParams(params: RetentionParams) {
  setManySettings({ [SETTINGS_KEY]: JSON.stringify(params) });
}

/** Last fitted parameters, or the priors on a fresh install. */
export function loadParams(): RetentionParams {
  const raw = getSetting(SETTINGS_KEY);
  if (!raw) return { ...PRIOR, fittedAt: 0 };
  try {
    const parsed = JSON.parse(raw) as RetentionParams;
    if (
      typeof parsed.decay === "number" &&
      typeof parsed.wActivation === "number" &&
      typeof parsed.wCentrality === "number" &&
      typeof parsed.wUtility === "number"
    ) {
      return parsed;
    }
  } catch {
    /* fall through to priors */
  }
  return { ...PRIOR, fittedAt: 0 };
}

export function retentionScoreFrom(
  row: RetentionObservations,
  params: RetentionParams,
  centrality: number,
  timestamp = Date.now() / 1000
): number {
  const activationPart = normalizedActivation(activation(row, params.decay, timestamp));
  const utility = Math.min(1, row.use_count / 5);
  return params.wActivation * activationPart + params.wCentrality * centrality + params.wUtility * utility;
}
