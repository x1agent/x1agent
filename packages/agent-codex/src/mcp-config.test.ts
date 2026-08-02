import { describe, expect, it } from "bun:test";
import {
  buildPlatformMcpDefinitions,
  parseRemoteMcpAttachments,
  renderCodexMcpConfig,
} from "./mcp-config.js";

describe("Codex MCP configuration", () => {
  it("registers every always-on MCP exposed by the Claude harness", () => {
    const servers = buildPlatformMcpDefinitions({
      tsxPath: "tsx",
      sourceDir: "/app/src",
      sidecarUrl: "http://localhost:9090",
      resolvePath: (dir, file) => `${dir}/${file}`,
    });
    expect(servers.map((server) => server.name)).toEqual([
      "x1agent",
      "files",
      "sheets",
      "docs",
      "calendar",
      "email",
    ]);
  });

  it("renders standard stdio servers and remote OAuth proxy attachments", () => {
    const config = renderCodexMcpConfig(
      [
        {
          name: "x1agent",
          command: "/usr/bin/tsx",
          args: ["/app/src/x1-mcp.ts"],
          env: { SIDECAR_URL: "http://localhost:9090" },
        },
        {
          name: "files",
          command: "/usr/bin/tsx",
          args: ["/app/src/files-mcp.ts"],
          env: { SIDECAR_URL: "http://localhost:9090" },
        },
      ],
      [{ name: "linear-prod", url: "http://127.0.0.1:9400" }],
    );

    expect(config).toContain('[mcp_servers."x1agent"]');
    expect(config).toContain('[mcp_servers."files"]');
    expect(config).toContain('[mcp_servers."linear-prod"]');
    expect(config).toContain('url = "http://127.0.0.1:9400"');
    expect(config).not.toContain("bearer");
  });

  it("accepts only localhost proxy URLs and safely rejects malformed JSON", () => {
    const parsed = parseRemoteMcpAttachments(
      JSON.stringify([
        { name: "notion", url: "http://127.0.0.1:9401" },
        { name: "unsafe", url: "https://example.com/mcp" },
        { name: "missing-url" },
      ]),
    );
    expect(parsed).toEqual([{ name: "notion", url: "http://127.0.0.1:9401" }]);

    const warnings: string[] = [];
    expect(parseRemoteMcpAttachments("{", (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("does not let a remote attachment shadow a platform MCP", () => {
    const config = renderCodexMcpConfig(
      [
        {
          name: "x1agent",
          command: "tsx",
          args: ["x1-mcp.ts"],
          env: {},
        },
      ],
      [{ name: "x1agent", url: "http://127.0.0.1:9400" }],
    );
    expect(config.match(/\[mcp_servers\."x1agent"\]/g)).toHaveLength(1);
    expect(config).not.toContain("127.0.0.1:9400");
  });
});
