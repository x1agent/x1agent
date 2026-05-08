import { describe, it, expect } from "bun:test";
import { DockerfileSource, dockerfileHash } from "./dockerfile-source.js";
import { ValidationError } from "@x1agent/kernel";

describe("DockerfileSource", () => {
  it("accepts a minimal FROM-only Dockerfile", () => {
    expect(() =>
      DockerfileSource("FROM x1agent/runtime-core:v1\n"),
    ).not.toThrow();
  });

  it("accepts a realistic preset-style Dockerfile", () => {
    const src = `
      FROM python:3.13-slim-bookworm
      ARG AGENT_OVERLAY=x1agent/runtime-core:v1
      COPY --from=x1agent/runtime-core:v1 /x1 /x1
      RUN apt-get update && apt-get install -y --no-install-recommends \\
            git curl ca-certificates \\
        && rm -rf /var/lib/apt/lists/*
      USER 1000
      ENV HOME=/home/agent
      ENV PATH="/x1/bin:\${PATH}"
      WORKDIR /workspace
      ENTRYPOINT ["/x1/bin/entrypoint"]
    `;
    expect(() => DockerfileSource(src)).not.toThrow();
  });

  it("rejects empty source", () => {
    expect(() => DockerfileSource("")).toThrow(ValidationError);
    expect(() => DockerfileSource("   \n   \n")).toThrow(ValidationError);
  });

  it("rejects source that doesn't start with FROM (or pre-FROM ARG)", () => {
    expect(() => DockerfileSource("RUN echo hi")).toThrow(ValidationError);
  });

  it("accepts ARG before FROM", () => {
    expect(() =>
      DockerfileSource(
        "ARG BASE=python:3.13\nFROM \\\${BASE}\nRUN echo hi\n".replace(
          "\\\\",
          "\\",
        ),
      ),
    ).not.toThrow();
  });

  it("rejects local COPY (no build context)", () => {
    expect(() =>
      DockerfileSource("FROM scratch\nCOPY ./bin /bin\n"),
    ).toThrow(ValidationError);
  });

  it("accepts COPY --from=<image>", () => {
    expect(() =>
      DockerfileSource(
        "FROM scratch\nCOPY --from=x1agent/runtime-core:v1 /x1 /x1\n",
      ),
    ).not.toThrow();
  });

  it("rejects ADD", () => {
    expect(() =>
      DockerfileSource("FROM scratch\nADD https://example.com/foo /foo\n"),
    ).toThrow(ValidationError);
  });

  it("rejects unknown directive", () => {
    expect(() =>
      DockerfileSource("FROM scratch\nMAGIC do-something\n"),
    ).toThrow(ValidationError);
  });

  it("ignores comments and blank lines", () => {
    expect(() =>
      DockerfileSource("# top comment\n\nFROM scratch\n# inline\nRUN true\n"),
    ).not.toThrow();
  });

  it("rejects oversized Dockerfile", () => {
    const huge = "FROM scratch\n" + "RUN true\n".repeat(10_000);
    expect(() => DockerfileSource(huge)).toThrow(ValidationError);
  });

  describe("dockerfileHash", () => {
    it("is stable for the same input", () => {
      const a = DockerfileSource("FROM scratch\nRUN true\n");
      expect(dockerfileHash(a)).toBe(dockerfileHash(a));
    });
    it("changes when content changes", () => {
      const a = DockerfileSource("FROM scratch\nRUN true\n");
      const b = DockerfileSource("FROM scratch\nRUN false\n");
      expect(dockerfileHash(a)).not.toBe(dockerfileHash(b));
    });
    it("returns hex sha256 (64 chars)", () => {
      const a = DockerfileSource("FROM scratch\n");
      expect(dockerfileHash(a)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
