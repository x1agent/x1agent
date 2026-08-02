import { describe, it, expect } from "bun:test";
import {
  resolveSingleUpload,
  resolveImageTokens,
  extFromMime,
} from "./image-tokens.js";

const ID_A = "7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11";
const ID_B = "12345678-1234-1234-1234-1234567890ab";

function makeFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

interface WriteCall {
  path: string;
  bytes: Buffer;
}

function recordingWriters(): {
  writeFileImpl: (p: string, b: Uint8Array) => Promise<void>;
  mkdirImpl: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  writes: WriteCall[];
  mkdirs: string[];
} {
  const writes: WriteCall[] = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    writeFileImpl: async (path: string, bytes: Uint8Array) => {
      writes.push({ path: String(path), bytes: Buffer.from(bytes) });
    },
    mkdirImpl: async (path: string) => {
      mkdirs.push(String(path));
    },
  };
}

describe("extFromMime", () => {
  it("maps image MIMEs to canonical extensions", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("application/pdf")).toBe("pdf");
  });

  it("falls back to .bin for unknown MIMEs — agent doesn't need to know the type, Read does", () => {
    expect(extFromMime("application/x-unknown")).toBe("bin");
  });

  it("ignores charset suffixes", () => {
    expect(extFromMime("image/svg+xml; charset=utf-8")).toBe("svg");
  });
});

describe("resolveSingleUpload — sidecar credential-proxy contract", () => {
  it("POSTs to {sidecarUrl}/uploads/read with just upload_id (no master token, no user_id) — the sidecar enforces auth", async () => {
    let observedUrl = "";
    let observedBody = "";
    const fetchImpl = makeFetch(async (url, init) => {
      observedUrl = url;
      observedBody =
        typeof init?.body === "string" ? init.body : String(init?.body);
      return new Response(
        JSON.stringify({
          ok: true,
          content_b64: Buffer.from([1, 2, 3]).toString("base64"),
          mime: "image/png",
          size: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const rec = recordingWriters();

    const out = await resolveSingleUpload(ID_A, {
      sidecarUrl: "http://localhost:9090",
      uploadsDir: "/tmp/test-uploads",
      fetchImpl,
      writeFileImpl: rec.writeFileImpl,
      mkdirImpl: rec.mkdirImpl,
      logImpl: () => {},
    });

    expect(observedUrl).toBe("http://localhost:9090/uploads/read");
    // The agent only knows the upload id — no master internal token,
    // no user_id. That's the whole point of the credential-proxy
    // pivot.
    const parsed = JSON.parse(observedBody);
    expect(parsed).toEqual({ upload_id: ID_A });
    expect(out).toContain("/tmp/test-uploads/" + ID_A + ".png");
    expect(out).toContain("use the Read tool");
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0]!.path).toBe(`/tmp/test-uploads/${ID_A}.png`);
    expect(rec.writes[0]!.bytes.toString("hex")).toBe("010203");
  });

  it("returns (upload <id>: unavailable) on HTTP error so the message still gets through", async () => {
    const fetchImpl = makeFetch(
      async () => new Response("forbidden", { status: 403 }),
    );
    const rec = recordingWriters();
    const out = await resolveSingleUpload(ID_A, {
      sidecarUrl: "http://localhost:9090",
      uploadsDir: "/tmp/test-uploads",
      fetchImpl,
      writeFileImpl: rec.writeFileImpl,
      mkdirImpl: rec.mkdirImpl,
      logImpl: () => {},
    });
    expect(out).toBe(`(upload ${ID_A}: unavailable)`);
    expect(rec.writes).toHaveLength(0);
  });

  it("returns (upload <id>: unavailable) when the sidecar JSON says ok=false (e.g. cross_workspace)", async () => {
    const fetchImpl = makeFetch(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "cross_workspace", message: "..." },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const rec = recordingWriters();
    const out = await resolveSingleUpload(ID_A, {
      sidecarUrl: "http://localhost:9090",
      uploadsDir: "/tmp/test-uploads",
      fetchImpl,
      writeFileImpl: rec.writeFileImpl,
      mkdirImpl: rec.mkdirImpl,
      logImpl: () => {},
    });
    expect(out).toBe(`(upload ${ID_A}: unavailable)`);
  });

  it("returns (upload <id>: error) when fetch throws — the turn still flows", async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error("connection reset");
    });
    const rec = recordingWriters();
    const out = await resolveSingleUpload(ID_A, {
      sidecarUrl: "http://localhost:9090",
      uploadsDir: "/tmp/test-uploads",
      fetchImpl,
      writeFileImpl: rec.writeFileImpl,
      mkdirImpl: rec.mkdirImpl,
      logImpl: () => {},
    });
    expect(out).toBe(`(upload ${ID_A}: error)`);
  });
});

describe("resolveImageTokens — replacement & dedupe", () => {
  it("replaces every token with the path pointer", async () => {
    const fetchImpl = makeFetch(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            content_b64: Buffer.from([9]).toString("base64"),
            mime: "image/png",
            size: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const rec = recordingWriters();
    const out = await resolveImageTokens(
      `look at [image: ${ID_A}] and also [image: ${ID_B}]`,
      {
        sidecarUrl: "http://localhost:9090",
        uploadsDir: "/tmp/test-uploads",
        fetchImpl,
        writeFileImpl: rec.writeFileImpl,
        mkdirImpl: rec.mkdirImpl,
        logImpl: () => {},
      },
    );
    expect(out).not.toContain("[image:");
    expect(out).toContain(`/tmp/test-uploads/${ID_A}.png`);
    expect(out).toContain(`/tmp/test-uploads/${ID_B}.png`);
  });

  it("fetches each unique id once even if the token repeats", async () => {
    let calls = 0;
    const fetchImpl = makeFetch(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          content_b64: Buffer.from([0]).toString("base64"),
          mime: "image/png",
          size: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const rec = recordingWriters();
    await resolveImageTokens(`[image: ${ID_A}] and again [image: ${ID_A}]`, {
      sidecarUrl: "http://localhost:9090",
      uploadsDir: "/tmp/test-uploads",
      fetchImpl,
      writeFileImpl: rec.writeFileImpl,
      mkdirImpl: rec.mkdirImpl,
      logImpl: () => {},
    });
    expect(calls).toBe(1);
  });

  it("passes through text with no tokens unchanged", async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error("should not be called");
    });
    const rec = recordingWriters();
    const out = await resolveImageTokens("just plain text", {
      sidecarUrl: "http://localhost:9090",
      fetchImpl,
      writeFileImpl: rec.writeFileImpl,
      mkdirImpl: rec.mkdirImpl,
      logImpl: () => {},
    });
    expect(out).toBe("just plain text");
  });
});
