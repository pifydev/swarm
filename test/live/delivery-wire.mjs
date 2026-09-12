/**
 * Does a finished background swarm's aggregated report reach the model
 * unasked?
 *
 * The README claimed it did while this package had no live test at all —
 * the suite review's finding. The mechanism is the same sendMessage
 * follow-up subagent uses, and subagent's redesigned test proved both the
 * mechanism and the technique for measuring it under `pi -p`: print mode
 * tears the session down the moment the parent's prompt resolves, so the
 * probe holds the parent's last turn open until the run's entry lands on
 * the branch, standing in for an interactive session that is simply still
 * alive. The queued delivery then triggers the next turn, and THAT turn's
 * provider payload settles the claim.
 *
 *   node test/live/delivery-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

const home = mkdtempSync(join(tmpdir(), "pify-swarm-delivery-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-swarm-delivery-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    appendFileSync(process.env.DELIVERY_OUT, JSON.stringify({",
  '      delivered: text.includes("you started in the background"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  // Hold the parent's turn open until the swarm's run entry reports a
  // finished status, so print mode cannot tear the session down under it.
  "  let held = false;",
  '  pi.on("agent_end", async (_event, ctx) => {',
  "    if (held) return;",
  "    held = true;",
  "    const deadline = Date.now() + 180000;",
  "    for (;;) {",
  "      const finished = ctx.sessionManager.getBranch().some((e) => {",
  "        const entry = e || {};",
  '        return entry.customType === "swarm-run" && entry.data && entry.data.status && entry.data.status !== "running";',
  "      });",
  "      if (finished || Date.now() > deadline) {",
  '        appendFileSync(process.env.DELIVERY_OUT, JSON.stringify({ waited: true, finished }) + String.fromCharCode(10));',
  "        return;",
  "      }",
  "      await new Promise((r) => setTimeout(r, 1500));",
  "    }",
  "  });",
  "}",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "swarm.ts"),
      // Wrapped in literal double quotes: unquoted sentences reach pi one
      // prompt per word on Windows under shell:true (see
      // task/test/live/sweep-wire.mjs).
      "-p",
      '"Call swarm_run once with background=true, agent=scout and items=[\'reply with the single word ONE\', \'reply with the single word TWO\']. Then reply with the word STARTED and stop. Do not call swarm_status."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 420_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, DELIVERY_OUT: out },
    },
  );

  const lines = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const requests = lines.filter((l) => l.delivered !== undefined);
  const wait = lines.find((l) => l.waited);

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  const delivered = requests.filter((r) => r.delivered).length;
  console.log(
    `requests: ${requests.length}, carrying the delivered report: ${delivered}, run finished: ${wait ? wait.finished : "unknown"}`,
  );

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check("the background swarm actually finished while the session lived", wait !== undefined && wait.finished === true);
  check("the aggregated report reached the model unasked", delivered > 0, `${delivered} request(s)`);

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
