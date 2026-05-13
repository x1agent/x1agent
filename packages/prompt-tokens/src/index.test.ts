import { describe, expect, test } from "bun:test";
import {
  extractImageIds,
  MAX_IMAGE_TOKENS_PER_MESSAGE,
  parsePromptTokens,
  serializePromptTokens,
  truncateImageTokens,
  type Part,
} from "./index.js";

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_C = "01900000-9999-7abc-8def-000000000001"; // v7-shape
const UUID_D = "deadbeef-0000-1111-2222-cafebabecafe";
const UUID_E = "feedface-3333-4444-5555-666677778888";

describe("parsePromptTokens", () => {
  test("empty string yields no parts", () => {
    expect(parsePromptTokens("")).toEqual([]);
  });

  test("plain text with no tokens is a single text part", () => {
    expect(parsePromptTokens("hello world")).toEqual([
      { kind: "text", value: "hello world" },
    ]);
  });

  test("a single image token with no surrounding text", () => {
    expect(parsePromptTokens(`[image: ${UUID_A}]`)).toEqual([
      { kind: "image", uploadId: UUID_A },
    ]);
  });

  test("tokens at start, middle, and end mixed with text", () => {
    const text = `[image: ${UUID_A}] middle [image: ${UUID_B}] end [image: ${UUID_C}]`;
    expect(parsePromptTokens(text)).toEqual([
      { kind: "image", uploadId: UUID_A },
      { kind: "text", value: " middle " },
      { kind: "image", uploadId: UUID_B },
      { kind: "text", value: " end " },
      { kind: "image", uploadId: UUID_C },
    ]);
  });

  test("multiple adjacent image tokens", () => {
    const text = `[image: ${UUID_A}][image: ${UUID_B}]`;
    expect(parsePromptTokens(text)).toEqual([
      { kind: "image", uploadId: UUID_A },
      { kind: "image", uploadId: UUID_B },
    ]);
  });

  test("uppercase hex parses (case-insensitive UUID)", () => {
    const up = UUID_A.toUpperCase();
    expect(parsePromptTokens(`[image: ${up}]`)).toEqual([
      { kind: "image", uploadId: up },
    ]);
  });

  test("malformed token (non-UUID id) is treated as plain text", () => {
    const text = "[image: not-a-uuid] and [image: 1234]";
    expect(parsePromptTokens(text)).toEqual([
      { kind: "text", value: text },
    ]);
  });

  test("malformed token (missing space after colon) is plain text", () => {
    const text = `[image:${UUID_A}]`;
    expect(parsePromptTokens(text)).toEqual([
      { kind: "text", value: text },
    ]);
  });

  test("malformed token (double space after colon) is plain text", () => {
    const text = `[image:  ${UUID_A}]`;
    expect(parsePromptTokens(text)).toEqual([
      { kind: "text", value: text },
    ]);
  });

  test("escaped token (leading backslash) is plain text and preserves the backslash", () => {
    const text = `before \\[image: ${UUID_A}] after`;
    const parts = parsePromptTokens(text);
    // The backslash forces the bracketed sequence to be literal text,
    // so the whole input collapses to a single text part.
    expect(parts).toEqual([{ kind: "text", value: text }]);
  });

  test("mixed escaped + unescaped tokens", () => {
    const text = `\\[image: ${UUID_A}] [image: ${UUID_B}]`;
    expect(parsePromptTokens(text)).toEqual([
      { kind: "text", value: `\\[image: ${UUID_A}] ` },
      { kind: "image", uploadId: UUID_B },
    ]);
  });

  test("reserved kinds (file, audio, video) parse as kind=unknown and round-trip", () => {
    const text = `[file: ${UUID_A}] [audio: ${UUID_B}] [video: ${UUID_C}]`;
    const parts = parsePromptTokens(text);
    expect(parts).toEqual([
      { kind: "unknown", raw: `[file: ${UUID_A}]` },
      { kind: "text", value: " " },
      { kind: "unknown", raw: `[audio: ${UUID_B}]` },
      { kind: "text", value: " " },
      { kind: "unknown", raw: `[video: ${UUID_C}]` },
    ]);
  });

  test("unknown kind (e.g. [pdf: ...]) is plain text, not unknown-part", () => {
    // Only the four reserved kinds get the unknown-part treatment. Anything
    // else stays raw text so we don't quietly absorb future grammar that
    // hasn't been negotiated.
    const text = `[pdf: ${UUID_A}]`;
    expect(parsePromptTokens(text)).toEqual([
      { kind: "text", value: text },
    ]);
  });

  test("does not throw on adversarial inputs", () => {
    const inputs = [
      "[",
      "]",
      "[image:",
      "[image: ]",
      "[image: 11111111-2222-3333-4444-55555555555]", // one char short
      `[image: ${UUID_A}`,
      "][[[",
      "\\\\",
      "\\\\[image: " + UUID_A + "]", // double-escaped backslash; first \ escapes the second \, leaving an unescaped token? We test "doesn't throw"; behavior is asserted below.
    ];
    for (const s of inputs) {
      expect(() => parsePromptTokens(s)).not.toThrow();
      expect(() => serializePromptTokens(parsePromptTokens(s))).not.toThrow();
    }
  });
});

describe("serializePromptTokens", () => {
  test("empty parts yields empty string", () => {
    expect(serializePromptTokens([])).toBe("");
  });

  test("renders text, image, and unknown parts in order", () => {
    const parts: Part[] = [
      { kind: "text", value: "hi " },
      { kind: "image", uploadId: UUID_A },
      { kind: "text", value: " " },
      { kind: "unknown", raw: `[file: ${UUID_B}]` },
    ];
    expect(serializePromptTokens(parts)).toBe(
      `hi [image: ${UUID_A}] [file: ${UUID_B}]`,
    );
  });
});

describe("round-trip identity: serialize(parse(x)) === x", () => {
  const cases: string[] = [
    "",
    "hello world",
    `[image: ${UUID_A}]`,
    `prefix [image: ${UUID_A}] suffix`,
    `[image: ${UUID_A}] [image: ${UUID_B}] [image: ${UUID_C}]`,
    `[image: ${UUID_A}][image: ${UUID_B}]`,
    `[file: ${UUID_A}] [audio: ${UUID_B}] [video: ${UUID_C}]`,
    `\\[image: ${UUID_A}] (escaped) and [image: ${UUID_B}] (real)`,
    `mixed [image: ${UUID_A.toUpperCase()}] uppercase`,
    "[image: not-a-uuid] (malformed)",
    "[image:no-space-yes-uuid-but-no-space]",
    "trailing backslash \\",
    "weird ]][[ chars",
  ];

  for (const text of cases) {
    test(`round-trips: ${JSON.stringify(text).slice(0, 60)}`, () => {
      expect(serializePromptTokens(parsePromptTokens(text))).toBe(text);
    });
  }
});

describe("idempotency: parse(serialize(parse(x))) === parse(x)", () => {
  const cases: string[] = [
    "",
    "plain",
    `[image: ${UUID_A}] hi [image: ${UUID_B}]`,
    `[file: ${UUID_A}] [image: ${UUID_B}]`,
    `\\[image: ${UUID_A}]`,
    "[image: not-a-uuid]",
  ];
  for (const text of cases) {
    test(`idempotent: ${JSON.stringify(text).slice(0, 60)}`, () => {
      const once = parsePromptTokens(text);
      const twice = parsePromptTokens(serializePromptTokens(once));
      expect(twice).toEqual(once);
    });
  }
});

describe("extractImageIds", () => {
  test("returns empty array when there are no image tokens", () => {
    expect(extractImageIds("hello [file: " + UUID_A + "]")).toEqual([]);
    expect(extractImageIds("")).toEqual([]);
  });

  test("preserves document order and duplicates", () => {
    const text = `[image: ${UUID_A}] [image: ${UUID_B}] [image: ${UUID_A}]`;
    expect(extractImageIds(text)).toEqual([UUID_A, UUID_B, UUID_A]);
  });

  test("ignores reserved-kind and malformed tokens", () => {
    const text = `[file: ${UUID_A}] [image: ${UUID_B}] [image: not-a-uuid]`;
    expect(extractImageIds(text)).toEqual([UUID_B]);
  });

  test("ignores escaped tokens", () => {
    const text = `\\[image: ${UUID_A}] [image: ${UUID_B}]`;
    expect(extractImageIds(text)).toEqual([UUID_B]);
  });
});

describe("truncateImageTokens", () => {
  test("no-op when count <= max", () => {
    const text = `[image: ${UUID_A}] [image: ${UUID_B}]`;
    expect(truncateImageTokens(text)).toEqual({ text, truncated: 0 });
  });

  test("drops trailing image tokens past max (default 4) and reports count", () => {
    const text =
      `[image: ${UUID_A}] [image: ${UUID_B}] [image: ${UUID_C}] ` +
      `[image: ${UUID_D}] [image: ${UUID_E}]`;
    const result = truncateImageTokens(text);
    expect(result.truncated).toBe(1);
    // The first four images are kept; the fifth is removed but the
    // surrounding text spacers remain (serializer doesn't collapse).
    expect(extractImageIds(result.text)).toEqual([
      UUID_A,
      UUID_B,
      UUID_C,
      UUID_D,
    ]);
  });

  test("respects explicit max", () => {
    const text =
      `[image: ${UUID_A}] [image: ${UUID_B}] [image: ${UUID_C}]`;
    const result = truncateImageTokens(text, 1);
    expect(result.truncated).toBe(2);
    expect(extractImageIds(result.text)).toEqual([UUID_A]);
  });

  test("max=0 removes every image token", () => {
    const text = `[image: ${UUID_A}] keep [image: ${UUID_B}]`;
    const result = truncateImageTokens(text, 0);
    expect(result.truncated).toBe(2);
    expect(extractImageIds(result.text)).toEqual([]);
    // Text portion is preserved verbatim (including the spaces that
    // surrounded the dropped tokens).
    expect(result.text).toBe(" keep ");
  });

  test("negative max is clamped to 0", () => {
    const text = `[image: ${UUID_A}]`;
    expect(truncateImageTokens(text, -5)).toEqual({
      text: "",
      truncated: 1,
    });
  });

  test("reserved (file/audio/video) and text are untouched", () => {
    const text = `[file: ${UUID_A}] hi [image: ${UUID_B}]`;
    const result = truncateImageTokens(text, 0);
    expect(result.truncated).toBe(1);
    expect(result.text).toBe(`[file: ${UUID_A}] hi `);
  });

  test("default cap matches the documented constant", () => {
    expect(MAX_IMAGE_TOKENS_PER_MESSAGE).toBe(4);
  });
});
