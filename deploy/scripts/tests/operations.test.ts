import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;
const MISE = readFileSync(join(ROOT, "mise.toml"), "utf8");

const operationScripts = [
  "backup-prod.sh",
  "destroy-prod-cluster.sh",
  "install-local-k3s.sh",
  "install-local-surrealdb.sh",
  "restore-prod.sh",
];

test("every new mise operation has an executable implementation", () => {
  for (const name of operationScripts) {
    const path = join(ROOT, "deploy/scripts", name);
    expect(statSync(path).isFile()).toBe(true);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(MISE).toContain(`deploy/scripts/${name}`);
  }
});

test("cluster deletion does not replace the existing Helm uninstall task", () => {
  expect(MISE).toContain('[tasks."install:prod:destroy"]');
  expect(MISE).toContain('run = "cd packages/cli && bun run src/index.ts install:destroy"');
  expect(MISE).toContain('[tasks."install:prod:destroy-cluster"]');
  expect(MISE).toContain('run = "deploy/scripts/destroy-prod-cluster.sh"');
});

test("Codex images build from the repository context", () => {
  const publishBlock = MISE.slice(
    MISE.indexOf('echo "[images] building runtime-codex:v1"'),
    MISE.indexOf('for P in $PRESETS'),
  );
  expect(publishBlock).toContain("-f packages/agent-codex/Dockerfile");
  const publishLines = publishBlock.split("\n");
  const loadLine = publishLines.findIndex((line) => line.trimStart().startsWith("--load"));
  expect(loadLine).toBeGreaterThanOrEqual(0);
  expect(publishLines[loadLine + 1]?.trim()).toBe(".");

  const installer = readFileSync(join(ROOT, "deploy/scripts/install-local-k3s.sh"), "utf8");
  expect(installer).toContain("packages/agent-claude/Dockerfile");
  expect(installer).toContain("packages/agent-codex/Dockerfile");
  expect(installer).not.toContain("packages/agent/Dockerfile");
  expect(installer).toContain('HOST_CODEX_HOME_DIR="$CODEX_PROFILE_DIR"');
  expect(installer).toContain('HOST_CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"');
});

test("local Traefik ingress exposes the administrative MCP resource", () => {
  const ingress = readFileSync(
    join(ROOT, "deploy/k8s/dev/ingress-traefik-local.yaml.template"),
    "utf8",
  );
  expect(ingress).toContain("path: /mcp");
  expect(ingress).toContain("path: /.well-known/oauth-protected-resource");
});

test("production operation scripts refuse an implicit deployment", async () => {
  for (const name of ["backup-prod.sh", "destroy-prod-cluster.sh", "restore-prod.sh"]) {
    const env = { ...process.env };
    delete env.X1AGENT_DEPLOYMENT;
    const proc = Bun.spawn([join(ROOT, "deploy/scripts", name)], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("refusing to guess between installs");
  }
});

test("restore validates target identity and checksums before mutation", () => {
  const restore = readFileSync(join(ROOT, "deploy/scripts/restore-prod.sh"), "utf8");
  expect(restore).toContain("does not match target");
  expect(restore).toContain("shasum -a 256 --check --status");
  expect(restore.indexOf("verifying backup checksums")).toBeLessThan(
    restore.indexOf("gcloud container clusters get-credentials"),
  );
});

test("backup and restore preserve a caller-owned kubeconfig", async () => {
  const temp = mkdtempSync(join(tmpdir(), "x1agent-operations-"));
  const bin = join(temp, "bin");
  const backupRoot = join(temp, "backups");
  const kubeconfig = join(temp, "caller-kubeconfig");
  const backupKey = join(temp, "backup.key");
  const deployment = `operations-test-${process.pid}-${Date.now()}.example`;
  const installFile = join(ROOT, "installs", `${deployment}.local`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(ROOT, "installs"), { recursive: true });
  writeFileSync(kubeconfig, "caller-owned\n", { mode: 0o600 });
  writeFileSync(backupKey, "test-key\n", { mode: 0o600 });
  writeFileSync(
    installFile,
    [
      "GCP_PROJECT_ID=test-project",
      "GCP_REGION=us-east1",
      "GKE_CLUSTER_NAME=test-cluster",
      "K8S_NAMESPACE=x1agent",
      "",
    ].join("\n"),
  );

  const mock = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  };
  mock("gcloud", "exit 0");
  mock("curl", "exit 0");
  mock("jq", "cat");
  mock("openssl", "exit 0");
  mock(
    "gpg",
    `
if [[ " $* " == *" --decrypt "* ]]; then
  cat "\${@: -1}"
  exit 0
fi
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi
done
[[ -n "$out" ]]
cat > "$out"
`,
  );
  mock(
    "kubectl",
    `
args="$*"
if [[ "$args" == *"get service surrealdb"* ]]; then exit 1; fi
if [[ "$args" == *"SELECT datname FROM pg_database"* ]]; then
  printf 'postgres\\nx1agent\\n'
elif [[ "$args" == *"pg_dumpall"* ]]; then
  printf '%s\\n' '-- globals'
elif [[ "$args" == *" pg_dump "* ]]; then
  printf '%s\\n' 'mock dump'
elif [[ "$args" == *"get secrets -o json"* ]]; then
  printf '%s\\n' '{"items":[]}'
elif [[ "$args" == *"SELECT 1 FROM pg_database"* ]]; then
  printf '1\\n'
elif [[ "$args" == *"apply -f -"* || "$args" == *"pg_restore"* || "$args" == *"ON_ERROR_STOP"* ]]; then
  cat >/dev/null
fi
exit 0
`,
  );

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    X1AGENT_DEPLOYMENT: deployment,
    X1AGENT_BACKUP_DIR: backupRoot,
    X1AGENT_BACKUP_KEY: backupKey,
    X1AGENT_BACKUP_KUBECONFIG: kubeconfig,
  };

  try {
    const backup = Bun.spawn([join(ROOT, "deploy/scripts/backup-prod.sh")], {
      cwd: ROOT,
      env: baseEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [backupExit, backupOut, backupErr] = await Promise.all([
      backup.exited,
      new Response(backup.stdout).text(),
      new Response(backup.stderr).text(),
    ]);
    expect(backupExit, backupErr).toBe(0);
    expect(backupOut).toContain("SurrealDB service is not installed; skipping it");
    expect(readFileSync(kubeconfig, "utf8")).toBe("caller-owned\n");

    const [stamp] = readdirSync(backupRoot);
    expect(stamp).toBeDefined();
    const restore = Bun.spawn(
      [join(ROOT, "deploy/scripts/restore-prod.sh"), join(backupRoot, stamp!)],
      {
        cwd: ROOT,
        env: {
          ...baseEnv,
          X1AGENT_RESTORE_KUBECONFIG: kubeconfig,
          X1AGENT_RESTORE_YES: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [restoreExit, restoreErr] = await Promise.all([
      restore.exited,
      new Response(restore.stderr).text(),
    ]);
    expect(
      restoreExit,
      `${restoreErr}\nmanifest:\n${readFileSync(join(backupRoot, stamp!, "manifest.txt"), "utf8")}`,
    ).toBe(0);
    expect(readFileSync(kubeconfig, "utf8")).toBe("caller-owned\n");
  } finally {
    rmSync(installFile, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
