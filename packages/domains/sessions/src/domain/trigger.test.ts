import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { TriggerSource } from "./trigger.js";

describe("TriggerSource", () => {
  it("accepts 'user' and 'scheduler'", () => {
    expect(TriggerSource("user")).toBe("user");
    expect(TriggerSource("scheduler")).toBe("scheduler");
  });

  it("rejects anything else", () => {
    expect(() => TriggerSource("cron")).toThrow(ValidationError);
    expect(() => TriggerSource("")).toThrow(ValidationError);
  });
});
