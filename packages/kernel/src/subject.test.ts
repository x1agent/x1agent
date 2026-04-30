import { describe, it, expect } from "bun:test";
import {
  isSubjectKind,
  makeSubject,
  subjectKey,
  InvalidSubjectError,
} from "./subject.js";

describe("isSubjectKind", () => {
  it("accepts the 4 valid kinds", () => {
    for (const k of ["user", "group", "workspace", "public"]) {
      expect(isSubjectKind(k)).toBe(true);
    }
  });
  it("rejects everything else", () => {
    expect(isSubjectKind("admin")).toBe(false);
    expect(isSubjectKind("USER")).toBe(false);
    expect(isSubjectKind("")).toBe(false);
  });
});

describe("makeSubject", () => {
  it("builds user/group with an id", () => {
    expect(makeSubject("user", "abc")).toEqual({ kind: "user", id: "abc" });
    expect(makeSubject("group", "def")).toEqual({ kind: "group", id: "def" });
  });
  it("builds workspace/public with id=null", () => {
    expect(makeSubject("workspace", null)).toEqual({
      kind: "workspace",
      id: null,
    });
    expect(makeSubject("public", null)).toEqual({ kind: "public", id: null });
  });
  it("rejects user/group without an id", () => {
    expect(() => makeSubject("user", null)).toThrow(InvalidSubjectError);
    expect(() => makeSubject("group", null)).toThrow(InvalidSubjectError);
  });
  it("rejects workspace/public WITH an id", () => {
    expect(() => makeSubject("workspace", "abc")).toThrow(InvalidSubjectError);
    expect(() => makeSubject("public", "abc")).toThrow(InvalidSubjectError);
  });
  it("rejects unknown kinds", () => {
    expect(() => makeSubject("admin", "x")).toThrow(InvalidSubjectError);
  });
});

describe("subjectKey", () => {
  it("renders kind:id for user/group, just kind for workspace/public", () => {
    expect(subjectKey(makeSubject("user", "abc"))).toBe("user:abc");
    expect(subjectKey(makeSubject("group", "g1"))).toBe("group:g1");
    expect(subjectKey(makeSubject("workspace", null))).toBe("workspace");
    expect(subjectKey(makeSubject("public", null))).toBe("public");
  });
});
