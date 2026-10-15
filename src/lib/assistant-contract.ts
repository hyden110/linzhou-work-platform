/**
 * Wire contract for a 方案助手 solution plan. Shared by the local runtime that
 * produces the plan and the browser that renders it, so both sides validate and
 * clamp against the same bounds: model output is never trusted as-is.
 */

export type SolutionEngine = "qoder-cli" | "template";

/** Safe reason codes explaining why the deterministic template was used instead. */
export type SolutionDegradeCode =
  | "cli-not-found"
  | "cli-timeout"
  | "cli-failed"
  | "cli-invalid-output";

export interface SolutionProduct {
  name: string;
  role: string;
}

export interface SolutionLayer {
  name: string;
  purpose: string;
  products: SolutionProduct[];
}

export interface SolutionFlow {
  name: string;
  steps: string[];
}

export interface SolutionMapping {
  need: string;
  product: string;
  reason: string;
}

export interface SolutionRisk {
  risk: string;
  mitigation: string;
}

/** Redacted retrieval evidence: controlled snippets only, never a raw source file. */
export interface SolutionEvidence {
  referenceId: string;
  title: string;
  sourceLabel: string;
  locator: string;
  text: string;
}

export interface SolutionDraft {
  title: string;
  summary: string;
  layers: SolutionLayer[];
  flows: SolutionFlow[];
  mapping: SolutionMapping[];
  risks: SolutionRisk[];
  nextSteps: string[];
}

export interface SolutionPlan extends SolutionDraft {
  engine: SolutionEngine;
  evidence: SolutionEvidence[];
  generatedAt: string;
  degraded?: SolutionDegradeCode;
}

export const SOLUTION_LIMITS = {
  title: 90,
  summary: 1_200,
  layers: 7,
  minLayers: 2,
  layerName: 30,
  layerPurpose: 200,
  productsPerLayer: 6,
  productName: 40,
  productRole: 220,
  flows: 4,
  flowName: 40,
  stepsPerFlow: 7,
  minStepsPerFlow: 2,
  step: 110,
  mapping: 12,
  mappingField: 160,
  risks: 6,
  riskField: 220,
  nextSteps: 8,
  nextStep: 160,
  evidence: 8,
  evidenceTitle: 140,
  evidenceSource: 40,
  evidenceLocator: 90,
  evidenceText: 320,
} as const;

const ENGINES = new Set<SolutionEngine>(["qoder-cli", "template"]);
const DEGRADE_CODES = new Set<SolutionDegradeCode>([
  "cli-not-found",
  "cli-timeout",
  "cli-failed",
  "cli-invalid-output",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Trims, strips control characters other than newlines, and clamps by code point. */
export function clampText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
  return Array.from(cleaned).slice(0, max).join("");
}

function requiredText(value: unknown, max: number): string | undefined {
  const text = clampText(value, max);
  return text.length >= 2 ? text : undefined;
}

function textList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => clampText(item, maxChars))
    .filter((item) => item.length >= 2);
}

function normalizeProducts(value: unknown): SolutionProduct[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOLUTION_LIMITS.productsPerLayer).flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = requiredText(item.name, SOLUTION_LIMITS.productName);
    if (!name) return [];
    return [{ name, role: clampText(item.role, SOLUTION_LIMITS.productRole) }];
  });
}

function normalizeLayers(value: unknown): SolutionLayer[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOLUTION_LIMITS.layers).flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = requiredText(item.name, SOLUTION_LIMITS.layerName);
    const products = normalizeProducts(item.products);
    if (!name || !products.length) return [];
    return [{ name, purpose: clampText(item.purpose, SOLUTION_LIMITS.layerPurpose), products }];
  });
}

function normalizeFlows(value: unknown): SolutionFlow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOLUTION_LIMITS.flows).flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = requiredText(item.name, SOLUTION_LIMITS.flowName);
    const steps = textList(item.steps, SOLUTION_LIMITS.stepsPerFlow, SOLUTION_LIMITS.step);
    if (!name || steps.length < SOLUTION_LIMITS.minStepsPerFlow) return [];
    return [{ name, steps }];
  });
}

function normalizeMapping(value: unknown): SolutionMapping[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOLUTION_LIMITS.mapping).flatMap((item) => {
    if (!isRecord(item)) return [];
    const need = requiredText(item.need, SOLUTION_LIMITS.mappingField);
    const product = requiredText(item.product, SOLUTION_LIMITS.mappingField);
    if (!need || !product) return [];
    return [{ need, product, reason: clampText(item.reason, SOLUTION_LIMITS.mappingField) }];
  });
}

function normalizeRisks(value: unknown): SolutionRisk[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOLUTION_LIMITS.risks).flatMap((item) => {
    if (!isRecord(item)) return [];
    const risk = requiredText(item.risk, SOLUTION_LIMITS.riskField);
    if (!risk) return [];
    return [{ risk, mitigation: clampText(item.mitigation, SOLUTION_LIMITS.riskField) }];
  });
}

/**
 * Validates and clamps generator output. Returns undefined when the draft cannot
 * be shown as an architecture plan at all (no title, no summary or fewer than two
 * product-bearing layers), so the caller can fall back to the template.
 */
export function normalizeSolutionDraft(value: unknown): SolutionDraft | undefined {
  if (!isRecord(value)) return undefined;
  const title = requiredText(value.title, SOLUTION_LIMITS.title);
  const summary = requiredText(value.summary, SOLUTION_LIMITS.summary);
  const layers = normalizeLayers(value.layers);
  if (!title || !summary || layers.length < SOLUTION_LIMITS.minLayers) return undefined;
  return {
    title,
    summary,
    layers,
    flows: normalizeFlows(value.flows),
    mapping: normalizeMapping(value.mapping),
    risks: normalizeRisks(value.risks),
    nextSteps: textList(value.nextSteps, SOLUTION_LIMITS.nextSteps, SOLUTION_LIMITS.nextStep),
  };
}

function normalizeEvidence(value: unknown): SolutionEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SOLUTION_LIMITS.evidence).flatMap((item) => {
    if (!isRecord(item)) return [];
    const referenceId = requiredText(item.referenceId, 160);
    const text = requiredText(item.text, SOLUTION_LIMITS.evidenceText);
    if (!referenceId || !text) return [];
    return [{
      referenceId,
      title: clampText(item.title, SOLUTION_LIMITS.evidenceTitle),
      sourceLabel: clampText(item.sourceLabel, SOLUTION_LIMITS.evidenceSource),
      locator: clampText(item.locator, SOLUTION_LIMITS.evidenceLocator),
      text,
    }];
  });
}

/** Full response validation for the browser side, clamping everything it renders. */
export function parseSolutionPlan(value: unknown): SolutionPlan | undefined {
  if (!isRecord(value)) return undefined;
  const draft = normalizeSolutionDraft(value);
  if (!draft) return undefined;
  const engine = typeof value.engine === "string" && ENGINES.has(value.engine as SolutionEngine)
    ? (value.engine as SolutionEngine)
    : undefined;
  const generatedAt = typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt))
    ? value.generatedAt
    : undefined;
  if (!engine || !generatedAt) return undefined;
  const degraded = typeof value.degraded === "string" && DEGRADE_CODES.has(value.degraded as SolutionDegradeCode)
    ? (value.degraded as SolutionDegradeCode)
    : undefined;
  return { ...draft, engine, generatedAt, evidence: normalizeEvidence(value.evidence), degraded };
}
