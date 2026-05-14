import { describe, expect, it } from "bun:test";
import { DomainError, ValidationError } from "@x1agent/kernel";
import { CollectionHandle } from "../domain/collection-handle.js";
import { WorkspaceNamespace } from "../domain/workspace-namespace.js";
import type { CollectionAddress } from "../ports/graph-provider.js";
import { runGraphProviderContract } from "../contract-tests/graph-provider.contract.js";
import { InMemoryGraphProvider } from "./fakes.js";

runGraphProviderContract({
  name: "InMemoryGraphProvider",
  factory: () => new InMemoryGraphProvider(),
  handle: "col_test_fake",
});

describe("CollectionHandle validator", () => {
  it.each(["col_default_ideas", "a", "x1_graph_01"])(
    "accepts %p",
    (s) => {
      expect(CollectionHandle(s)).toBe(s as never);
    },
  );
  it.each(["", "1col", "Col_Default", "col-default", "a".repeat(64)])(
    "rejects %p",
    (s) => {
      expect(() => CollectionHandle(s)).toThrow(ValidationError);
    },
  );
});

describe("InMemoryGraphProvider extras", () => {
  const addr: CollectionAddress = {
    namespace: WorkspaceNamespace("ws_extras"),
    database: CollectionHandle("col_one"),
  };

  it("rejects double provision", async () => {
    const p = new InMemoryGraphProvider();
    await p.provision(addr);
    try {
      await p.provision(addr);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("collection_already_provisioned");
    }
  });

  it("deprovision is a no-op on unknown handle", async () => {
    const p = new InMemoryGraphProvider();
    await p.deprovision({
      namespace: WorkspaceNamespace("ws_extras"),
      database: CollectionHandle("col_missing"),
    });
  });
});
