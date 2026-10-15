import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { bailianPost, createBailianQueryEmbedder, validBailianKey } from "../functions/bailian.ts";

interface EvalCase {
  id: string;
  question: string;
  expectedDocumentId: string | null;
  expectedTitle?: string;
}

interface BundleDocument {
  id: string;
  title: string;
  citations: Array<{ id: string; text: string }>;
}

const EVAL_PATH = ".local-cache/retrieval-eval.json";
const SAMPLE_SIZE = 48;
const SEED = 20261012;
const OUT_OF_SCOPE = [
  "今天上海的天气怎么样",
  "帮我写一首关于秋天的七言绝句",
  "红烧肉怎么做才不腻",
  "2018 年世界杯冠军是哪个国家",
  "比特币明天会涨还是跌",
  "推荐几部适合周末看的科幻电影",
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function apiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!validBailianKey(key)) throw new Error("DASHSCOPE_API_KEY is not configured");
  return key;
}

async function loadBundle(path: string): Promise<{ documents: BundleDocument[] }> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function questionFor(passage: string, style: "keyword" | "paraphrase"): Promise<string> {
  const instruction = style === "keyword"
    ? "用售前架构师的口吻提一个具体问题，可以使用片段中的关键术语。"
    : "用售前架构师的口吻提一个具体问题，尽量换一种说法，不要照抄片段里的词组。";
  const payload = await bailianPost({ apiKey: apiKey() }, "/chat/completions", {
    model: "qwen-plus",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: "你为检索评测出题。问题必须能仅凭给定片段回答，不提及“片段”“文档”，不超过 40 字。只输出问题本身。",
      },
      { role: "user", content: `${instruction}\n\n片段：\n${passage}` },
    ],
  }, 30_000);
  const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  if (!text) throw new Error("question generation returned no text");
  return text.split("\n")[0].replace(/^["“]|["”]$/g, "");
}

async function generate(bundlePath: string): Promise<void> {
  const random = mulberry32(SEED);
  const pool = (await loadBundle(bundlePath)).documents.filter((document) => (
    document.citations.some((citation) => citation.text.length >= 120)
  ));
  const picked = new Map<string, BundleDocument>();
  while (picked.size < SAMPLE_SIZE && picked.size < pool.length) {
    const document = pool[Math.floor(random() * pool.length)];
    picked.set(document.id, document);
  }
  const documents = [...picked.values()];
  const cases: EvalCase[] = [];
  for (const [position, document] of documents.entries()) {
    const passages = document.citations.filter((citation) => citation.text.length >= 120);
    const passage = passages[Math.floor(random() * passages.length)];
    const question = await questionFor(passage.text, position % 2 ? "paraphrase" : "keyword");
    cases.push({ id: `q${position + 1}`, question, expectedDocumentId: document.id, expectedTitle: document.title });
    process.stdout.write(".");
  }
  const outOfScope = OUT_OF_SCOPE.map((question, index) => ({
    id: `oos${index + 1}`,
    question,
    expectedDocumentId: null,
  }));
  await writeFile(EVAL_PATH, `${JSON.stringify([...cases, ...outOfScope], null, 2)}\n`, { mode: 0o600 });
  console.log(`\nwrote ${cases.length + outOfScope.length} cases`);
}

async function run(modulePath: string, bundlePath: string, useEmbeddings: boolean): Promise<void> {
  const module = await import(pathToFileURL(modulePath).href);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const cases: EvalCase[] = JSON.parse(await readFile(EVAL_PATH, "utf8"));
  const embedQuery = useEmbeddings
    ? createBailianQueryEmbedder({ apiKey: apiKey(), model: "text-embedding-v4", dimensions: 256 })
    : undefined;
  const titleById = new Map<string, string>(bundle.documents.map((item: BundleDocument) => [item.id, item.title]));
  let hit1 = 0, hit5 = 0, hit10 = 0, reciprocal = 0, inScope = 0, falseRefusals = 0, correctRefusals = 0, outScope = 0;
  const misses: string[] = [];
  for (const item of cases) {
    const response = await module.retrieve(
      { query: item.question, mode: "search", requestId: `eval-${item.id}` },
      bundle,
      { embedQuery },
    );
    const refused = response.status === "insufficient-evidence";
    if (item.expectedDocumentId === null) {
      outScope += 1;
      if (refused) correctRefusals += 1;
      continue;
    }
    inScope += 1;
    if (refused) falseRefusals += 1;
    const ids: string[] = response.results.map((result: { documentId: string }) => result.documentId);
    const rank = ids.findIndex((id) => id === item.expectedDocumentId || titleById.get(id) === item.expectedTitle);
    if (rank === 0) hit1 += 1;
    if (rank >= 0 && rank < 5) hit5 += 1;
    if (rank >= 0 && rank < 10) hit10 += 1;
    if (rank >= 0) reciprocal += 1 / (rank + 1);
    else misses.push(`${item.id} ${item.question}`);
  }
  const ratio = (value: number, total: number) => `${(value / Math.max(total, 1) * 100).toFixed(1)}%`;
  console.log(JSON.stringify({
    module: modulePath,
    inScope,
    "recall@1": ratio(hit1, inScope),
    "recall@5": ratio(hit5, inScope),
    "recall@10": ratio(hit10, inScope),
    mrr: (reciprocal / Math.max(inScope, 1)).toFixed(3),
    falseRefusals,
    outOfScopeRefused: `${correctRefusals}/${outScope}`,
  }, null, 2));
  if (process.env.EVAL_SHOW_MISSES) console.log(misses.join("\n"));
}

const [command, ...args] = process.argv.slice(2);
if (command === "generate") await generate(args[0] ?? "functions/retrieval-bundle.json");
else if (command === "run") await run(args[0], args[1], args[2] === "--embeddings");
else throw new Error("usage: retrieval-eval.ts generate [bundle] | run <module> <bundle> [--embeddings]");
