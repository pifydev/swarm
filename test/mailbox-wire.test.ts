/**
 * Regression: mailbox=true must actually reach the child, and each run's
 * mailbox directory must be its own and be reclaimed.
 *
 * Two bugs are pinned here:
 *
 *  1. The child session's `tools` is an allowlist that filters customTools
 *     too, so swarm_post/swarm_inbox were registered on the child and then
 *     silently dropped — mailbox:true was dead. This drives the real runItem
 *     path with createAgentSession stubbed and asserts on the exact `tools`
 *     and `customTools` handed to the child. Before the fix the mailbox tools
 *     were absent from `tools`; the assertion below fails on that tree.
 *
 *     A live parent-side probe cannot prove this: the child session runs with
 *     a noExtensions loader, so its provider requests never pass through a
 *     parent extension's before_provider_request hook (the same limitation the
 *     subagent ask-wire test documents). Capturing the child's tool list at
 *     the createAgentSession boundary is the reliable proof.
 *
 *  2. The mailbox dir was keyed on the reused run id ("s1" every session), so
 *     runs shared a directory and it was never removed. This asserts the
 *     directory is gone once the run ends.
 *
 * Uses bun's module mock (this suite runs under `bun test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailboxDir, mailboxKey } from "../src/mailbox.ts";
// bun provides "bun:test" at runtime (this suite runs under `bun test`); its
// types are declared ambiently in test/bun-test.d.ts.
import { mock } from "bun:test";

type PostResult = { content: Array<{ text?: string }> };

type Captured = { tools: string[]; customTools: Array<{ name: string }> | undefined };

/** Build a fake pi + ctx and drive one blocking swarm_run item. */
async function driveRun(opts: {
  agentDir: string;
  repoDir: string;
  mailbox: boolean;
  callId: string;
}): Promise<{ captured: Captured[]; postResult: PostResult | null }> {
  const captured: Captured[] = [];
  let postResult: PostResult | null = null;

  await mock.module("@earendil-works/pi-coding-agent", () => ({
    getAgentDir: () => opts.agentDir,
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(_o: unknown) {}
      async reload() {}
    },
    async createAgentSession(arg: {
      tools: string[];
      customTools?: Array<{ name: string; execute: (id: string, p: unknown) => Promise<unknown> }>;
    }) {
      captured.push({ tools: arg.tools, customTools: arg.customTools });
      const post = (arg.customTools ?? []).find((t) => t.name === "swarm_post");
      return {
        session: {
          subscribe: () => () => {},
          async prompt() {
            // A child that actually has the tool can post; this also creates
            // the on-disk mailbox dir so its later removal is observable.
            if (post) postResult = (await post.execute("t", { message: "shared fact" })) as PostResult;
          },
          messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
          dispose() {},
          async abort() {},
        },
      };
    },
  }));

  const mod = await import("../extensions/swarm.ts");
  const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
  const tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {};
  const pi = {
    registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
      tools[t.name] = t;
    },
    registerCommand: () => {},
    on: (event: string, cb: (e: unknown, c: unknown) => unknown) => {
      handlers[event] = cb;
    },
    getThinkingLevel: () => "off",
    appendEntry: () => {},
    sendMessage: () => {},
  };
  (mod.default as unknown as (p: typeof pi) => void)(pi);

  const ctx = {
    cwd: opts.repoDir,
    hasUI: false,
    model: { id: "fake" },
    modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [] },
  };
  await handlers.session_start!({}, ctx);

  await tools.swarm_run!.execute(
    opts.callId,
    { items: ["summarize the plan"], mailbox: opts.mailbox },
    undefined,
    undefined,
    ctx,
  );

  return { captured, postResult };
}

test("wire: mailbox=true admits swarm_post/swarm_inbox onto the child, and removes the run dir", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pify-swarm-agentdir-"));
  const repoDir = mkdtempSync(join(tmpdir(), "pify-swarm-repo-"));
  try {
    const { captured, postResult } = await driveRun({
      agentDir,
      repoDir,
      mailbox: true,
      callId: "c1",
    });

    assert.equal(captured.length, 1, "one child was created");
    const child = captured[0]!;

    // Bug 1: both mailbox tools are in the child's tool allowlist...
    assert.ok(child.tools.includes("swarm_post"), `tools missing swarm_post: ${child.tools.join(",")}`);
    assert.ok(child.tools.includes("swarm_inbox"), `tools missing swarm_inbox: ${child.tools.join(",")}`);
    // ...and the agent's own tools are still there (allowlist widened, not replaced).
    assert.ok(child.tools.includes("read"), "the agent's own tools survived");
    // ...and they are actually registered as custom tools.
    assert.deepEqual(
      (child.customTools ?? []).map((t) => t.name).sort(),
      ["swarm_inbox", "swarm_post"],
    );

    // The child could actually use the tool it was given.
    const postText = postResult ? String(postResult.content[0]?.text ?? "") : "";
    assert.ok(postText.includes("Posted #1"), `child did not post via swarm_post: ${postText}`);

    // Bug 2: the per-run mailbox directory is reclaimed once the run ends.
    const box = join(agentDir, "swarm-mailbox");
    const leftover = existsSync(box) ? readdirSync(box) : [];
    assert.deepEqual(leftover, [], `mailbox dir leaked: ${leftover.join(",")}`);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("wire: mailbox=false leaves the child with only its own tools", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pify-swarm-agentdir2-"));
  const repoDir = mkdtempSync(join(tmpdir(), "pify-swarm-repo2-"));
  try {
    const { captured } = await driveRun({ agentDir, repoDir, mailbox: false, callId: "c2" });
    assert.equal(captured.length, 1);
    const child = captured[0]!;
    assert.ok(!child.tools.includes("swarm_post"), "no mailbox tool leaks in without mailbox");
    assert.ok(!child.tools.includes("swarm_inbox"));
    assert.equal(child.customTools, undefined, "no custom tools when mailbox is off");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("two runs never share a mailbox dir (reused run id, distinct runs)", () => {
  const agentDir = "/tmp/agent";
  // Same reused run id "s1" from two different sessions (distinct start times):
  // before the fix both keyed the dir on "s1" and collided.
  const a = mailboxDir(agentDir, mailboxKey("s1", 1_700_000_000_000));
  const b = mailboxDir(agentDir, mailboxKey("s1", 1_700_000_000_001));
  assert.notEqual(a, b, "two 's1' runs from different sessions must not share a dir");

  // Two runs in one session differ by run id too.
  const c = mailboxDir(agentDir, mailboxKey("s1", 1_700_000_000_000));
  const d = mailboxDir(agentDir, mailboxKey("s2", 1_700_000_000_000));
  assert.notEqual(c, d, "s1 and s2 must not share a dir");

  // The key stays a single sanitized path segment and is deterministic.
  assert.equal(mailboxKey("s1", 1000), mailboxKey("s1", 1000));
  assert.ok(!mailboxDir(agentDir, mailboxKey("s1", 1000)).includes(".."));
});
