import { describe, expect, test } from "bun:test";
import { safeProviderError } from "./collection-control.js";
import { safeFailure } from "./oci-image-control.js";

describe("administrative MCP async failure sanitization", () => {
  test("does not persist collection provider response bodies", () => {
    const failure = safeProviderError(
      Object.assign(new Error("postgres://user:password@internal-host"), {
        code: "provider_unavailable",
      }),
    );
    expect(failure).toEqual({
      code: "provider_unavailable",
      message: "collection provider operation failed",
    });
    expect(JSON.stringify(failure)).not.toContain("password");
    expect(JSON.stringify(failure)).not.toContain("internal-host");
  });

  test("uses stable OCI messages instead of registry response bodies", () => {
    const known = safeFailure(
      Object.assign(new Error("Bearer realm=https://secret-registry/token"), {
        code: "registry_auth_required",
      }),
    );
    expect(known).toEqual({
      code: "registry_auth_required",
      message: "registry authentication is required",
    });
    expect(JSON.stringify(known)).not.toContain("secret-registry");

    expect(safeFailure(new Error("dial tcp internal-host"))).toEqual({
      code: "image_validation_failed",
      message: "OCI image validation failed",
    });
  });
});
