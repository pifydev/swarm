// Minimal ambient types for the "bun:test" module used by the wire test.
// This suite runs under `bun test`; bun supplies this module at runtime, but
// tsc has no types for it. Only the sliver the test uses is declared here.
declare module "bun:test" {
  export const mock: {
    module(name: string, factory: () => unknown): void | Promise<void>;
  };
}
