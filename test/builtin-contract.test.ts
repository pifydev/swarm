import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { parseAgentFile } from "../src/frontmatter.ts";

test("C: builtins carry the compressed output contract and its floor, and still parse", () => {
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const def = parseAgentFile(name, content, "builtin")!;
    assert.ok(def, name);
    // The floor appears in every archetype, verbatim.
    assert.match(content, /keep every path, file:line, symbol, command, number and error string verbatim/, name);
  }
  assert.match(BUILTIN_AGENTS.scout!, /path:line — symbol — a note of six words or fewer/);
  assert.match(BUILTIN_AGENTS.scout!, /No match\./);
  assert.match(BUILTIN_AGENTS.reviewer!, /Lead with the verdict/);
  assert.match(BUILTIN_AGENTS.worker!, /what changed \(file:line\)/);
  // scout/reviewer stay read-only; worker stays full.
  assert.ok(!parseAgentFile("reviewer", BUILTIN_AGENTS.reviewer!, "builtin")!.tools.includes("edit"));
  assert.ok(parseAgentFile("worker", BUILTIN_AGENTS.worker!, "builtin")!.tools.includes("edit"));
});
