import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StringEnum } from "../src/string-enum.ts";

test("emits a Google-compatible string enum (no anyOf/const)", () => {
  const schema = StringEnum(["global", "project", "daily"] as const) as unknown as Record<string, unknown>;
  assert.equal(schema.type, "string");
  assert.deepEqual(schema.enum, ["global", "project", "daily"]);
  assert.ok(!("anyOf" in schema));
  assert.ok(!("const" in schema));
});

test("carries description and default only when given", () => {
  const bare = StringEnum(["a", "b"] as const) as unknown as Record<string, unknown>;
  assert.ok(!("description" in bare));
  assert.ok(!("default" in bare));

  const full = StringEnum(["a", "b"] as const, {
    description: "pick one",
    default: "a",
  }) as unknown as Record<string, unknown>;
  assert.equal(full.description, "pick one");
  assert.equal(full.default, "a");
});
