import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConsent, persistConsent, readConsent, writeConsent } from "../src/consent.ts";

test("persistConsent re-reads before writing, so a concurrent writer's scope is not lost", () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-consent-"));
  const file = join(dir, "pify-project-consent.json");
  try {
    persistConsent(file, "/repo", "agents", true);
    persistConsent(file, "/repo", "memory", true);
    const store = parseConsent(readFileSync(file, "utf8"));
    assert.equal(readConsent(store, "/repo", "agents"), true);
    assert.equal(readConsent(store, "/repo", "memory"), true);

    // An external change between a caller's early read and its write is merged in.
    writeFileSync(file, JSON.stringify(writeConsent({}, "/other", "yolo", true)));
    persistConsent(file, "/repo", "observe", false);
    const merged = parseConsent(readFileSync(file, "utf8"));
    assert.equal(readConsent(merged, "/other", "yolo"), true);
    assert.equal(readConsent(merged, "/repo", "observe"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
