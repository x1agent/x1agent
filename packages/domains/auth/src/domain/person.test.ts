import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { PersonId } from "./person.js";

const uuid = "0188f5e1-7e3b-7000-8000-000000000001";

describe("PersonId", () => {
  it("accepts a valid UUID and lowercases it", () => {
    expect(PersonId(uuid)).toBe(uuid);
    expect(PersonId(uuid.toUpperCase())).toBe(uuid);
  });

  it("rejects non-UUID input", () => {
    expect(() => PersonId("nope")).toThrow(ValidationError);
    expect(() => PersonId("")).toThrow(ValidationError);
  });
});
