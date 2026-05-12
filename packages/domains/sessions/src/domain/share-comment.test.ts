import { describe, expect, it } from "bun:test";
import {
  AnchorForbiddenError,
  AnchorRequiredError,
  CommentBodyTooLongError,
  EmptyCommentBodyError,
  InvalidScopeForShareTypeError,
  MAX_COMMENT_BODY_LEN,
  ShareTypeNotCommentableError,
  assertValidCommentInput,
  isCommentScope,
  isCommentableShareType,
  supportsPassageAnchors,
  type PassageAnchor,
} from "./share-comment.js";

const goodAnchor: PassageAnchor = {
  selection: {
    start_line: 1,
    start_col: 0,
    end_line: 1,
    end_col: 10,
    quoted_text: "selected",
  },
};

describe("isCommentScope", () => {
  it("accepts passage and share", () => {
    expect(isCommentScope("passage")).toBe(true);
    expect(isCommentScope("share")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isCommentScope("")).toBe(false);
    expect(isCommentScope("global")).toBe(false);
  });
});

describe("isCommentableShareType", () => {
  it("accepts markdown and html share types only in v1", () => {
    expect(isCommentableShareType("document")).toBe(true);
    expect(isCommentableShareType("site")).toBe(true);
    for (const t of [
      "image",
      "svg",
      "csv",
      "json",
      "code",
      "archive",
      "file",
    ]) {
      expect(isCommentableShareType(t)).toBe(false);
    }
  });
});

describe("supportsPassageAnchors", () => {
  it("only markdown supports per-passage anchors", () => {
    expect(supportsPassageAnchors("document")).toBe(true);
    expect(supportsPassageAnchors("site")).toBe(false);
  });
});

describe("assertValidCommentInput", () => {
  it("accepts passage on markdown with a valid anchor", () => {
    assertValidCommentInput({
      body: "hi",
      scope: "passage",
      anchor: goodAnchor,
      shareType: "document",
    });
  });

  it("accepts share on markdown with no anchor", () => {
    assertValidCommentInput({
      body: "hi",
      scope: "share",
      anchor: null,
      shareType: "document",
    });
  });

  it("accepts share on html with no anchor", () => {
    assertValidCommentInput({
      body: "hi",
      scope: "share",
      anchor: null,
      shareType: "site",
    });
  });

  it("rejects passage on html (no in-iframe anchoring in v1)", () => {
    expect(() =>
      assertValidCommentInput({
        body: "hi",
        scope: "passage",
        anchor: goodAnchor,
        shareType: "site",
      }),
    ).toThrow(InvalidScopeForShareTypeError);
  });

  it("rejects non-commentable share types entirely", () => {
    for (const t of ["image", "svg", "csv", "json", "code"]) {
      expect(() =>
        assertValidCommentInput({
          body: "hi",
          scope: "share",
          anchor: null,
          shareType: t,
        }),
      ).toThrow(ShareTypeNotCommentableError);
    }
  });

  it("requires anchor for passage scope", () => {
    expect(() =>
      assertValidCommentInput({
        body: "hi",
        scope: "passage",
        anchor: null,
        shareType: "document",
      }),
    ).toThrow(AnchorRequiredError);
  });

  it("forbids anchor on share scope", () => {
    expect(() =>
      assertValidCommentInput({
        body: "hi",
        scope: "share",
        anchor: goodAnchor,
        shareType: "document",
      }),
    ).toThrow(AnchorForbiddenError);
  });

  it("rejects an empty body", () => {
    expect(() =>
      assertValidCommentInput({
        body: "   ",
        scope: "share",
        anchor: null,
        shareType: "document",
      }),
    ).toThrow(EmptyCommentBodyError);
  });

  it("rejects an over-long body", () => {
    expect(() =>
      assertValidCommentInput({
        body: "x".repeat(MAX_COMMENT_BODY_LEN + 1),
        scope: "share",
        anchor: null,
        shareType: "document",
      }),
    ).toThrow(CommentBodyTooLongError);
  });

  it("rejects a malformed anchor (negative line)", () => {
    expect(() =>
      assertValidCommentInput({
        body: "hi",
        scope: "passage",
        anchor: {
          selection: {
            start_line: -1,
            start_col: 0,
            end_line: 1,
            end_col: 0,
            quoted_text: "x",
          },
        },
        shareType: "document",
      }),
    ).toThrow(AnchorRequiredError);
  });

  it("rejects an anchor whose end precedes its start", () => {
    expect(() =>
      assertValidCommentInput({
        body: "hi",
        scope: "passage",
        anchor: {
          selection: {
            start_line: 5,
            start_col: 0,
            end_line: 2,
            end_col: 0,
            quoted_text: "x",
          },
        },
        shareType: "document",
      }),
    ).toThrow(AnchorRequiredError);
  });

  it("rejects an anchor with empty quoted_text", () => {
    expect(() =>
      assertValidCommentInput({
        body: "hi",
        scope: "passage",
        anchor: {
          selection: {
            start_line: 1,
            start_col: 0,
            end_line: 1,
            end_col: 0,
            quoted_text: "",
          },
        },
        shareType: "document",
      }),
    ).toThrow(AnchorRequiredError);
  });
});
