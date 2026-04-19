import { create } from "zustand";
import type {
  AgentCollectionAttachmentDTO,
  CollectionDTO,
  CreateCollectionRequest,
  RecordDTO,
  RecordTypeDTO,
  SyncAgentCollectionsRequest,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface CollectionsState {
  bySlug: Record<string, CollectionDTO[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  /** Attachments per agent, keyed by `${workspaceSlug}:${agentId}`. */
  attachmentsByAgentKey: Record<string, AgentCollectionAttachmentDTO[]>;

  /**
   * Record types per collection, keyed by `${workspaceSlug}:${collectionId}`.
   * Populated lazily when the detail page mounts.
   */
  recordTypesByKey: Record<string, RecordTypeDTO[]>;
  recordTypesErrorByKey: Record<string, string | null>;
  recordTypesLoadingKey: string | null;

  /**
   * Records per type, keyed by `${workspaceSlug}:${collectionId}:${typeSlug}`.
   * Populated lazily when the record-type detail page mounts.
   */
  recordsByKey: Record<string, RecordDTO[]>;
  recordsErrorByKey: Record<string, string | null>;
  recordsLoadingKey: string | null;

  load(workspaceSlug: string): Promise<void>;
  create(
    workspaceSlug: string,
    body: CreateCollectionRequest,
  ): Promise<CollectionDTO>;
  remove(workspaceSlug: string, collectionId: string): Promise<void>;

  loadAttachments(workspaceSlug: string, agentId: string): Promise<void>;
  syncAttachments(
    workspaceSlug: string,
    agentId: string,
    body: SyncAgentCollectionsRequest,
  ): Promise<void>;

  loadRecordTypes(workspaceSlug: string, collectionId: string): Promise<void>;
  loadRecords(
    workspaceSlug: string,
    collectionId: string,
    typeSlug: string,
  ): Promise<void>;
}

export const useCollectionsStore = create<CollectionsState>((set, get) => ({
  bySlug: {},
  loadingSlug: null,
  errorBySlug: {},
  attachmentsByAgentKey: {},
  recordTypesByKey: {},
  recordTypesErrorByKey: {},
  recordTypesLoadingKey: null,
  recordsByKey: {},
  recordsErrorByKey: {},
  recordsLoadingKey: null,

  async load(workspaceSlug) {
    set((s) => ({
      loadingSlug: workspaceSlug,
      errorBySlug: { ...s.errorBySlug, [workspaceSlug]: null },
    }));
    try {
      const res = await apiFetch<{ collections: CollectionDTO[] }>(
        `/api/workspaces/${workspaceSlug}/collections`,
      );
      set((s) => ({
        bySlug: { ...s.bySlug, [workspaceSlug]: res.collections },
        loadingSlug: null,
      }));
    } catch (err) {
      set((s) => ({
        loadingSlug: null,
        errorBySlug: {
          ...s.errorBySlug,
          [workspaceSlug]: (err as Error).message,
        },
      }));
    }
  },

  async create(workspaceSlug, body) {
    const res = await apiFetch<{ collection: CollectionDTO }>(
      `/api/workspaces/${workspaceSlug}/collections`,
      { method: "POST", body: JSON.stringify(body) },
    );
    await get().load(workspaceSlug);
    return res.collection;
  },

  async remove(workspaceSlug, collectionId) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/collections/${collectionId}`,
      { method: "DELETE" },
    );
    await get().load(workspaceSlug);
  },

  async loadAttachments(workspaceSlug, agentId) {
    const key = `${workspaceSlug}:${agentId}`;
    try {
      const res = await apiFetch<{ attachments: AgentCollectionAttachmentDTO[] }>(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/collections`,
      );
      set((s) => ({
        attachmentsByAgentKey: {
          ...s.attachmentsByAgentKey,
          [key]: res.attachments,
        },
      }));
    } catch {
      set((s) => ({
        attachmentsByAgentKey: {
          ...s.attachmentsByAgentKey,
          [key]: [],
        },
      }));
    }
  },

  async syncAttachments(workspaceSlug, agentId, body) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}/collections`,
      { method: "PUT", body: JSON.stringify(body) },
    );
    await get().loadAttachments(workspaceSlug, agentId);
  },

  async loadRecordTypes(workspaceSlug, collectionId) {
    const key = `${workspaceSlug}:${collectionId}`;
    set({ recordTypesLoadingKey: key });
    try {
      const res = await apiFetch<{ record_types: RecordTypeDTO[] }>(
        `/api/workspaces/${workspaceSlug}/collections/${collectionId}/record-types`,
      );
      set((s) => ({
        recordTypesByKey: {
          ...s.recordTypesByKey,
          [key]: res.record_types,
        },
        recordTypesErrorByKey: {
          ...s.recordTypesErrorByKey,
          [key]: null,
        },
        recordTypesLoadingKey: null,
      }));
    } catch (err) {
      set((s) => ({
        recordTypesErrorByKey: {
          ...s.recordTypesErrorByKey,
          [key]: (err as Error).message,
        },
        recordTypesLoadingKey: null,
      }));
    }
  },

  async loadRecords(workspaceSlug, collectionId, typeSlug) {
    const key = `${workspaceSlug}:${collectionId}:${typeSlug}`;
    set({ recordsLoadingKey: key });
    try {
      const res = await apiFetch<{ records: RecordDTO[] }>(
        `/api/workspaces/${workspaceSlug}/collections/${collectionId}/record-types/${typeSlug}/records`,
      );
      set((s) => ({
        recordsByKey: { ...s.recordsByKey, [key]: res.records },
        recordsErrorByKey: { ...s.recordsErrorByKey, [key]: null },
        recordsLoadingKey: null,
      }));
    } catch (err) {
      set((s) => ({
        recordsErrorByKey: {
          ...s.recordsErrorByKey,
          [key]: (err as Error).message,
        },
        recordsLoadingKey: null,
      }));
    }
  },
}));
