import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SOLUTION_LIMITS, type SolutionEvidence } from "../src/lib/assistant-contract.ts";
import {
  buildPrompt,
  cliArgs,
  cliEnv,
  createSolutionGenerator,
  extractJsonPayload,
  extractModelText,
  resolveQoderCli,
  type CliInvocation,
  type CliOutcome,
} from "./solution-generator.ts";

const EVIDENCE: SolutionEvidence[] = [{
  referenceId: "doc-1:c1",
  title: "零售门店 AI 助手",
  sourceLabel: "案例库",
  locator: "section 架构总览",
  text: "零售门店 AI 助手参考架构与数据不出域约束",
}];

const REQUEST = {
  input: { customer: "某零售集团", industry: "零售与消费", goal: "建设门店 AI 助手", constraints: "数据不出域" },
  evidence: EVIDENCE,
  requestId: "req-1",
};

const VALID_DRAFT = {
  title: "某零售集团门店 AI 助手方案",
  summary: "以百炼为知识底座，构建带引用的门店助手。",
  layers: [
    { name: "接入层", purpose: "统一入口", products: [{ name: "API 网关", role: "鉴权限流" }] },
    { name: "模型层", purpose: "生成能力", products: [{ name: "阿里云百炼", role: "检索增强问答" }] },
  ],
  flows: [{ name: "问答链路", steps: ["提问", "检索", "生成"] }],
  mapping: [{ need: "可核验问答", product: "阿里云百炼", reason: "回答绑定引用" }],
  risks: [{ risk: "幻觉", mitigation: "阈值不足即拒答" }],
  nextSteps: ["确认验收指标"],
};

function envelope(result: unknown, isError = false): string {
  return [
    '{"type":"system","subtype":"init"}',
    JSON.stringify({ type: "result", subtype: "success", is_error: isError, result }),
  ].join("\n");
}

function runnerReturning(outcome: CliOutcome, seen: CliInvocation[] = []) {
  return async (invocation: CliInvocation): Promise<CliOutcome> => {
    seen.push(invocation);
    return outcome;
  };
}

test("reads the model text out of the CLI json envelope", () => {
  assert.equal(extractModelText(envelope('{"ok":true}')), '{"ok":true}');
  assert.equal(extractModelText(`warning line\n${envelope("文本")}`), "文本");
  assert.equal(extractModelText(envelope("boom", true)), undefined);
  assert.equal(extractModelText("not json at all"), undefined);
  assert.equal(extractModelText(""), undefined);
});

test("unwraps fenced and padded json payloads", () => {
  assert.equal(extractJsonPayload('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonPayload('好的：{"a":1} 希望有帮助'), '{"a":1}');
  assert.equal(extractJsonPayload("没有对象"), undefined);
});

test("strips Agent SDK markers from the child environment", () => {
  const env = cliEnv({
    PATH: "/usr/bin",
    QODER_AGENT_SDK_ENTRYPOINT: "sdk-ts",
    QODER_AGENT_SDK_VERSION: "1.0.51",
    QODERCLI_RUNTIME_PACKAGING: "worker_mjs",
    QODER_SDK_AUTH_PAYLOAD_FILE: "/tmp/payload.json",
    QW_QODER_WORKER_RUNTIME_PATH: "/tmp/wrapper.mjs",
    QODER_CONFIG_DIR: join("/Users", "someone", ".qoder"),
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.QODER_CONFIG_DIR, join("/Users", "someone", ".qoder"));
  for (const key of [
    "QODER_AGENT_SDK_ENTRYPOINT",
    "QODER_AGENT_SDK_VERSION",
    "QODERCLI_RUNTIME_PACKAGING",
    "QODER_SDK_AUTH_PAYLOAD_FILE",
    "QW_QODER_WORKER_RUNTIME_PATH",
  ]) {
    assert.equal(key in env, false, key);
  }
});

test("invokes the CLI headlessly with tools disabled and the prompt on stdin", async () => {
  const seen: CliInvocation[] = [];
  const generate = createSolutionGenerator({
    resolveBinary: async () => "/opt/qodercli",
    runner: runnerReturning({ ok: true, stdout: envelope(JSON.stringify(VALID_DRAFT)) }, seen),
    workdir: "/tmp/sa-workbench-assistant-test",
    now: () => new Date("2026-10-12T02:00:00Z"),
  });

  const plan = await generate(REQUEST);

  assert.equal(plan.engine, "qoder-cli");
  assert.equal(plan.degraded, undefined);
  assert.equal(plan.title, VALID_DRAFT.title);
  assert.equal(plan.generatedAt, "2026-10-12T02:00:00.000Z");
  assert.deepEqual(plan.evidence, EVIDENCE);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.binary, "/opt/qodercli");
  assert.deepEqual(seen[0]!.args.slice(-2), ["--tools", ""]);
  assert.ok(seen[0]!.args.includes("--strict-mcp-config"));
  assert.ok(seen[0]!.args.includes("-p"));
  assert.ok(seen[0]!.stdin.includes("某零售集团"));
  assert.ok(seen[0]!.stdin.includes("doc-1:c1"));
  assert.equal(seen[0]!.stdin.includes("/Users/linzhou"), false);
  assert.deepEqual(cliArgs(seen[0]!.workdir).slice(-2), ["--tools", ""]);
});

test("clamps oversized model output and drops unusable layers", async () => {
  const generate = createSolutionGenerator({
    resolveBinary: async () => "/opt/qodercli",
    runner: runnerReturning({
      ok: true,
      stdout: envelope(JSON.stringify({
        ...VALID_DRAFT,
        title: "标".repeat(SOLUTION_LIMITS.title + 50),
        layers: [
          { name: "空层", purpose: "没有产品", products: [] },
          { name: "字符串层" },
          ...VALID_DRAFT.layers,
        ],
        flows: [{ name: "只有一步", steps: ["单独一步"] }],
      })),
    }),
    workdir: "/tmp/sa-workbench-assistant-test",
  });

  const plan = await generate(REQUEST);

  assert.equal(plan.engine, "qoder-cli");
  assert.equal(Array.from(plan.title).length, SOLUTION_LIMITS.title);
  assert.deepEqual(plan.layers.map((layer) => layer.name), ["接入层", "模型层"]);
  assert.deepEqual(plan.flows, []);
});

test("falls back to the labelled Alibaba Cloud template when generation fails", async () => {
  const cases: Array<[CliOutcome | undefined, string]> = [
    [undefined, "cli-not-found"],
    [{ ok: false, code: "cli-timeout" }, "cli-timeout"],
    [{ ok: false, code: "cli-failed" }, "cli-failed"],
    [{ ok: true, stdout: envelope("这不是 JSON") }, "cli-invalid-output"],
    [{ ok: true, stdout: envelope(JSON.stringify({ title: "只有一层", layers: [VALID_DRAFT.layers[0]] })) }, "cli-invalid-output"],
  ];

  for (const [outcome, expected] of cases) {
    let called = 0;
    const generate = createSolutionGenerator({
      resolveBinary: async () => (outcome ? "/opt/qodercli" : undefined),
      runner: async () => {
        called += 1;
        return outcome ?? { ok: false, code: "cli-failed" };
      },
      workdir: "/tmp/sa-workbench-assistant-test",
    });

    const plan = await generate(REQUEST);
    assert.equal(plan.engine, "template", expected);
    assert.equal(plan.degraded, expected);
    assert.equal(called, outcome ? 1 : 0);
    assert.ok(plan.layers.length >= 4, `${expected} layers`);
    assert.ok(plan.summary.includes("参考架构模板"));
    assert.ok(plan.risks.length >= 3);
    assert.deepEqual(plan.evidence, EVIDENCE);
    const products = plan.layers.flatMap((layer) => layer.products.map((product) => product.name));
    assert.ok(products.includes("阿里云百炼"));
    assert.ok(products.includes("容器服务 Kubernetes 版 ACK"));
    assert.ok(plan.flows.every((flow) => flow.steps.length >= 2));
  }
});

test("adapts the template to research and data themes", async () => {
  const generate = createSolutionGenerator({
    resolveBinary: async () => undefined,
    workdir: "/tmp/sa-workbench-assistant-test",
  });
  const plan = await generate({
    ...REQUEST,
    input: {
      customer: "某制造集团",
      industry: "制造与工业",
      goal: "建设数据中台并用 AI 提升研发效率",
      constraints: "数据不出域",
    },
  });
  const text = JSON.stringify(plan);

  assert.equal(plan.engine, "template");
  assert.ok(text.includes("Qoder"));
  assert.ok(text.includes("大数据计算服务 MaxCompute"));
  assert.ok(text.includes("人工智能平台 PAI"));
  assert.ok(plan.flows.some((flow) => flow.name === "研发提效闭环"));
  assert.ok(plan.flows.some((flow) => flow.name === "数据加工链路"));
  assert.ok(plan.mapping.some((row) => row.need === "数据不出域"));
});

test("keeps the prompt bounded and free of local paths", () => {
  const many: SolutionEvidence[] = Array.from({ length: 12 }, (_, index) => ({
    referenceId: `doc-${index}:c1`,
    title: `资料 ${index}`,
    sourceLabel: "案例库",
    locator: "section 段落",
    text: "受控片段".repeat(120),
  }));
  const prompt = buildPrompt({ ...REQUEST, evidence: many });

  assert.equal(prompt.includes("doc-6:c1"), false);
  assert.ok(prompt.includes("doc-5:c1"));
  assert.ok(prompt.length < 16_000, `prompt length ${prompt.length}`);
  assert.equal(buildPrompt({ ...REQUEST, evidence: [] }).includes("没有召回到受控证据"), true);
});

test("prefers an explicit binary and skips broken symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sa-cli-"));
  const broken = join(dir, "qodercli");
  try {
    await symlink(join(dir, "missing-target"), broken);
    assert.equal(await resolveQoderCli({ PATH: "/nonexistent-directory", SA_WORKBENCH_QODER_CLI: "/bin/echo" }), "/bin/echo");
    const resolved = await resolveQoderCli({ PATH: dir, SA_WORKBENCH_QODER_CLI: broken });
    assert.notEqual(resolved, broken);
    assert.notEqual(resolved, join(dir, "qodercli"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
