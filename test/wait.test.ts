import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "../src/wait.ts";

test("waitUntil returns as soon as the condition holds", async () => {
  let ready = false;
  setTimeout(() => (ready = true), 20);
  const started = Date.now();
  assert.equal(await waitUntil(() => ready, 2000, 5), true);
  assert.ok(Date.now() - started < 1000, "did not sit out the whole budget");
});

test("waitUntil gives up at the deadline and says so", async () => {
  const started = Date.now();
  assert.equal(await waitUntil(() => false, 40, 5), false);
  assert.ok(Date.now() - started >= 35, "waited roughly the budget");
});

test("waitUntil answers immediately when there is nothing to wait for", async () => {
  assert.equal(await waitUntil(() => true, 5000, 250), true);
  assert.equal(await waitUntil(() => false, 0, 250), false);
});

test("waitUntil stops on the tool's abort signal", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 15);
  const started = Date.now();
  assert.equal(await waitUntil(() => false, 5000, 5, controller.signal), false);
  assert.ok(Date.now() - started < 1000, "an abort ends the wait, not the deadline");
  // Already aborted: no timer is ever armed.
  assert.equal(await waitUntil(() => false, 5000, 250, controller.signal), false);
});
