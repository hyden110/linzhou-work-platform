import assert from "node:assert/strict";
import test from "node:test";

import {
  GUIDES_MODEL_VERSION,
  guideOf,
  guides,
  provisionSchemas,
  stepOf,
} from "./guides-model.ts";

test("guides registry: dws + aitable-all + 8 single-table guides", () => {
  assert.equal(GUIDES_MODEL_VERSION, "2026-10-17");
  assert.equal(guides.length, 10);
  assert.deepEqual(
    guides.map((g) => g.id),
    [
      "dws", "aitable-all",
      "aitable-leads", "aitable-relations", "aitable-daily", "aitable-worklog",
      "aitable-custfiles", "aitable-dttask", "aitable-daily-report", "aitable-business",
    ],
  );
  assert.equal(guides.filter((g) => g.id === "dws")[0]?.kind, "base");
  for (const g of guides.slice(1)) assert.equal(g.kind, "aitable");
});

test("dws guide: bin check → terminal action → session verify → done", () => {
  const dws = guideOf("dws");
  assert.ok(dws);
  assert.deepEqual(dws.steps.map((s) => s.id), ["bin", "auth", "verify", "done"]);
  const bin = stepOf(dws, "bin");
  assert.deepEqual(bin?.check, { type: "bin", name: "dws" });
  const auth = stepOf(dws, "auth");
  assert.equal(auth?.kind, "action");
  assert.deepEqual(auth?.action, { type: "terminal", cmd: "dws auth login" });
  assert.equal(stepOf(dws, "verify")?.check?.type, "dwsSession");
  assert.equal(stepOf(dws, "verify")?.fix?.terminal, true);
  assert.equal(stepOf(dws, "done")?.kind, "done");
});

test("aitable-all provisions all 8 schemas and requires confirm", () => {
  const all = guideOf("aitable-all");
  assert.ok(all);
  assert.equal(all.schemas?.length, 8);
  const provision = stepOf(all, "provision");
  assert.equal(provision?.action?.type, "aitable-provision");
  assert.equal(provision?.needConfirm, true);
  assert.equal(provision?.action?.schemas?.length, 8);
  assert.ok(provision?.confirm?.includes("12 张数据表"));
  assert.equal(stepOf(all, "verify")?.check?.schemas?.length, 8);
});

test("single-table guides: dws → provision(1 schema, needConfirm) → verify → [cap] → done", () => {
  const withCap = guideOf("aitable-leads");
  assert.ok(withCap);
  assert.deepEqual(withCap.steps.map((s) => s.id), ["dws", "provision", "verify", "cap", "done"]);
  assert.equal(withCap.cap, "leads");
  assert.deepEqual(stepOf(withCap, "provision")?.action?.schemas, ["leads"]);
  assert.equal(stepOf(withCap, "provision")?.needConfirm, true);
  assert.equal(stepOf(withCap, "cap")?.check?.id, "leads");
  assert.ok(stepOf(withCap, "provision")?.confirm?.includes("tools/aitable_leads.json"));

  const noCap = guideOf("aitable-dttask");
  assert.ok(noCap);
  assert.deepEqual(noCap.steps.map((s) => s.id), ["dws", "provision", "verify", "done"]);
  assert.equal(noCap.cap, null);

  // dws 前置步在所有 aitable 指引里一致
  for (const g of guides.filter((x) => x.kind === "aitable")) {
    const dwsStep = stepOf(g, "dws");
    assert.equal(dwsStep?.check?.type, "dwsSession");
    assert.equal(dwsStep?.fix?.cmd, "dws auth login");
  }
});

test("provisionSchemas dedupes to the 8 dependency points", () => {
  assert.deepEqual(provisionSchemas(), [
    "leads", "relations", "daily", "worklog", "custfiles", "dttask", "daily_report", "business",
  ]);
});

test("unknown lookups return undefined", () => {
  assert.equal(guideOf("nope"), undefined);
  const dws = guideOf("dws");
  assert.ok(dws);
  assert.equal(stepOf(dws, "nope"), undefined);
});
