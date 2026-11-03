/**
 * A `{ type: "string", enum: [...] }` tool-parameter schema whose static type is
 * the literal union of its values.
 *
 * pi ships a `StringEnum` in `@earendil-works/pi-ai`, but as of pi 1.5.0 it
 * returns a `@earendil-works/pi-schema` `Schema`, which typebox's `Type.Object`
 * cannot read: the property infers as `unknown`, so a tool handler typed with
 * the real union no longer matches `Static<typeof parameters>` and `tsc` fails.
 * `Type.Unsafe` builds the identical JSON Schema — validated the same way by
 * pi-schema, and still free of the `anyOf`/`const` that Google's API rejects —
 * while carrying the correct `T[number]` static type.
 *
 * Vendored per package, byte-identical, zero dependencies beyond typebox.
 */
import { Type } from "typebox";

export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default ? { default: options.default } : {}),
  });
}
