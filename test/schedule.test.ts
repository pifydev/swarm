import { test } from "node:test";
import assert from "node:assert/strict";
import { runGraph, type Schedulable } from "../src/schedule.ts";

interface Node extends Schedulable {
  task: string;
}
const n = (id: string, needs: string[] = []): Node => ({ id, needs, task: id });
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test("a chain runs strictly in dependency order", async () => {
  const order: string[] = [];
  await runGraph([n("c", ["b"]), n("b", ["a"]), n("a")], 4, async (node) => {
    order.push(node.id);
    await tick();
  });
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("independent nodes run concurrently; concurrency is capped", async () => {
  let inFlight = 0;
  let peak = 0;
  await runGraph([n("a"), n("b"), n("c"), n("d")], 2, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight--;
  });
  assert.equal(peak, 2, "never more than the cap at once");
});

test("a join receives every upstream, in needs order", async () => {
  const received: Record<string, string[]> = {};
  await runGraph(
    [n("a"), n("b"), { id: "join", needs: ["a", "b"], task: "join" }],
    4,
    async (node, upstream) => {
      received[node.id] = upstream.map((u) => u.id);
      await tick();
    },
  );
  assert.deepEqual(received["join"], ["a", "b"]);
  assert.deepEqual(received["a"], []);
});

test("a diamond joins only after both branches", async () => {
  const order: string[] = [];
  await runGraph(
    [n("a"), n("b", ["a"]), n("c", ["a"]), n("d", ["b", "c"])],
    4,
    async (node) => {
      order.push(node.id);
      await tick();
    },
  );
  assert.equal(order[0], "a");
  assert.equal(order[3], "d");
  assert.ok(order.indexOf("b") < order.indexOf("d") && order.indexOf("c") < order.indexOf("d"));
});

test("a failed node still unblocks its dependents", async () => {
  const ran: string[] = [];
  await runGraph([n("a"), n("b", ["a"])], 4, async (node) => {
    ran.push(node.id);
    if (node.id === "a") throw new Error("boom");
    await tick();
  });
  assert.deepEqual(ran, ["a", "b"], "b ran even though a failed");
});

test("cancelled() stops launching new nodes", async () => {
  const ran: string[] = [];
  let cancel = false;
  await runGraph(
    [n("a"), n("b", ["a"]), n("c", ["b"])],
    1,
    async (node) => {
      ran.push(node.id);
      if (node.id === "a") cancel = true; // cancel after the first finishes
      await tick();
    },
    () => cancel,
  );
  assert.deepEqual(ran, ["a"], "b and c never launched after cancel");
});
