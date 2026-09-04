import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentFile } from "../src/frontmatter.ts";
import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { globToRegex, pathTokens, routeItem } from "../src/routing.ts";
import { buildReport, buildStatusLine } from "../src/report.ts";
import { buildWidgetLines } from "../src/widget.ts";
import type { AgentDef, ItemState, SwarmRun, ThemeLike } from "../src/types.ts";

const theme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

function def(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    description: name,
    tools: ["read"],
    model: null,
    thinking: null,
    maxTurns: 30,
    systemPrompt: "x",
    source: "builtin",
    matchPatterns: [],
    matchKeywords: [],
    ...overrides,
  };
}

function defsMap(...list: AgentDef[]): Map<string, AgentDef> {
  return new Map(list.map((d) => [d.name, d]));
}

test("frontmatter parses routing keys in both spellings", () => {
  const a = parseAgentFile(
    "a",
    '---\ndescription: d\nmatch_patterns: *.rs, src/**\nmatch_keywords: Test, Login\n---\nb',
    "project",
  )!;
  assert.deepEqual(a.matchPatterns, ["*.rs", "src/**"]);
  assert.deepEqual(a.matchKeywords, ["test", "login"]);
  const b = parseAgentFile("b", "---\ndescription: d\nmatchPatterns: [*.ts]\n---\nb", "project")!;
  assert.deepEqual(b.matchPatterns, ["*.ts"]);
});

test("builtin agents parse without routing rules", () => {
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const parsed = parseAgentFile(name, content, "builtin");
    assert.ok(parsed, name);
    assert.deepEqual(parsed!.matchPatterns, []);
  }
});

test("globToRegex matches file tokens", () => {
  assert.ok(globToRegex("*.rs").test("auth.rs"));
  assert.ok(globToRegex("*.rs").test("src/auth.rs"));
  assert.ok(!globToRegex("*.rs").test("auth.ts"));
  assert.ok(globToRegex("src/**").test("src/deep/file.ts"));
  assert.ok(globToRegex("*.test.ts").test("a/b/x.test.ts"));
});

test("pathTokens extracts path-like tokens", () => {
  assert.deepEqual(pathTokens("review src/auth.rs carefully"), ["src/auth.rs"]);
  assert.deepEqual(pathTokens('check "lib/x.ts", then report'), ["lib/x.ts"]);
  assert.deepEqual(pathTokens("no paths here"), []);
  assert.deepEqual(pathTokens("file.py at end."), ["file.py"]);
});

test("routing: pattern beats keyword; longest pattern wins; fallback scout", () => {
  const rust = def("rust-audit", { matchPatterns: ["*.rs"] });
  const rustSpecific = def("rust-auth", { matchPatterns: ["src/auth*.rs"] });
  const tester = def("tester", { matchKeywords: ["test"] });
  const scout = def("scout");
  const defs = defsMap(rust, rustSpecific, tester, scout);

  assert.equal(routeItem("review src/auth.rs and test it", defs).name, "rust-auth");
  assert.equal(routeItem("review lib/main.rs", defs).name, "rust-audit");
  assert.equal(routeItem("test the login flow", defs).name, "tester");
  assert.equal(routeItem("write documentation", defs).name, "scout");
});

test("routing: fixed agent overrides everything; unknown fixed falls through", () => {
  const rust = def("rust-audit", { matchPatterns: ["*.rs"] });
  const scout = def("scout");
  const defs = defsMap(rust, scout);
  assert.equal(routeItem("review src/auth.rs", defs, "scout").name, "scout");
  assert.equal(routeItem("review src/auth.rs", defs, "missing").name, "rust-audit");
});

function item(overrides: Partial<ItemState>): ItemState {
  return {
    index: 0,
    item: "review x",
    agent: "scout",
    status: "done",
    turns: 2,
    tokens: 100,
    result: "looks fine",
    error: null,
    ...overrides,
  };
}

function run(items: ItemState[], status: SwarmRun["status"] = "done"): SwarmRun {
  return { runId: "s1", background: false, status, startedAt: 0, finishedAt: 1000, items };
}

test("buildReport aggregates counts and sections", () => {
  const report = buildReport(
    run([
      item({ index: 0, result: "ok A" }),
      item({ index: 1, status: "error", error: "boom", result: null }),
      item({ index: 2, status: "aborted", result: "partial" }),
    ]),
  );
  assert.ok(report.includes("3 items — 1 done, 1 error, 1 aborted"));
  assert.ok(report.includes("### 1. [scout] review x\nok A"));
  assert.ok(report.includes("Error: boom"));
  assert.ok(report.includes("Partial:\npartial"));
});

test("buildStatusLine shows per-item progress", () => {
  const line = buildStatusLine(run([item({ status: "running", turns: 3 })], "running"));
  assert.ok(line.includes("running"));
  assert.ok(line.includes("1:scout=running(3t)"));
});

test("widget renders items with icons; stale run hides", () => {
  const active = run([item({ status: "running" }), item({ index: 1, status: "queued" })], "running");
  const lines = buildWidgetLines(active, theme, 5_000);
  const text = lines.join("\n");
  assert.ok(text.includes("🐝 swarm s1"));
  assert.ok(text.includes("⟳ scout"));
  assert.ok(text.includes("· scout"));

  assert.deepEqual(buildWidgetLines(run([item({})]), theme, 100_000), []);
  assert.deepEqual(buildWidgetLines(null, theme, 0), []);
});
