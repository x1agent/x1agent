import { describe, expect, it } from "bun:test";
import { DomainError, ValidationError } from "@x1agent/kernel";
import { WorkspaceNamespace } from "@x1agent/domain-graph";
import { VectorNamespace } from "../domain/namespace.js";
import { runVectorProviderContract } from "../contract-tests/vector-provider.contract.js";
import { InMemoryVectorProvider } from "./fakes.js";

runVectorProviderContract({
  name: "InMemoryVectorProvider",
  factory: () => new InMemoryVectorProvider(),
  namespace: "col_test_fake",
  workspaceNamespace: "ws_test_fake",
  dimension: 4,
});

describe("VectorNamespace validator", () => {
  it.each(["col_ideas", "a", "x_1"])("accepts %p", (s) => {
    expect(VectorNamespace(s)).toBe(s as never);
  });
  it.each(["", "1_ns", "Col_Ideas", "col-ideas"])("rejects %p", (s) => {
    expect(() => VectorNamespace(s)).toThrow(ValidationError);
  });
});

describe("InMemoryVectorProvider extras", () => {
  const ws = WorkspaceNamespace("ws_extras");

  it("search on unprovisioned namespace throws not_provisioned", async () => {
    const p = new InMemoryVectorProvider();
    try {
      await p.search({
        workspaceNamespace: ws,
        namespace: VectorNamespace("col_nope"),
        vector: [0, 0, 0, 0],
        topK: 5,
        filter: {},
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(
        "vector_namespace_not_provisioned",
      );
    }
  });

  it("cosine ranks similar vectors above dissimilar", async () => {
    const p = new InMemoryVectorProvider();
    const ns = VectorNamespace("col_rank");
    await p.provision({
      workspaceNamespace: ws,
      namespace: ns,
      dimension: 3,
      metric: "cosine",
    });
    await p.upsert({
      workspaceNamespace: ws,
      namespace: ns,
      id: "same",
      vector: [1, 0, 0],
      metadata: {},
    });
    await p.upsert({
      workspaceNamespace: ws,
      namespace: ns,
      id: "orthogonal",
      vector: [0, 1, 0],
      metadata: {},
    });
    const { hits } = await p.search({
      workspaceNamespace: ws,
      namespace: ns,
      vector: [1, 0, 0],
      topK: 2,
      filter: {},
    });
    expect(hits[0]?.id).toBe("same");
    expect(hits[1]?.id).toBe("orthogonal");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});
