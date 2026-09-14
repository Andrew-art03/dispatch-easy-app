import { describe, expect, it } from "vitest";

// Placeholder so `bun run test` is a real command with a real exit code.
// EZ-002 wires the runner; the first behavioural tests arrive with the money
// math in 1B, where CLAUDE.md rule 2 requires them (deterministic TypeScript,
// unit-tested, never an LLM computing a number).
describe("test runner", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
