import { describe, expect, it } from "bun:test";
import {
  extractLocalImagePaths,
  prepareCodexTurnInput,
} from "./upload-inputs.js";

describe("Codex upload inputs", () => {
  it("extracts and deduplicates raster upload paths", () => {
    const path =
      "/workspace/.x1/uploads/7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11.png";
    expect(extractLocalImagePaths(`inspect ${path}, then ${path}`)).toEqual([
      path,
    ]);
  });

  it("does not attach PDFs or arbitrary workspace paths as images", () => {
    expect(
      extractLocalImagePaths(
        "/workspace/.x1/uploads/7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11.pdf /workspace/secret.png",
      ),
    ).toEqual([]);
  });

  it("fetches an upload through the sidecar and prepares native image input", async () => {
    const id = "7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11";
    const writes: string[] = [];
    const prepared = await prepareCodexTurnInput(`inspect [image: ${id}]`, {
      sidecarUrl: "http://localhost:9090",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            content_b64: Buffer.from("pixels").toString("base64"),
            mime: "image/png",
            size: 6,
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      mkdirImpl: async () => {},
      writeFileImpl: async (filePath) => {
        writes.push(filePath);
      },
      logImpl: () => {},
    });

    const expectedPath = `/workspace/.x1/uploads/${id}.png`;
    expect(writes).toEqual([expectedPath]);
    expect(prepared.text).toContain(expectedPath);
    expect(prepared.localImages).toEqual([expectedPath]);
  });
});
