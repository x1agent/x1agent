import { describe, expect, it, beforeEach } from "bun:test";
import { DomainError } from "@x1agent/kernel";
import { CollectionHandle } from "../domain/collection-handle.js";
import { WorkspaceNamespace } from "../domain/workspace-namespace.js";
import { DEFAULT_RECORD_TYPES } from "../domain/record-type.js";
import type {
  CollectionAddress,
  GraphProvider,
} from "../ports/graph-provider.js";

export interface GraphProviderContractFixture {
  name: string;
  /**
   * Build a fresh provider that's **not** yet provisioned for the
   * supplied address. The contract suite calls `provision(address)`
   * first in each test.
   */
  factory: () => Promise<GraphProvider> | GraphProvider;
  /** Unique handle per test run so provision doesn't collide. */
  handle: string;
  /**
   * Workspace namespace under which the contract suite runs its
   * canonical test address. Defaults to a generated namespace per
   * fixture name; explicit fixtures can pin it.
   */
  namespace?: string;
}

export function runGraphProviderContract(
  fx: GraphProviderContractFixture,
): void {
  describe(`GraphProvider contract — ${fx.name}`, () => {
    let provider: GraphProvider;
    let address: CollectionAddress;

    beforeEach(async () => {
      provider = await fx.factory();
      address = {
        namespace: WorkspaceNamespace(fx.namespace ?? "ws_contract"),
        database: CollectionHandle(fx.handle),
      };
      await provider.provision(address);
    });

    it("provision seeds the default record types", async () => {
      const types = await provider.discover(address);
      const slugs = types.map((t) => t.slug).sort();
      for (const seed of DEFAULT_RECORD_TYPES) {
        expect(slugs).toContain(seed.slug);
      }
    });

    it("provision is idempotent-after-deprovision", async () => {
      await provider.deprovision(address);
      await provider.provision(address);
      const types = await provider.discover(address);
      expect(types.length).toBeGreaterThan(0);
    });

    it("write + discover registers the record type the first time", async () => {
      await provider.write({
        collection: address,
        recordType: "idea",
        data: { title: "agent self-play", tag: "dark-factory" },
        provenance: {
          sessionId: "00000000-0000-0000-0000-000000000001",
          userId: null,
          confidence: 0.8,
          source: "manual",
          derivedFrom: [],
        },
      });
      const types = await provider.discover(address);
      expect(types.find((t) => t.slug === "idea")).toBeDefined();
    });

    it("write stamps provenance with session + confidence", async () => {
      const rec = await provider.write({
        collection: address,
        recordType: "person",
        data: { name: "Sarah" },
        provenance: {
          sessionId: "11111111-1111-1111-1111-111111111111",
          userId: null,
          confidence: 0.42,
          source: null,
          derivedFrom: [],
        },
      });
      expect(rec.provenance.createdBy).toBe(
        "session:11111111-1111-1111-1111-111111111111",
      );
      expect(rec.provenance.confidence).toBe(0.42);
    });

    it("relate links two existing records and echoes the edge label", async () => {
      const a = await provider.write({
        collection: address,
        recordType: "person",
        data: { name: "Sarah" },
        provenance: {
          sessionId: "00000000-0000-0000-0000-000000000001",
          userId: null,
          confidence: 1,
          source: null,
          derivedFrom: [],
        },
      });
      const b = await provider.write({
        collection: address,
        recordType: "project",
        data: { name: "rebrand", status: "active" },
        provenance: {
          sessionId: "00000000-0000-0000-0000-000000000001",
          userId: null,
          confidence: 1,
          source: null,
          derivedFrom: [],
        },
      });
      const edge = await provider.relate({
        collection: address,
        from: a.id,
        edge: "WORKS_ON",
        to: b.id,
        properties: { since: "2026-04-19" },
      });
      expect(edge.edge).toBe("WORKS_ON");
      expect(edge.from).toBe(a.id);
      expect(edge.to).toBe(b.id);
    });

    it("resolve finds a record by email hint", async () => {
      await provider.write({
        collection: address,
        recordType: "person",
        data: { name: "Sarah", email: "sarah@example.com" },
        provenance: {
          sessionId: "00000000-0000-0000-0000-000000000001",
          userId: null,
          confidence: 1,
          source: null,
          derivedFrom: [],
        },
      });
      const got = await provider.resolve({
        collection: address,
        recordType: "person",
        name: null,
        email: "sarah@example.com",
        attributes: {},
      });
      expect(got?.data["email"]).toBe("sarah@example.com");
    });

    it("resolve returns null when nothing matches", async () => {
      const got = await provider.resolve({
        collection: address,
        recordType: "person",
        name: "no-such-name",
        email: null,
        attributes: {},
      });
      expect(got).toBeNull();
    });

    it("write against a deprovisioned collection throws collection_not_provisioned", async () => {
      await provider.deprovision(address);
      try {
        await provider.write({
          collection: address,
          recordType: "person",
          data: {},
          provenance: {
            sessionId: "00000000-0000-0000-0000-000000000001",
            userId: null,
            confidence: 1,
            source: null,
            derivedFrom: [],
          },
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe("collection_not_provisioned");
      }
    });

    it("two-workspace isolation — a collection with the same db name in another namespace is invisible", async () => {
      // Same database name, different namespace = different backing
      // store. This is the structural property Layer 2 buys us.
      const foreign: CollectionAddress = {
        namespace: WorkspaceNamespace("ws_foreign_tenant"),
        database: address.database,
      };
      await provider.provision(foreign);
      await provider.write({
        collection: foreign,
        recordType: "person",
        data: { name: "OnlyInForeign" },
        provenance: {
          sessionId: "00000000-0000-0000-0000-000000000001",
          userId: null,
          confidence: 1,
          source: null,
          derivedFrom: [],
        },
      });
      const got = await provider.resolve({
        collection: address,
        recordType: "person",
        name: "OnlyInForeign",
        email: null,
        attributes: {},
      });
      expect(got).toBeNull();
      await provider.deprovision(foreign);
    });
  });
}
