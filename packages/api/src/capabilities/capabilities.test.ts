import { describe, it, expect } from "vitest";
import { readCapabilitiesFromEnv } from "./capabilities.js";

describe("readCapabilitiesFromEnv", () => {
  it("returns nulls when no env vars set", () => {
    const c = readCapabilitiesFromEnv({});
    expect(c.graph).toBeNull();
    expect(c.vector).toBeNull();
    expect(c.messaging).toEqual([]);
  });

  it("treats common 'unset' sentinels as null so helm can default to a literal", () => {
    for (const sentinel of ["", "none", "off", "disabled", "  none  "]) {
      const c = readCapabilitiesFromEnv({ PROVIDER_GRAPH: sentinel });
      expect(c.graph).toBeNull();
    }
  });

  it("normalizes to lower case so PROVIDER_GRAPH=SurrealDB still matches the provider id", () => {
    const c = readCapabilitiesFromEnv({ PROVIDER_GRAPH: "SurrealDB" });
    expect(c.graph).toBe("surrealdb");
  });

  it("parses messaging as a comma-separated list and drops 'none' entries", () => {
    const c = readCapabilitiesFromEnv({
      PROVIDER_MESSAGING: "slack, discord, none, ",
    });
    expect(c.messaging).toEqual(["slack", "discord"]);
  });

  it("an empty messaging value is an empty list, not [''] — UI relies on .length", () => {
    const c = readCapabilitiesFromEnv({ PROVIDER_MESSAGING: "" });
    expect(c.messaging).toEqual([]);
  });
});
