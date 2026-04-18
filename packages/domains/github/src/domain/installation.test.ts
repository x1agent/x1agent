import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { InstallationId } from "./installation.js";

describe("InstallationId", () => {
  it("accepts positive integers", () => {
    expect(InstallationId(123)).toBe(123 as ReturnType<typeof InstallationId>);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects %p", (n) => {
    expect(() => InstallationId(n as number)).toThrow(ValidationError);
  });
});
