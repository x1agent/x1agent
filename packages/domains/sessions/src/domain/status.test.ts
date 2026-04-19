import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { SessionStatus, isTerminal } from "./status.js";

describe("SessionStatus", () => {
  it("accepts valid values", () => {
    for (const v of ["pending", "running", "complete", "failed"] as const) {
      expect(SessionStatus(v)).toBe(v);
    }
  });

  it("rejects anything else", () => {
    expect(() => SessionStatus("cancelled")).toThrow(ValidationError);
    expect(() => SessionStatus("")).toThrow(ValidationError);
  });
});

describe("isTerminal", () => {
  it("is true only for complete and failed", () => {
    expect(isTerminal(SessionStatus("pending"))).toBe(false);
    expect(isTerminal(SessionStatus("running"))).toBe(false);
    expect(isTerminal(SessionStatus("complete"))).toBe(true);
    expect(isTerminal(SessionStatus("failed"))).toBe(true);
  });
});
