export interface RankableCitation {
  id: string;
  text: string;
  vector?: string;
}

export interface RankableDocument {
  title: string;
  topics: string[];
  relativePath: string;
  summary: string;
  citations: RankableCitation[];
  vector?: string;
}

export interface RankedPassage {
  documentIndex: number;
  citationIndex: number;
  fused: number;
  keyword: number;
  coverage: number;
  vector: number;
}

interface SearchIndex {
  documentOf: Int32Array;
  citationOf: Int32Array;
  lengths: Float64Array;
  averageLength: number;
  postings: Map<string, number[]>;
  vectors?: Int8Array;
  vectorNorms?: Float64Array;
  dimensions: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;
const CANDIDATES_PER_RANKER = 200;
const QUERY_STOP_TOKENS = new Set([
  "怎么样", "什么样", "为什么",
  "如何", "怎么", "怎样", "什么", "哪些", "哪个", "哪一", "是否", "为何", "能否", "可以", "应该",
  "进行", "我们", "你们", "一下", "这个", "那个", "这些", "那些", "以及", "或者",
  "材料", "资料", "文档", "相关", "有关", "关于", "内容", "方面", "一些", "给我", "帮我", "查找",
]);
// Stop phrases and particles split a question into words before bigramming, so no bigram spans them ("会的", "么样").
const QUERY_SEPARATORS = new RegExp(`${[...QUERY_STOP_TOKENS].join("|")}|[的了吗呢吧和与及或]`, "g");
const indexCache = new WeakMap<readonly RankableDocument[], SearchIndex>();

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  const latin = (normalized.match(/[a-z0-9][a-z0-9_+-]*(?:\.[a-z0-9]+)*/g) ?? []).filter((token) => token.length > 1);
  const chinese = (normalized.match(/[\u3400-\u9fff]+/g) ?? []).flatMap((run) => {
    const characters = [...run];
    if (characters.length === 1) return characters;
    return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
  });
  return [...latin, ...chinese];
}

export interface QueryTerm {
  token: string;
  weight: number;
}

/**
 * Each CJK word contributes roughly one unit no matter how many overlapping bigrams it splits into,
 * so a four-character event name cannot outweigh a single product name in the query.
 */
export function queryTerms(value: string): QueryTerm[] {
  const normalized = normalizeText(value);
  const weights = new Map<string, number>();
  const add = (token: string, weight: number) => {
    if (QUERY_STOP_TOKENS.has(token)) return;
    weights.set(token, Math.max(weights.get(token) ?? 0, weight));
  };
  (normalized.match(/[a-z0-9][a-z0-9_+-]*(?:\.[a-z0-9]+)*/g) ?? [])
    .filter((token) => token.length > 1)
    .forEach((token) => add(token, 1));
  (normalized.match(/[\u3400-\u9fff]+/g) ?? [])
    .flatMap((run) => {
      const segments = run.split(QUERY_SEPARATORS).filter(Boolean);
      // A lone character left over after splitting ("样" from "天气怎么样") is a fragment, not a word.
      return run.length === 1 ? segments : segments.filter((segment) => segment.length > 1);
    })
    .forEach((segment) => {
      const bigrams = tokenize(segment);
      bigrams.forEach((token) => add(token, 2 / (bigrams.length + 1)));
    });
  return [...weights.entries()].map(([token, weight]) => ({ token, weight }));
}

export function queryTokens(value: string): string[] {
  return queryTerms(value).map((term) => term.token);
}

function decodeInt8(value: string, dimensions: number): Int8Array | undefined {
  try {
    const binary = atob(value);
    if (binary.length !== dimensions) return undefined;
    return Int8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function passageTexts(document: RankableDocument): string[] {
  const header = [document.title, document.title, document.topics.join(" "), document.relativePath, document.summary];
  return [header.join(" "), ...document.citations.map((citation) => `${document.title} ${citation.text}`)];
}

function passageVectors(document: RankableDocument): Array<string | undefined> {
  return [document.vector, ...document.citations.map((citation) => citation.vector)];
}

function buildIndex(documents: readonly RankableDocument[], dimensions: number): SearchIndex {
  const documentOf: number[] = [];
  const citationOf: number[] = [];
  const lengths: number[] = [];
  const encodedVectors: Array<string | undefined> = [];
  const postings = new Map<string, number[]>();
  documents.forEach((document, documentIndex) => {
    const vectors = passageVectors(document);
    passageTexts(document).forEach((text, offset) => {
      const passageId = documentOf.length;
      const tokens = tokenize(text);
      const counts = new Map<string, number>();
      tokens.forEach((token) => counts.set(token, (counts.get(token) ?? 0) + 1));
      counts.forEach((count, token) => {
        const list = postings.get(token);
        if (list) list.push(passageId, count);
        else postings.set(token, [passageId, count]);
      });
      documentOf.push(documentIndex);
      citationOf.push(offset - 1);
      lengths.push(tokens.length);
      encodedVectors.push(vectors[offset]);
    });
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const index: SearchIndex = {
    documentOf: Int32Array.from(documentOf),
    citationOf: Int32Array.from(citationOf),
    lengths: Float64Array.from(lengths),
    averageLength: total / Math.max(lengths.length, 1),
    postings,
    dimensions,
  };
  if (!dimensions || !encodedVectors.some(Boolean)) return index;
  const vectors = new Int8Array(encodedVectors.length * dimensions);
  const vectorNorms = new Float64Array(encodedVectors.length);
  encodedVectors.forEach((encoded, passageId) => {
    const decoded = encoded ? decodeInt8(encoded, dimensions) : undefined;
    if (!decoded) return;
    vectors.set(decoded, passageId * dimensions);
    vectorNorms[passageId] = Math.sqrt(decoded.reduce((sum, value) => sum + value * value, 0));
  });
  return { ...index, vectors, vectorNorms };
}

function indexFor(documents: readonly RankableDocument[], dimensions: number): SearchIndex {
  const cached = indexCache.get(documents);
  if (cached && cached.dimensions === dimensions) return cached;
  const index = buildIndex(documents, dimensions);
  indexCache.set(documents, index);
  return index;
}

function keywordScores(index: SearchIndex, terms: readonly QueryTerm[], allowed: Uint8Array) {
  const count = index.lengths.length;
  const scores = new Float64Array(count);
  const matchedWeight = new Float64Array(count);
  let totalWeight = 0;
  for (const { token, weight } of terms) {
    const list = index.postings.get(token);
    const frequency = list ? list.length / 2 : 0;
    const idf = weight * Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5));
    totalWeight += idf;
    if (!list) continue;
    for (let offset = 0; offset < list.length; offset += 2) {
      const passageId = list[offset];
      if (!allowed[index.documentOf[passageId]]) continue;
      const termFrequency = list[offset + 1];
      const norm = BM25_K1 * (1 - BM25_B + BM25_B * index.lengths[passageId] / index.averageLength);
      scores[passageId] += idf * termFrequency * (BM25_K1 + 1) / (termFrequency + norm);
      matchedWeight[passageId] += idf;
    }
  }
  const coverage = matchedWeight.map((weight) => (totalWeight ? weight / totalWeight : 0));
  return { scores, coverage };
}

function vectorScores(index: SearchIndex, query: Float32Array, allowed: Uint8Array): Float64Array | undefined {
  const { vectors, vectorNorms, dimensions } = index;
  if (!vectors || !vectorNorms || query.length !== dimensions) return undefined;
  const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
  if (!queryNorm) return undefined;
  const scores = new Float64Array(vectorNorms.length);
  for (let passageId = 0; passageId < vectorNorms.length; passageId += 1) {
    if (!vectorNorms[passageId] || !allowed[index.documentOf[passageId]]) continue;
    let dot = 0;
    const start = passageId * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      dot += vectors[start + dimension] * query[dimension];
    }
    scores[passageId] = dot / (vectorNorms[passageId] * queryNorm);
  }
  return scores;
}

function topIds(scores: Float64Array, minimum: number): number[] {
  const ids: number[] = [];
  scores.forEach((score, passageId) => {
    if (score > minimum) ids.push(passageId);
  });
  return ids.sort((left, right) => scores[right] - scores[left]).slice(0, CANDIDATES_PER_RANKER);
}

/** Rank by distinct documents ahead, so one long document's many passages cannot push other exact matches down the fusion. */
function documentRanks(ranking: readonly number[], documentOf: Int32Array): number[] {
  const ahead = new Set<number>();
  return ranking.map((passageId) => {
    const documentIndex = documentOf[passageId];
    const rank = ahead.has(documentIndex) ? ahead.size - 1 : ahead.size;
    ahead.add(documentIndex);
    return rank;
  });
}

export function rankPassages(
  documents: readonly RankableDocument[],
  allowedDocuments: readonly boolean[],
  query: string,
  queryVector: Float32Array | undefined,
  dimensions: number,
): RankedPassage[] {
  const index = indexFor(documents, dimensions);
  const allowed = Uint8Array.from(allowedDocuments, (value) => (value ? 1 : 0));
  const keyword = keywordScores(index, queryTerms(query), allowed);
  const vector = queryVector ? vectorScores(index, queryVector, allowed) : undefined;
  const fused = new Map<number, number>();
  const rankings = [topIds(keyword.scores, 0), ...(vector ? [topIds(vector, 0)] : [])];
  rankings.forEach((ranking) => {
    const ranks = documentRanks(ranking, index.documentOf);
    ranking.forEach((passageId, position) => {
      fused.set(passageId, (fused.get(passageId) ?? 0) + 1 / (RRF_K + ranks[position] + 1));
    });
  });
  return [...fused.entries()]
    .map(([passageId, score]) => ({
      documentIndex: index.documentOf[passageId],
      citationIndex: index.citationOf[passageId],
      fused: score,
      keyword: keyword.scores[passageId],
      coverage: keyword.coverage[passageId],
      vector: vector ? vector[passageId] : 0,
    }))
    .sort((left, right) => right.fused - left.fused);
}
