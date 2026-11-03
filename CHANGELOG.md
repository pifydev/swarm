# Changelog

## [0.16.1] - 2026-11-03

- Compatible with pi 1.5.0: the `swarm` `on_upstream_failure` enum parameter is
  built with a local `StringEnum` helper so its argument type stays precise. pi
  1.5.0 moved tool-argument validation to `@earendil-works/pi-schema`, and its
  `StringEnum` no longer composes inside a TypeBox `Type.Object`; the tool schema
  and runtime validation are unchanged.

## [0.16.0] - 2026-10-14

- Builtin child agents report in a compressed, fixed shape.
