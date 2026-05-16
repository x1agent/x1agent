import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression: the agent's waitForSidecar() used to probe :9090/health, but
// the sidecar serves /health only on its separate :9091 health listener
// (credentials are on 127.0.0.1:9090). The mismatch wasted 30s per session
// boot and confused orchestrator-side spawn-wait timers. Lock the two
// values together so a port change on either side trips this test.

describe("sidecar health port alignment", () => {
  const agentRun = readFileSync(
    join(__dirname, "run.ts"),
    "utf8",
  );
  const sidecarMain = readFileSync(
    join(__dirname, "../../sidecar/src/main.rs"),
    "utf8",
  );

  it("agent waitForSidecar fetches sidecarHealthUrl (not the credentials URL)", () => {
    expect(agentRun).toMatch(/fetch\(`\$\{sidecarHealthUrl\}\/health`\)/);
    expect(agentRun).not.toMatch(/fetch\(`\$\{sidecarUrl\}\/health`\)/);
  });

  it("agent sidecarHealthUrl defaults to :9091", () => {
    expect(agentRun).toMatch(
      /sidecarHealthUrl\s*=\s*[^;]*"http:\/\/localhost:9091"/,
    );
  });

  it("sidecar binds its health listener on :9091", () => {
    expect(sidecarMain).toMatch(/bind\("0\.0\.0\.0:9091"\)/);
  });
});
