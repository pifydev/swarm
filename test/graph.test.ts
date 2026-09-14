import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItems, validateGraph, hasEdges, type GraphNode } from "../src/graph.ts";

test("flat string items get stable ids, no needs, and validate", () => {
  const { nodes, error } = normalizeItems(["do a", "do b"]);
  assert.equal(error, null);
  assert.deepEqual(nodes, [
    { id: "t1", task: "do a", needs: [] },
    { id: "t2", task: "do b", needs: [] },
  ]);
  assert.equal(hasEdges(nodes), false);
});

test("object items keep their id and needs; hasEdges detects a graph", () => {
  const { nodes, error } = normalizeItems([
    { id: "mig", task: "write migration" },
    { id: "callers", task: "update callers", needs: ["mig"] },
  ]);
  assert.equal(error, null);
  assert.equal(nodes[1]!.needs[0], "mig");
  assert.equal(hasEdges(nodes), true);
});

test("mixed string + object items are both accepted", () => {
  const { nodes, error } = normalizeItems(["standalone", { task: "dependent", needs: ["t1"] }]);
  assert.equal(error, null);
  assert.equal(nodes[0]!.id, "t1");
  assert.equal(nodes[1]!.needs[0], "t1");
});

test("empty task text is rejected", () => {
  assert.match(normalizeItems([{ task: "  " }]).error ?? "", /no task text/);
  assert.match(normalizeItems(["ok", ""]).error ?? "", /item 2 has no task text/);
});

test("a self-edge, unknown ref, duplicate id and cycle are all rejected", () => {
  const self: GraphNode[] = [{ id: "a", task: "x", needs: ["a"] }];
  assert.match(validateGraph(self) ?? "", /cannot depend on itself/);

  const unknown: GraphNode[] = [{ id: "a", task: "x", needs: ["ghost"] }];
  assert.match(validateGraph(unknown) ?? "", /unknown item "ghost"/);

  const dup: GraphNode[] = [
    { id: "a", task: "x", needs: [] },
    { id: "a", task: "y", needs: [] },
  ];
  assert.match(validateGraph(dup) ?? "", /duplicate item id "a"/);

  const cycle: GraphNode[] = [
    { id: "a", task: "x", needs: ["b"] },
    { id: "b", task: "y", needs: ["a"] },
  ];
  assert.match(validateGraph(cycle) ?? "", /cycle involving/);
});

test("a valid diamond dependency passes", () => {
  const diamond: GraphNode[] = [
    { id: "a", task: "root", needs: [] },
    { id: "b", task: "left", needs: ["a"] },
    { id: "c", task: "right", needs: ["a"] },
    { id: "d", task: "join", needs: ["b", "c"] },
  ];
  assert.equal(validateGraph(diamond), null);
});
