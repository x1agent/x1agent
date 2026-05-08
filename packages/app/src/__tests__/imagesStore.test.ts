import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import {
  useImagesStore,
  hasTransientBuilds,
  type AgentImage,
} from "../stores/imagesStore";

const SLUG = "ws";

function makeImg(overrides: Partial<AgentImage> = {}): AgentImage {
  return {
    id: overrides.id ?? "img-1",
    workspace_id: overrides.workspace_id ?? "ws-1",
    name: overrides.name ?? "django",
    display_name: overrides.display_name ?? "Django",
    description: overrides.description ?? null,
    built_ref:
      overrides.built_ref ?? "registry/ws/ws-1/django@sha256:deadbeef",
    is_preset: overrides.is_preset ?? false,
    dockerfile_source: overrides.dockerfile_source ?? "FROM scratch\n",
    build_status: overrides.build_status ?? "succeeded",
    build_log: overrides.build_log ?? "",
    last_built_at: overrides.last_built_at ?? null,
    created_at: overrides.created_at ?? "2024-01-01T00:00:00Z",
  };
}

const fetchMock = mock(() => Promise.resolve(new Response()));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset store between tests.
  useImagesStore.setState({
    bySlug: {},
    loadingSlug: null,
    errorBySlug: {},
  });
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("imagesStore selectors", () => {
  it("byKey selector with `?? []` OUTSIDE returns a stable reference across reads when the slot is missing", () => {
    // Mirrors the panel pattern: useImagesStore((s) => s.bySlug[slug])
    // and `?? []` outside. The inner value stays === across reads when
    // unset (vs. returning a fresh [] inside the selector — that would
    // break React's render-bailout and infinite-loop on mount).
    const sel = (s: ReturnType<typeof useImagesStore.getState>) =>
      s.bySlug[SLUG];
    const a = sel(useImagesStore.getState());
    const b = sel(useImagesStore.getState());
    expect(a).toBe(b);
    expect(a).toBeUndefined();
  });

  it("byKey selector returns the same array reference across reads when the slot is set and unchanged", () => {
    useImagesStore.setState({
      bySlug: { [SLUG]: [makeImg()] },
    });
    const sel = (s: ReturnType<typeof useImagesStore.getState>) =>
      s.bySlug[SLUG];
    const a = sel(useImagesStore.getState());
    const b = sel(useImagesStore.getState());
    expect(a).toBe(b);
    expect(a).toHaveLength(1);
  });
});

describe("imagesStore actions", () => {
  it("load() populates bySlug on success", async () => {
    const img = makeImg();
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response(JSON.stringify({ images: [img] }), { status: 200 }),
      ) as never,
    );
    await useImagesStore.getState().load(SLUG);
    expect(useImagesStore.getState().bySlug[SLUG]).toEqual([img]);
    expect(useImagesStore.getState().errorBySlug[SLUG]).toBeNull();
  });

  it("load() sets errorBySlug on failure", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(new Response("nope", { status: 500 })) as never,
    );
    await useImagesStore.getState().load(SLUG);
    expect(useImagesStore.getState().bySlug[SLUG]).toBeUndefined();
    expect(useImagesStore.getState().errorBySlug[SLUG]).toContain("500");
  });

  it("create() POSTs and merges the row alphabetically among workspace rows", async () => {
    const preset = makeImg({ id: "preset-1", is_preset: true, name: "preset-x" });
    const wsAlpha = makeImg({ id: "img-a", name: "alpha" });
    const wsCharlie = makeImg({ id: "img-c", name: "charlie" });
    useImagesStore.setState({ bySlug: { [SLUG]: [preset, wsAlpha, wsCharlie] } });
    const created = makeImg({ id: "img-b", name: "bravo" });
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response(JSON.stringify(created), { status: 201 }),
      ) as never,
    );
    await useImagesStore.getState().create(SLUG, {
      name: "bravo",
      display_name: "Bravo",
      dockerfile_source: "FROM scratch\n",
    });
    const list = useImagesStore.getState().bySlug[SLUG]!;
    // preset stays first, workspace rows sorted alphabetically.
    expect(list.map((i) => i.id)).toEqual([
      "preset-1",
      "img-a",
      "img-b",
      "img-c",
    ]);
  });

  it("update() replaces the row in place", async () => {
    const cur = makeImg();
    useImagesStore.setState({ bySlug: { [SLUG]: [cur] } });
    const updated = makeImg({ display_name: "Renamed" });
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response(JSON.stringify(updated), { status: 200 }),
      ) as never,
    );
    await useImagesStore
      .getState()
      .update(SLUG, cur.id, { display_name: "Renamed" });
    expect(useImagesStore.getState().bySlug[SLUG]?.[0]?.display_name).toBe(
      "Renamed",
    );
  });

  it("rebuild() flips the row's status via the rebuild endpoint", async () => {
    const cur = makeImg({ build_status: "failed" });
    useImagesStore.setState({ bySlug: { [SLUG]: [cur] } });
    const rebuilt = makeImg({ build_status: "pending" });
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response(JSON.stringify(rebuilt), { status: 200 }),
      ) as never,
    );
    await useImagesStore.getState().rebuild(SLUG, cur.id);
    expect(useImagesStore.getState().bySlug[SLUG]?.[0]?.build_status).toBe(
      "pending",
    );
  });

  it("remove() drops the row from the cache", async () => {
    const a = makeImg({ id: "a" });
    const b = makeImg({ id: "b" });
    useImagesStore.setState({ bySlug: { [SLUG]: [a, b] } });
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ) as never,
    );
    await useImagesStore.getState().remove(SLUG, "a");
    expect(useImagesStore.getState().bySlug[SLUG]?.map((i) => i.id)).toEqual([
      "b",
    ]);
  });

  it("remove() surfaces server errors without dropping the row", async () => {
    const a = makeImg({ id: "a" });
    useImagesStore.setState({ bySlug: { [SLUG]: [a] } });
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response('{"error":"image_in_use"}', { status: 409 }),
      ) as never,
    );
    await expect(
      useImagesStore.getState().remove(SLUG, "a"),
    ).rejects.toThrow();
    expect(useImagesStore.getState().bySlug[SLUG]?.[0]?.id).toBe("a");
  });
});

describe("hasTransientBuilds", () => {
  it("true when any row is pending", () => {
    expect(
      hasTransientBuilds([makeImg({ build_status: "pending" })]),
    ).toBe(true);
  });

  it("true when any row is building", () => {
    expect(
      hasTransientBuilds([
        makeImg({ build_status: "ready" }),
        makeImg({ build_status: "building", id: "b" }),
      ]),
    ).toBe(true);
  });

  it("false when every row is terminal", () => {
    expect(
      hasTransientBuilds([
        makeImg({ build_status: "ready" }),
        makeImg({ build_status: "succeeded", id: "b" }),
        makeImg({ build_status: "failed", id: "c" }),
      ]),
    ).toBe(false);
  });
});
