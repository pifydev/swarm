/**
 * @pify/swarm — coordinate multiple pi agents working in parallel.
 *
 * swarm_run fans a list of task items out to child agents (the same
 * in-process createAgentSession runner proven in @pify/subagent), with a
 * concurrency queue, per-item auto-routing via agent-def match_patterns /
 * match_keywords (gjczone's model), a live widget, and an aggregated
 * report. Blocking by default; background: true returns a runId polled
 * with swarm_status. Items are independent — no shared state, no nesting.
 *
 * Reads the SAME .pi/agents/*.md definitions as @pify/subagent (plus the
 * two routing keys), so one agent catalog serves both packages.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { withUiLock } from "../src/ui-lock.ts";
import { LoopGuard } from "../src/loop-guard.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  persistConsent,
  readConsent,
} from "../src/consent.ts";
import { LiveChildren, cancelNote, type CancelReason } from "../src/cancel.ts";
import { DELIVERY_TYPE, deliveryMessage, pendingResult } from "../src/pending.ts";
import { createIsolationWorktree, isolationNote, removeIfUnchanged } from "../src/isolate.ts";
import {
  MAILBOX_INBOX_TOOL,
  MAILBOX_POST_TOOL,
  MAILBOX_TOOL_NAMES,
  formatInbox,
  mailboxDir,
  mailboxKey,
  mailboxPrompt,
  postMessage,
  readInbox,
} from "../src/mailbox.ts";
import { parseAgentFile } from "../src/frontmatter.ts";
import { buildReport, buildStatusLine, earlyFailureNotice } from "../src/report.ts";
import {
  normalizeGate,
  runGate,
  sharedWith,
  type GateContract,
  type GateSibling,
  type GateVerdict,
} from "../src/gate.ts";
import { runGateCycle } from "../src/repair.ts";
import { repairAllowed } from "../src/repair-policy.ts";
import { deriveOutcome, parseDeclaredOutcome, stripDeclaration } from "../src/outcome.ts";
import { waitUntil } from "../src/wait.ts";
import { routeItem } from "../src/routing.ts";
import { normalizeItems } from "../src/graph.ts";
import { runGraph } from "../src/schedule.ts";
import { buildWidgetLines } from "../src/widget.ts";
import {
  DEFAULT_CONCURRENCY,
  MAX_ITEMS,
  isRecord,
  type AgentDef,
  type ItemState,
  type SwarmRun,
  type UpstreamFailurePolicy,
} from "../src/types.ts";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const RUN_ENTRY = "swarm-run";
/** Longest a swarm_status call may hold on to a running run, in seconds. */
const MAX_STATUS_WAIT_S = 120;
const CLEAN_WORKTREE_NOTE =
  "Ran isolated in a temporary worktree; it changed nothing, so the worktree was removed.";

type UiContext = ExtensionContext;

function loadDefs(cwd: string, agentDir: string, projectAllowed: boolean): Map<string, AgentDef> {
  const defs = new Map<string, AgentDef>();
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const def = parseAgentFile(name, content, "builtin");
    if (def) defs.set(def.name, def);
  }
  // The project directory is consent-gated: `.pi/agents/*.md` is repo-shipped
  // text that becomes a CHILD SYSTEM PROMPT, overriding builtins of the same
  // name, and pi never asks about it — measured, a repo whose only pi file is
  // `.pi/agents/reviewer.md` reports isProjectTrusted=true. One answer,
  // recorded under the same "agents" scope subagent uses, governs the catalog
  // across the whole suite.
  const sources: Array<readonly [string, "global" | "project"]> = [
    [join(agentDir, "agents"), "global"] as const,
    ...(projectAllowed ? [[join(cwd, ".pi", "agents"), "project"] as const] : []),
  ];
  for (const [dir, source] of sources) {
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        try {
          const def = parseAgentFile(basename(file, ".md"), readFileSync(join(dir, file), "utf8"), source);
          if (def) defs.set(def.name, def);
        } catch {
          // skip unreadable
        }
      }
    } catch {
      // dir missing
    }
  }
  return defs;
}

export default function swarm(pi: ExtensionAPI) {
  let defs = new Map<string, AgentDef>();
  const runs = new Map<string, SwarmRun>();
  /** Live child sessions per run, so a stop actually reaches the children. */
  const live = new LiveChildren();
  let activeRun: SwarmRun | null = null;
  let runCounter = 0;
  let lastUiCtx: UiContext | null = null;

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const run = activeRun;
    const now = Date.now();
    if (!run || (run.status !== "running" && (run.finishedAt ?? 0) < now - 15_000)) {
      ctx.ui.setWidget("swarm", undefined);
      return;
    }
    ctx.ui.setWidget(
      "swarm",
      (_tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
        new Text(buildWidgetLines(run, theme, Date.now()).join("\n"), 0, 0),
      { placement: "aboveEditor" },
    );
  }

  function notify(ctx: UiContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  // ── Child runner (subagent-proven pattern, one per item) ─────────────

  /**
   * Mailbox tools for one child. Each agent posts under its own label and
   * never sees its own posts echoed back; `seen` advances per agent so a
   * second swarm_inbox only reports what arrived since the first.
   */
  function mailboxTools(dir: string, label: string): ToolDefinition[] {
    let seen = 0;
    return [
      {
        name: MAILBOX_POST_TOOL,
        label: "Post to swarm",
        description:
          "Tell the other agents in this swarm something that changes their work: a shared file you " +
          "modified, a convention you had to choose, a blocker they will hit too. Not for progress " +
          "narration — only facts a sibling needs to avoid redoing or undoing your work.",
        parameters: Type.Object({
          message: Type.String({ description: "One fact the other agents need" }),
        }),
        async execute(_id: string, params: { message: string }) {
          const posted = postMessage(dir, label, params.message, Date.now());
          return {
            content: [{ type: "text", text: `Posted #${posted.seq} to the swarm.` }],
            details: { seq: posted.seq },
          };
        },
      },
      {
        name: MAILBOX_INBOX_TOOL,
        label: "Read swarm inbox",
        description:
          "Read what the other agents in this swarm have posted since you last checked. Call it " +
          "before you start working and again before you finish.",
        parameters: Type.Object({}),
        async execute() {
          const read = readInbox(dir, label, seen);
          seen = read.nextSeq;
          return {
            content: [{ type: "text", text: formatInbox(read) }],
            details: { count: read.messages.length },
          };
        },
      },
    ] as unknown as ToolDefinition[];
  }

  async function runItem(
    ctx: UiContext,
    runId: string,
    def: AgentDef,
    item: ItemState,
    context: string,
    workDir?: string,
    mailbox?: string,
  ): Promise<void> {
    // A stop can land before this item has a session to abort — the scheduler
    // launched it, the loader is still reloading — and cancelRun has already
    // written its record. Starting anyway would overwrite that with "running"
    // and leave a child no stop can reach.
    const cancelled = (): boolean => runs.get(runId)?.status === "cancelled";
    if (cancelled()) return;
    item.status = "running";
    renderWidget();
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let releaseLive: (() => void) | null = null;
    let stallReason: string | null = null;
    try {
      let model = ctx.model ?? null;
      if (def.model) {
        const [provider, ...rest] = def.model.split("/");
        const found =
          provider && rest.length > 0 ? ctx.modelRegistry.find(provider, rest.join("/")) : undefined;
        if (found) model = found;
      }
      if (!model) throw new Error("No model available");

      const promptHost = ctx as unknown as {
        getSystemPromptOptions?: () => { customPrompt?: string; appendSystemPrompt?: string };
      };
      const promptOptions = promptHost.getSystemPromptOptions?.() ?? {};

      // `reload()` is not optional. `createAgentSession` only loads a resource
      // loader it builds itself; one passed in is used exactly as handed over,
      // and a fresh DefaultResourceLoader resolves neither `systemPrompt` nor
      // `appendSystemPrompt` until it loads. Without it the child ran with no
      // instructions at all — the call succeeds, the model answers, and it
      // answers as a generic assistant with nothing to say it went wrong.
      const loader = new DefaultResourceLoader({
        cwd: workDir ?? ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: promptOptions.customPrompt,
        appendSystemPrompt: [
          ...(promptOptions.appendSystemPrompt ? [promptOptions.appendSystemPrompt] : []),
          def.systemPrompt,
          // The same contract subagent's children get, including the OUTCOME
          // line: the report tallies `blocked`, and skip-on-upstream-failure
          // keys off the outcome, so a child that is never told the protocol
          // can never be anything but succeeded or failed.
          "You are one agent in a swarm, handling exactly one item. Your final assistant message is the deliverable — " +
            "make it complete and self-contained; the swarm cannot reply to it. Close by stating each requirement of your " +
            "item and the concrete evidence it is met (the command you ran and what it showed); mark anything you could " +
            "not verify as unverified rather than done. Finishing your turn is not the same as finishing the item: if you " +
            "could not do it, end the report with a line reading exactly `OUTCOME: blocked` (a decision, access or " +
            "information you do not have) or `OUTCOME: failed` (you tried and it does not work), so the swarm does not " +
            "have to infer it from your prose. Say nothing if it went fine.",
          ...(mailbox ? [mailboxPrompt(item.agent + "-" + item.index)] : []),
        ],
      });
      await loader.reload();
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir ?? ctx.cwd),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        // `tools` is an allowlist and it filters customTools too, so a mailbox
        // tool that is not named here is registered and then dropped — the
        // child is told it has no such tool, and mailbox:true does nothing.
        // Admit them exactly as @pify/subagent admits ask_supervisor.
        tools: mailbox ? [...def.tools, ...MAILBOX_TOOL_NAMES] : def.tools,
        ...(mailbox ? { customTools: mailboxTools(mailbox, item.agent + "-" + item.index) } : {}),
        resourceLoader: loader,
      });
      session = created.session;
      // Same window, other side: a stop during session creation found nothing
      // registered. Do not prompt a child of a run that is already over.
      if (cancelled()) return;
      releaseLive = live.register(runId, session);

      const guard = new LoopGuard();
      unsubscribe = session.subscribe((event) => {
        const message = (
          event as {
            message?: {
              role?: string;
              usage?: { totalTokens?: number };
              content?: Array<{ type?: string; text?: string }>;
            };
          }
        ).message;
        if (event.type === "message_end" && message?.role === "assistant") {
          item.turns++;
          const usage = message.usage;
          if (usage && typeof usage.totalTokens === "number") item.tokens += usage.totalTokens;

          // Stop an item that is spinning — restating itself without acting —
          // rather than letting it run to the turn cap. See loop-guard.ts.
          if (!stallReason && Array.isArray(message.content)) {
            const usedTool = message.content.some((c) => c.type === "toolCall");
            const turnText = message.content
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
            const verdict = guard.observe({ text: turnText, usedTool });
            if (verdict.stalled) {
              stallReason = verdict.reason ?? "no progress";
              void session?.abort().catch(() => {});
            }
          }

          renderWidget();
          if (item.turns >= def.maxTurns) void session?.abort().catch(() => {});
        }
      });

      const prompt = context ? `${context.trim()}\n\nYour item: ${item.item}` : item.item;
      await session.prompt(prompt, { source: "extension" } as never);

      const messages = session.messages as Array<{
        role?: string;
        stopReason?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const text = (last?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();

      // An item the loop guard stopped gave up rather than concluded — mark it
      // so the aggregated report does not read it as a finished answer.
      item.result = stallReason
        ? `${text ? `${text}\n\n` : ""}[stopped: no progress — the agent ${stallReason}]`
        : text || null;
      item.status = stallReason
        ? "aborted"
        : last?.stopReason === "aborted"
          ? "aborted"
          : last?.stopReason === "error"
            ? "error"
            : "done";
      if (item.status === "error") item.error = text || "child session error";
      // A child that stopped cleanly and said nothing has not answered — the
      // fix subagent already carries and this executor never received. Left
      // as "done", a reasoning-only finish (measured on anthropic/claude-opus-5
      // through child sessions) rendered a successful fan-out of "(empty
      // report)" items. An exit status is not an answer.
      if (item.status === "done" && !item.result) {
        item.status = "error";
        item.error = "the child finished without producing an answer";
      }
    } catch (err) {
      item.status = "error";
      item.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (releaseLive) releaseLive();
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // gone
        }
      }
      if (session) {
        try {
          session.dispose();
        } catch {
          // fine
        }
      }
      renderWidget();
    }
  }

  /**
   * Settle the two facts the status alone cannot give: what the item's task came
   * to, and how well that is known. Settled once — re-running it after the
   * isolation note is appended would find the declaration already stripped and
   * quietly promote a blocked item to a successful one.
   */
  function settleItem(item: ItemState): void {
    if (item.status === "queued" || item.status === "running" || item.outcome) return;
    // A skipped item was never attempted, so it has no outcome to report — not
    // a failure of its own, and calling it one would double-count the upstream
    // failure that caused it.
    if (item.status === "skipped") return;
    const declared = parseDeclaredOutcome(item.result);
    if (declared && item.result) item.result = stripDeclaration(item.result);
    item.verification ??= "not-requested";
    item.outcome = deriveOutcome({
      status: item.status === "done" ? "done" : item.status === "aborted" ? "aborted" : "error",
      declared,
      verification: item.verification,
    });
  }

  /**
   * Run the caller's gate in the tree this item worked in and, if it failed,
   * send the child back to fix it. Recorded either way — a gate that passed is
   * a fact worth saying, and a gate that could not run says so rather than
   * blaming the work.
   */
  async function gateItem(
    ctx: UiContext,
    run: SwarmRun,
    item: ItemState,
    def: AgentDef,
    opts: RunOptions,
  ): Promise<void> {
    // A cancelled run has nothing left to prove; a gate is a test suite, and
    // spending one on work nobody is waiting for is the stop not stopping.
    if (!opts.gate || item.status !== "done" || run.status === "cancelled") return;
    const subject = item.workDir ?? ctx.cwd;
    // sharedWith() reads an undefined workDir as "the subject's directory", so
    // an item that ran in place — no worktree of its own — would count as
    // sharing every isolated sibling's worktree, and every isolated item's
    // pass came out attributed to the tree. Name the directory each item was
    // actually in.
    const dirOf = (i: ItemState): string => i.workDir ?? ctx.cwd;
    const self: GateSibling = { id: item.index, label: item.id, status: item.status, workDir: dirOf(item) };
    const siblings: GateSibling[] = run.items
      .filter((i) => i.index !== item.index)
      .map((i) => ({ id: i.index, label: i.id, status: i.status, workDir: dirOf(i) }));
    // Read the child's declaration now, while it is still in the result:
    // settleItem strips it, and a blocked child is not sent to fix a gate.
    const canRepair = repairAllowed(def, item.result);
    try {
      // The gate that actually ran, whatever the cycle reports. After a repair
      // the cycle re-runs the gate; on a cancelled run that is up to the whole
      // deadline spent proving nothing anyone will read — but a check that
      // DID run and failed before the stop landed is a real verdict, and
      // answering no_attestation for it would file a failed gate as
      // "proved nothing", which is the case the outcome model exists to stop.
      let last: (GateVerdict & { output: string }) | null = null;
      let repaired = false;
      const { record, verification } = await runGateCycle(item.item, opts.gate, subject, {
        runGate: async (contract, cwd) => {
          if (run.status === "cancelled" && last) return last;
          last = await runGate(contract, cwd);
          return last;
        },
        canRepair,
        maxAttempts: opts.gateRepairs ?? 1,
        sharedWith: sharedWith(self, subject, siblings),
        repair: async (prompt) => {
          if (run.status === "cancelled") return;
          repaired = true;
          // The brief IS the item. Handed over as `context` it arrived as "fix
          // exactly this" followed by the whole original task under `Your
          // item:`, which reads as an invitation to do the task again. The
          // brief already quotes the task; nothing else is sent.
          //
          // The repair is the same child type over the same tree, in the same
          // mailbox — the siblings' facts still apply — and its report
          // replaces the stale one, which described a tree that has changed.
          const fix: ItemState = { ...item, item: prompt, result: null, error: null, status: "queued", turns: 0, tokens: 0 };
          // The widget draws `item`, not `fix`; without this the row sat as a
          // finished ✓ for the whole repair.
          item.status = "running";
          renderWidget();
          await runItem(ctx, run.runId, def, fix, "", item.workDir, opts.mailbox);
          item.turns += fix.turns;
          item.tokens += fix.tokens;
          // cancelRun may have marked the item aborted meanwhile; that verdict
          // and its note stand, and the stale result is not swapped under it.
          if (item.status !== "running") return;
          item.status = "done";
          if (fix.status === "done" && fix.result?.trim()) item.result = fix.result;
        },
      });
      // The cycle counts a repair pass it asked for; one the stop refused is
      // not a repair, and the record must not say the tree was fixed.
      item.gate = repaired ? record : { ...record, repairs: undefined };
      item.verification = verification;
    } catch (err) {
      // A gate that throws proved nothing; say so rather than losing the
      // child's work to an error in the checking machinery.
      item.gate = {
        command: opts.gate.command,
        outcome: "no_attestation",
        ok: false,
        reason: `gate could not be run: ${err instanceof Error ? err.message : String(err)}`,
      };
      item.verification = "inconclusive";
    }
  }

  interface RunOptions {
    context: string;
    fixed?: string;
    isolate?: boolean;
    useMailbox?: boolean;
    gate?: GateContract;
    gateRepairs?: number;
    /** The run's mailbox dir once executeRun has made one, so a repair child joins the same log. */
    mailbox?: string;
    onUpstreamFailure?: UpstreamFailurePolicy;
    /** Called once, for the first item that settles badly while others run. */
    onEarlyFailure?: (item: ItemState) => void;
  }

  async function executeRun(ctx: UiContext, run: SwarmRun, opts: RunOptions): Promise<void> {
    const { context, fixed, isolate, useMailbox } = opts;
    // One shared log per run; only created when the caller asked for it. Keyed
    // on a per-run token (not the reused "s1" run id), so one run never reads a
    // previous run's stale messages, and removed at the end so it never leaks.
    const mailbox = useMailbox
      ? mailboxDir(getAgentDir(), mailboxKey(run.runId, run.startedAt))
      : undefined;
    const gateOpts: RunOptions = { ...opts, mailbox };

    // A dependent structurally receives each upstream's output — the thing a
    // hand-sequenced coordinator forgets. Prepended to the shared preamble.
    const contextFor = (upstream: ItemState[]): string => {
      if (upstream.length === 0) return context;
      const blocks = upstream.map((up) => {
        const body = up.result ?? (up.error ? `(failed: ${up.error})` : "(no output)");
        return `## Output of ${up.id}\n${body}`;
      });
      return [context, ...blocks].filter((s) => s && s.trim()).join("\n\n");
    };

    // The first hard failure wakes the caller once, and only while there is
    // still a run to warn it about; after that the aggregate report is the
    // report. N interrupts for N failures would be worse than none.
    let warned = false;
    const settle = (item: ItemState): void => {
      settleItem(item);
      if (warned || !opts.onEarlyFailure) return;
      if (item.outcome !== "failed" || item.status === "aborted") return;
      warned = true;
      opts.onEarlyFailure(item);
    };

    // Run each item once its needs finish, up to the concurrency cap; a flat
    // run (no needs) has everything ready at once, exactly like the old pool.
    try {
      await runGraph(
        run.items,
        DEFAULT_CONCURRENCY,
        async (item, upstream) => {
          // A failed node still counts as done so the graph drains rather than
          // wedging — but "unblocked" and "worth running" are different
          // questions. With skip, a dependent of work that did not succeed is
          // settled without spending a child on input that is a failure notice.
          const broken = upstream.filter((up) => up.status !== "done" || up.outcome !== "succeeded");
          if (opts.onUpstreamFailure === "skip" && broken.length > 0) {
            item.status = "skipped";
            item.error = `${broken.map((u) => u.id).join(", ")} did not succeed`;
            settleItem(item);
            renderWidget();
            return;
          }
          const def = routeItem(item.item, defs, fixed);
          item.agent = def.name;
          const itemContext = contextFor(upstream);
          if (isolate) {
            try {
              const iso = createIsolationWorktree(ctx.cwd, run.runId + "-i" + (item.index + 1));
              item.workDir = iso.path;
              await runItem(ctx, run.runId, def, item, itemContext, iso.path, mailbox);
              await gateItem(ctx, run, item, def, gateOpts);
              // Remove the worktree when the item changed nothing (the leak
              // removeIfUnchanged fixes); keep it when there is work to merge.
              const removed = removeIfUnchanged(ctx.cwd, iso);
              if (item.result !== null) {
                item.result = `${item.result}\n\n${removed ? CLEAN_WORKTREE_NOTE : isolationNote(iso)}`;
              }
            } catch (err) {
              item.status = "error";
              item.error = err instanceof Error ? err.message : String(err);
            }
          } else {
            await runItem(ctx, run.runId, def, item, itemContext, undefined, mailbox);
            await gateItem(ctx, run, item, def, gateOpts);
          }
          settle(item);
        },
        () => run.status === "cancelled",
      );
    } finally {
      // The mailbox is per-run scratch: reclaim it however the run ends
      // (finished, cancelled, or thrown) so a directory never accumulates.
      if (mailbox) {
        try {
          rmSync(mailbox, { recursive: true, force: true });
        } catch {
          // best-effort: an unremovable scratch dir is not worth failing a run
        }
      }
    }

    if (run.status !== "cancelled") run.status = "done";
    // A cancelled run's items were marked aborted without going through the
    // scheduler's settle path; the report still has to be able to name what
    // each one came to.
    for (const item of run.items) settleItem(item);
    run.finishedAt = Date.now();
    pi.appendEntry(RUN_ENTRY, run);
    renderWidget();
  }

  /**
   * Stop a run and every child it started. Both meanings of "stop" — the
   * user's abort and session teardown — come through here.
   */
  function cancelRun(run: SwarmRun, reason: CancelReason): void {
    const stopped = live.abortRun(run.runId);
    if (run.status === "running") {
      run.status = "cancelled";
      run.finishedAt = Date.now();
    }
    for (const item of run.items) {
      if (item.status === "running" || item.status === "queued") {
        item.status = "aborted";
        item.error = cancelNote(reason, stopped);
      }
    }
    renderWidget();
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "swarm_run",
    label: "Run swarm",
    promptSnippet: "Run many independent items through child agents at once",
    description:
      `Fan out 1-${MAX_ITEMS} independent task items to parallel child agents (concurrency ${DEFAULT_CONCURRENCY}). ` +
      "Each item auto-routes to an agent type via its match_patterns/match_keywords, falling back to the " +
      "read-only scout; set agent to force one type for all items. context is prepended to every item. " +
      "Blocking by default (returns the aggregated report); background=true returns a runId for swarm_status. " +
      "Write each item as a self-contained brief — children see nothing else. For MUTATING items set " +
      "isolation=worktree: each item gets its own git worktree and branch; reports say how to merge. " +
      "mailbox=true adds swarm_post/swarm_inbox so agents can warn each other about shared files and " +
      "conventions instead of silently conflicting. " +
      "An item can be a plain string (independent) OR an object {task, id, needs:[ids]} to declare a " +
      "dependency: a needed item's output is prepended to the dependent automatically, and the dependent " +
      "starts only once its needs finish. A cycle, a self-edge, or an unknown id is rejected before anything runs. " +
      "gate is a command every item must pass — it runs in that item's own working directory when it finishes, " +
      "a failure sends the child back to fix it once, and the report says what the check proved rather than " +
      "only what the child claims. on_upstream_failure=skip settles a dependent without spending a child when " +
      "something it needed did not succeed.",
    parameters: Type.Object({
      items: Type.Array(
        Type.Union([
          Type.String({ description: "A self-contained task brief (independent item)" }),
          Type.Object({
            task: Type.String({ description: "A self-contained task brief" }),
            id: Type.Optional(Type.String({ description: "Stable id other items can reference in needs (default t1, t2, …)" })),
            needs: Type.Optional(
              Type.Array(Type.String(), { description: "Ids of items that must finish first; their output is prepended to this item" }),
            ),
          }),
        ]),
        { minItems: 1, maxItems: MAX_ITEMS },
      ),
      context: Type.Optional(Type.String({ description: "Shared preamble for every item" })),
      agent: Type.Optional(Type.String({ description: "Force one agent type for all items" })),
      isolation: Type.Optional(Type.String({ description: "Set to worktree to give each item its own git worktree (for mutating items)" })),
      mailbox: Type.Optional(
        Type.Boolean({ description: "Give the agents swarm_post/swarm_inbox to share facts mid-run" }),
      ),
      gate: Type.Optional(
        Type.String({
          description:
            "Shell command every item must pass, e.g. \"bun test\". Run in that item's working directory once it finishes.",
        }),
      ),
      gateExpect: Type.Optional(
        Type.String({
          description:
            "Regex the gate output must match. Use it when exit 0 does not prove the check ran; exiting 0 without a match is reported as verifying nothing.",
        }),
      ),
      gateRepairs: Type.Optional(
        Type.Number({ description: "Repair passes per item after a failed gate, 0-5 (default 1)" }),
      ),
      on_upstream_failure: Type.Optional(
        StringEnum(["continue", "skip"], {
          description:
            "What a dependent does when something it needs did not succeed: continue (default, it runs and is told) or skip (it is settled without spending a child)",
        }),
      ),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id,
      params: {
        items: Array<string | { task: string; id?: string; needs?: string[] }>;
        context?: string;
        agent?: string;
        background?: boolean;
        isolation?: string;
        mailbox?: boolean;
        gate?: string;
        gateExpect?: string;
        gateRepairs?: number;
        on_upstream_failure?: UpstreamFailurePolicy;
      },
      signal,
      _onUpdate,
      ctx,
    ) {
      const uiCtx = ctx as UiContext;
      // Normalize strings/objects into graph nodes and reject a bad graph
      // (cycle, self-edge, unknown or duplicate id) BEFORE spawning anything.
      const { nodes, error } = normalizeItems(params.items ?? []);
      if (error) throw new Error(`swarm_run: ${error}`);
      if (nodes.length === 0) throw new Error("swarm_run requires at least one non-empty item.");
      if (params.agent && !defs.has(params.agent.toLowerCase())) {
        throw new Error(`Unknown agent type "${params.agent}". Available: ${[...defs.keys()].sort().join(", ")}`);
      }
      if (activeRun?.status === "running") {
        throw new Error(`Swarm ${activeRun.runId} is still running — wait or check swarm_status.`);
      }

      // A gate is validated up front: a broken contract should be a tool error
      // the caller can fix now, not a "verified nothing" verdict on every item
      // after a whole fan-out has already been spent.
      let gate: GateContract | undefined;
      if (params.gate?.trim()) {
        gate = normalizeGate(params.gate.trim());
        const expect = params.gateExpect?.trim();
        if (expect) {
          try {
            new RegExp(expect, "m");
          } catch {
            throw new Error(`gateExpect is not a valid regular expression: ${expect}`);
          }
          gate.expect = expect;
        }
      } else if (params.gateExpect?.trim()) {
        throw new Error("gateExpect needs a gate command to judge.");
      }

      runCounter++;
      const run: SwarmRun = {
        runId: `s${runCounter}`,
        background: params.background === true,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        items: nodes.map((node, index) => ({
          index,
          id: node.id,
          item: node.task,
          needs: node.needs,
          agent: params.agent?.toLowerCase() ?? "?",
          status: "queued",
          turns: 0,
          tokens: 0,
          result: null,
          error: null,
        })),
      };
      runs.set(run.runId, run);
      activeRun = run;
      renderWidget(uiCtx);

      // Esc must reach the children. A background run outlives this tool call
      // by design, so its signal is not its cancel button.
      let stopListening: (() => void) | null = null;
      if (signal && !run.background) {
        const onAbort = () => cancelRun(run, "user-abort");
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          stopListening = () => signal.removeEventListener("abort", onAbort);
        }
      }

      const options: RunOptions = {
        context: params.context ?? "",
        fixed: params.agent,
        isolate: params.isolation === "worktree",
        useMailbox: params.mailbox === true,
        gate,
        gateRepairs: params.gateRepairs,
        onUpstreamFailure: params.on_upstream_failure,
      };

      if (run.background) {
        // A background run's caller is off doing something else, so the first
        // hard failure interrupts it the way @pify/subagent already interrupts
        // for a failed background child. A foreground run is already blocking
        // that turn, so there is nothing to interrupt.
        options.onEarlyFailure = (item) => {
          try {
            pi.sendMessage(
              {
                customType: DELIVERY_TYPE,
                content: earlyFailureNotice(run, item),
                display: true,
                details: { runId: run.runId, item: item.id, status: item.status },
              },
              { deliverAs: "steer", triggerTurn: true },
            );
          } catch {
            // A warning that cannot be delivered must not take the run with it;
            // the aggregate report is still coming.
          }
        };
        void executeRun(uiCtx, run, options)
          .then(() => {
            // A run the user just stopped is not one that "finished", and the
            // model is not woken to fold in a report of work that was
            // cancelled out from under it. The stop already said what it
            // stopped; what the items produced is in swarm_status.
            if (run.status === "cancelled") return;
            notify(uiCtx, `swarm ${run.runId} finished`, "info");
            // The report goes to the agent, not only to the screen — otherwise
            // asking again was its only way to find out.
            pi.sendMessage(
              {
                customType: DELIVERY_TYPE,
                content: deliveryMessage(run.runId, "swarm", buildReport(run)),
                display: true,
                details: { runId: run.runId, status: run.status, items: run.items.length },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          })
          .catch(() => {
            // The whole chain, not just sendMessage: a /reload or session
            // switch while the run is in flight makes every captured pi/ctx
            // handle throw "ctx is stale" on next use, and an uncaught
            // rejection here takes the entire process down with it — the run's
            // work lost to a notification. Delivery is a convenience;
            // swarm_status still works.
          });
        return {
          content: [
            {
              type: "text",
              text:
                `Swarm ${run.runId} started (${run.items.length} items) in the background. Its report is delivered to you ` +
                `when it finishes, and the first hard failure interrupts you early — do not poll. ` +
                `swarm_status runId="${run.runId}" shows progress if you need it early. ` +
                `The user can stop it with /swarm stop ${run.runId} (Esc does not reach a background run).`,
            },
          ],
          details: { runId: run.runId },
        };
      }

      try {
        await executeRun(uiCtx, run, options);
      } finally {
        if (stopListening) stopListening();
      }
      return {
        content: [{ type: "text", text: buildReport(run) }],
        details: { runId: run.runId },
      };
    },
  });

  pi.registerTool({
    name: "swarm_status",
    label: "Swarm status",
    promptSnippet: "Progress of a running swarm",
    description:
      "Progress of a swarm run (default: the latest). Returns the full report when finished. " +
      "wait=N (seconds, up to 120) holds this call until the run finishes or N seconds pass, so a headless " +
      "session can collect the report in one call instead of asking repeatedly.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String()),
      wait: Type.Optional(
        Type.Number({
          description: "Seconds to wait for the run to finish before answering, 0-120 (default 0)",
          minimum: 0,
          maximum: MAX_STATUS_WAIT_S,
        }),
      ),
    }),
    async execute(_id, params: { runId?: string; wait?: number }, signal, _onUpdate, ctx) {
      const run = params.runId ? runs.get(params.runId.trim()) : activeRun ?? [...runs.values()].pop();
      if (!run) throw new Error("No swarm runs this session.");
      // Bounded and abortable: the wait is the caller's turn, and Esc must end
      // it the way it ends anything else the tool call is doing.
      const waitMs = Math.max(0, Math.min(MAX_STATUS_WAIT_S, params.wait ?? 0)) * 1000;
      if (run.status === "running" && waitMs > 0) {
        await waitUntil(() => run.status !== "running", waitMs, 250, signal);
      }
      if (run.status === "running") {
        const interactive = (ctx as { hasUI?: boolean }).hasUI !== false;
        const pending = pendingResult({
          id: run.runId,
          kind: "running",
          startedAt: run.startedAt,
          now: Date.now(),
          collectWith: "swarm_status",
          // A headless `pi -p` run ends with this turn: "it will be delivered"
          // is a promise nothing can keep there, so the text says to collect.
          interactive,
        });
        // Headless is where repeated calls actually happen; one call that
        // waits is the same answer for one turn instead of several.
        const text = interactive
          ? pending.text
          : `${pending.text}\nPass wait=${MAX_STATUS_WAIT_S} (seconds) to swarm_status to hold one call until it finishes instead of asking again.`;
        return { content: [{ type: "text", text }], details: pending.details as never };
      }
      const text =
        run.status === "cancelled"
          ? "This run was cancelled before it finished. Below is what the items that did complete produced.\n" +
            buildReport(run)
          : run.status === "done"
            ? buildReport(run)
            : buildStatusLine(run);
      return { content: [{ type: "text", text }], details: { runId: run.runId, status: run.status } };
    },
  });

  // ── Lifecycle & command ──────────────────────────────────────────────

  /** Where the suite records which projects you approved, and for what. */
  function consentFile(): string {
    return join(getAgentDir(), "pify-project-consent.json");
  }

  /**
   * May this repository's own agent definitions load? Same question, same
   * store, and the same "agents" scope subagent records — one answer governs
   * the catalog across subagent, swarm and workflow, so approving or refusing
   * once means the same thing everywhere.
   */
  async function projectAgentsAllowed(ctx: ExtensionContext): Promise<boolean> {
    const dir = join(ctx.cwd, ".pi", "agents");
    if (!existsSync(dir)) return false;
    const file = consentFile();
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    const store = parseConsent(raw);
    const verdict = decideConsent({
      projectTrusted: (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false,
      remembered: readConsent(store, ctx.cwd, "agents"),
      hasUI: ctx.hasUI,
      envOverride: envConsent(process.env),
    });
    if (verdict !== "ask") return verdict === "allow";

    const approved = await withUiLock(() =>
      ctx.ui.confirm(
        "Load this project's agent definitions?",
        consentQuestion("its own agent definitions, which override the builtins of the same name", dir),
      ),
    );
    try {
      persistConsent(file, ctx.cwd, "agents", approved);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
  }

  pi.on("session_start", async (_event, ctx) => {
    defs = loadDefs(ctx.cwd, getAgentDir(), await projectAgentsAllowed(ctx));
    runs.clear();
    activeRun = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type !== "custom" || e.customType !== RUN_ENTRY || !isRecord(e.data)) continue;
      const run = e.data as unknown as SwarmRun;
      if (typeof run.runId === "string" && run.status !== "running") {
        runs.set(run.runId, run);
        const n = Number.parseInt(run.runId.slice(1), 10);
        if (Number.isFinite(n) && n > runCounter) runCounter = n;
      }
    }
    renderWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // A run cannot outlive the session that owns it.
    for (const run of runs.values()) {
      if (run.status === "running") cancelRun(run, "session-switch");
    }
    if (ctx.hasUI) ctx.ui.setWidget("swarm", undefined);
  });

  pi.registerCommand("swarm", {
    description: "Show swarm runs and agent types; /swarm stop [runId] cancels a live run",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (words[0] === "stop") {
        // Esc reaches a foreground run through its tool call's signal; a
        // background run's tool call returned long ago, so until this command
        // nothing the user could do reached its children.
        const wanted = words[1];
        const run = wanted ? runs.get(wanted) : activeRun;
        if (!run) {
          ctx.ui.notify(wanted ? `No swarm run ${wanted}.` : "No swarm run to stop.", "warning");
          return;
        }
        if (run.status !== "running") {
          ctx.ui.notify(`swarm ${run.runId} is not running (${run.status}).`, "warning");
          return;
        }
        const before = live.count(run.runId);
        cancelRun(run, "user-abort");
        ctx.ui.notify(
          `swarm ${run.runId} stopped — ${before === 0 ? "no child agents were running" : `${before} child agent${before === 1 ? "" : "s"} stopped`}.`,
          "info",
        );
        renderWidget(ctx);
        return;
      }
      const routed = [...defs.values()]
        .map((d) => {
          const rules = [
            ...d.matchPatterns.map((p) => `glob:${p}`),
            ...d.matchKeywords.map((k) => `kw:${k}`),
          ].join(", ");
          return `${d.name} (${d.source})${rules ? ` [${rules}]` : ""}`;
        })
        .join("\n");
      const runLines =
        [...runs.values()].map((r) => buildStatusLine(r)).join("\n") || "(no runs yet)";
      ctx.ui.notify(`Agent types\n${routed}\n\nRuns\n${runLines}`, "info");
    },
  });
}
