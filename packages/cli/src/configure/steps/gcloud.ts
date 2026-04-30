import { confirm, isCancel, log, note, spinner } from "@clack/prompts";

const TARGET_CONFIG_NAME = "x1agent";

interface GcloudInput {
  account: string;
  projectId: string;
}

/**
 * Set up the `x1agent` gcloud configuration so future gcloud calls
 * from this directory are scoped to the right account + project.
 *
 * Steps:
 *   1. Verify gcloud CLI is installed.
 *   2. Verify the user has at least one logged-in credential. If the
 *      requested account isn't logged in, instruct (don't run) the
 *      auth login — it's a browser flow.
 *   3. Create the `x1agent` configuration if it doesn't exist.
 *   4. Set the account + project on it.
 *
 * Returns true on success, false on user cancel, throws on hard error.
 */
export async function configureGcloud(input: GcloudInput): Promise<boolean> {
  const s = spinner();
  s.start("Checking gcloud CLI…");
  if (!(await gcloudAvailable())) {
    s.stop("gcloud not found.");
    log.error(
      "gcloud CLI is not on PATH. Install it from\n" +
        "  https://cloud.google.com/sdk/docs/install\n" +
        "then re-run this wizard.",
    );
    return false;
  }
  s.stop("gcloud CLI present.");

  s.start("Checking gcloud auth state…");
  const accounts = await listGcloudAccounts();
  s.stop(
    accounts.length === 0
      ? "No gcloud accounts authenticated yet."
      : `Authenticated accounts: ${accounts.join(", ")}`,
  );

  if (!accounts.includes(input.account)) {
    note(
      `The account ${input.account} is not currently logged into gcloud.\n\n` +
        `Run this in another terminal (it opens a browser):\n` +
        `  gcloud auth login ${input.account}\n\n` +
        `Then re-run \`mise run configure\` to finish setup.`,
      "Auth required",
    );
    const proceed = await confirm({
      message:
        "Continue and configure the gcloud configuration now anyway? " +
        "(You'll still need to log in before any gcloud command works.)",
      initialValue: false,
    });
    if (isCancel(proceed) || !proceed) return false;
  }

  // Create the configuration if missing.
  s.start(`Configuring gcloud configuration "${TARGET_CONFIG_NAME}"…`);
  const exists = await gcloudConfigurationExists(TARGET_CONFIG_NAME);
  if (!exists) {
    await runGcloud([
      "config",
      "configurations",
      "create",
      TARGET_CONFIG_NAME,
      "--no-activate",
    ]);
  }
  // --configuration applies to the *target* of the set, so account/project
  // land on the x1agent configuration regardless of what's active.
  await runGcloud([
    "config",
    "set",
    "account",
    input.account,
    `--configuration=${TARGET_CONFIG_NAME}`,
  ]);
  await runGcloud([
    "config",
    "set",
    "project",
    input.projectId,
    `--configuration=${TARGET_CONFIG_NAME}`,
  ]);
  s.stop(`gcloud configuration "${TARGET_CONFIG_NAME}" ready.`);

  note(
    `Configuration "${TARGET_CONFIG_NAME}" now binds:\n` +
      `  account = ${input.account}\n` +
      `  project = ${input.projectId}\n\n` +
      `Inside this directory, .claude/settings.json sets\n` +
      `CLOUDSDK_ACTIVE_CONFIG_NAME=${TARGET_CONFIG_NAME}, so any gcloud\n` +
      `call from Claude Code's Bash tool uses these automatically.`,
    "gcloud configured",
  );
  return true;
}

async function gcloudAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gcloud", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function listGcloudAccounts(): Promise<string[]> {
  const proc = Bun.spawn(
    ["gcloud", "auth", "list", "--format=value(account)"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function gcloudConfigurationExists(name: string): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "gcloud",
      "config",
      "configurations",
      "list",
      "--format=value(name)",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0) return false;
  return out
    .split("\n")
    .map((s) => s.trim())
    .includes(name);
}

async function runGcloud(args: string[]): Promise<void> {
  const proc = Bun.spawn(["gcloud", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`gcloud ${args.join(" ")} failed: ${err}`);
  }
}
