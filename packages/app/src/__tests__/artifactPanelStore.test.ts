import { describe, expect, it, beforeEach } from "bun:test";
import { useArtifactPanelStore } from "../stores/artifactPanelStore";
import type { AgentSharePayload } from "../features/sessions/ShareCard";

function payload(shareId: string, total = 100): AgentSharePayload {
  return {
    share_id: shareId,
    share_type: "document",
    title: "T",
    entry_point: "",
    files: [],
    total_size: total,
  } as unknown as AgentSharePayload;
}

beforeEach(() => {
  useArtifactPanelStore.setState({
    open: null,
    view: "panel",
    commentsCollapsed: false,
  });
});

describe("artifactPanelStore.replaceArtifact", () => {
  it("no-ops when no panel is open", () => {
    useArtifactPanelStore.getState().replaceArtifact(payload("any"));
    expect(useArtifactPanelStore.getState().open).toBeNull();
  });

  it("no-ops when share_id does not match the open panel", () => {
    useArtifactPanelStore.getState().show({
      workspaceSlug: "w",
      sessionId: "s",
      artifact: payload("share-a"),
    });
    const before = useArtifactPanelStore.getState().open;
    useArtifactPanelStore.getState().replaceArtifact(payload("share-b"));
    expect(useArtifactPanelStore.getState().open).toBe(before);
    expect(useArtifactPanelStore.getState().open?.version).toBe(0);
  });

  it("replaces artifact and bumps version when share_id matches", () => {
    useArtifactPanelStore.getState().show({
      workspaceSlug: "w",
      sessionId: "s",
      artifact: payload("share-a", 100),
    });
    expect(useArtifactPanelStore.getState().open?.version).toBe(0);

    useArtifactPanelStore.getState().replaceArtifact(payload("share-a", 200));
    const open = useArtifactPanelStore.getState().open!;
    expect(open.artifact.total_size).toBe(200);
    expect(open.version).toBe(1);

    // Subsequent re-emit bumps again — keys downstream `key={shareId:version}`
    // remount the renderer subtree on every update.
    useArtifactPanelStore.getState().replaceArtifact(payload("share-a", 300));
    expect(useArtifactPanelStore.getState().open!.version).toBe(2);
  });
});
