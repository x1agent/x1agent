import { describe, expect, it, beforeEach } from "bun:test";
import { DomainError } from "@x1agent/kernel";
import { WorkspaceNamespace } from "@x1agent/domain-graph";
import { VectorNamespace } from "../domain/namespace.js";
import type { VectorProvider } from "../ports/vector-provider.js";

export interface VectorProviderContractFixture {
  name: string;
  factory: () => Promise<VectorProvider> | VectorProvider;
  namespace: string;
  /** Workspace namespace under which the contract suite runs. */
  workspaceNamespace?: string;
  /** All vectors in the contract test use this dimension. */
  dimension: number;
}

export function runVectorProviderContract(
  fx: VectorProviderContractFixture,
): void {
  describe(`VectorProvider contract — ${fx.name}`, () => {
    let provider: VectorProvider;
    let ns: VectorNamespace;
    let ws: WorkspaceNamespace;

    beforeEach(async () => {
      provider = await fx.factory();
      ns = VectorNamespace(fx.namespace);
      ws = WorkspaceNamespace(fx.workspaceNamespace ?? "ws_contract");
      await provider.provision({
        workspaceNamespace: ws,
        namespace: ns,
        dimension: fx.dimension,
        metric: "cosine",
      });
    });

    it("upsert + search round-trip returns the vector with a top-1 hit", async () => {
      const v = Array.from({ length: fx.dimension }, (_, i) => (i === 0 ? 1 : 0));
      await provider.upsert({
        workspaceNamespace: ws,
        namespace: ns,
        id: "only",
        vector: v,
        metadata: { topic: "smoke" },
      });
      const { hits } = await provider.search({
        workspaceNamespace: ws,
        namespace: ns,
        vector: v,
        topK: 5,
        filter: {},
      });
      expect(hits[0]?.id).toBe("only");
      expect(hits[0]?.metadata["topic"]).toBe("smoke");
    });

    it("search respects topK", async () => {
      for (let i = 0; i < 5; i++) {
        const v = Array.from({ length: fx.dimension }, (_, j) =>
          j === 0 ? 1 + i * 0.01 : 0,
        );
        await provider.upsert({
          workspaceNamespace: ws,
          namespace: ns,
          id: `r${i}`,
          vector: v,
          metadata: {},
        });
      }
      const q = Array.from({ length: fx.dimension }, (_, j) =>
        j === 0 ? 1 : 0,
      );
      const { hits } = await provider.search({
        workspaceNamespace: ws,
        namespace: ns,
        vector: q,
        topK: 2,
        filter: {},
      });
      expect(hits).toHaveLength(2);
    });

    it("search filter narrows to matching metadata", async () => {
      const v = Array.from({ length: fx.dimension }, () => 0.1);
      await provider.upsert({
        workspaceNamespace: ws,
        namespace: ns,
        id: "a",
        vector: v,
        metadata: { kind: "note" },
      });
      await provider.upsert({
        workspaceNamespace: ws,
        namespace: ns,
        id: "b",
        vector: v,
        metadata: { kind: "doc" },
      });
      const { hits } = await provider.search({
        workspaceNamespace: ws,
        namespace: ns,
        vector: v,
        topK: 10,
        filter: { kind: "doc" },
      });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
    });

    it("upsert overwrites an existing id (not insert + duplicate)", async () => {
      const v1 = Array.from({ length: fx.dimension }, () => 0.5);
      const v2 = Array.from({ length: fx.dimension }, () => 0.9);
      await provider.upsert({
        workspaceNamespace: ws,
        namespace: ns,
        id: "x",
        vector: v1,
        metadata: { n: 1 },
      });
      await provider.upsert({
        workspaceNamespace: ws,
        namespace: ns,
        id: "x",
        vector: v2,
        metadata: { n: 2 },
      });
      const { hits } = await provider.search({
        workspaceNamespace: ws,
        namespace: ns,
        vector: v2,
        topK: 10,
        filter: {},
      });
      const x = hits.find((h) => h.id === "x");
      expect(x?.metadata["n"]).toBe(2);
    });

    it("delete removes the vector from subsequent searches", async () => {
      const v = Array.from({ length: fx.dimension }, () => 0.3);
      await provider.upsert({
        workspaceNamespace: ws,
        namespace: ns,
        id: "gone",
        vector: v,
        metadata: {},
      });
      await provider.delete(ws, ns, "gone");
      const { hits } = await provider.search({
        workspaceNamespace: ws,
        namespace: ns,
        vector: v,
        topK: 10,
        filter: {},
      });
      expect(hits.find((h) => h.id === "gone")).toBeUndefined();
    });

    it("dimension mismatch throws vector_dimension_mismatch", async () => {
      const v = Array.from({ length: fx.dimension + 1 }, () => 0);
      try {
        await provider.upsert({
          workspaceNamespace: ws,
          namespace: ns,
          id: "bad",
          vector: v,
          metadata: {},
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe("vector_dimension_mismatch");
      }
    });

    it("two-workspace isolation — same namespace name across workspaces is separate storage", async () => {
      const otherWs = WorkspaceNamespace("ws_other_tenant");
      await provider.provision({
        workspaceNamespace: otherWs,
        namespace: ns,
        dimension: fx.dimension,
        metric: "cosine",
      });
      const v = Array.from({ length: fx.dimension }, () => 0.7);
      await provider.upsert({
        workspaceNamespace: otherWs,
        namespace: ns,
        id: "only-foreign",
        vector: v,
        metadata: {},
      });
      const { hits } = await provider.search({
        workspaceNamespace: ws,
        namespace: ns,
        vector: v,
        topK: 10,
        filter: {},
      });
      expect(hits.find((h) => h.id === "only-foreign")).toBeUndefined();
      await provider.deprovision(otherWs, ns);
    });
  });
}
