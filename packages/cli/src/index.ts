#!/usr/bin/env bun
import { intro, log, outro, cancel } from "@clack/prompts";
import { runSetup } from "./steps/setup.ts";
import { runConfigure } from "./configure/index.ts";
import { runCheck } from "./configure/check.ts";
import { runInstall, type InstallAction } from "./install/index.ts";
import { runDeploy, parseDeployArgs } from "./deploy/index.ts";
import { runLogs } from "./logs/index.ts";
import { runDeployments } from "./deployments/index.ts";

const subcommand = process.argv[2] ?? "setup";

async function main() {
  switch (subcommand) {
    case "setup": {
      intro("x1agent setup");
      try {
        const ok = await runSetup();
        if (!ok) {
          cancel("Setup cancelled. No changes applied.");
          process.exit(1);
        }
        outro("Done.");
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
      return;
    }
    case "configure": {
      try {
        const ok = await runConfigure();
        process.exit(ok ? 0 : 1);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
      return;
    }
    case "configure:check": {
      // Synchronous result; exits with the proper code for use as a
      // mise `depends` gate on terraform/install tasks.
      process.exit(runCheck());
    }
    case "install":
    case "install:plan":
    case "install:apply":
    case "install:status":
    case "install:destroy":
    case "install:render-tfvars": {
      // Bare `install` runs the full orchestrator; `install:<x>` runs
      // a single phase. Default the bare form to the "up" action.
      const action = (subcommand === "install"
        ? "up"
        : subcommand.split(":")[1]) as InstallAction;
      const autoConfirm = process.argv.slice(3).includes("--yes");
      try {
        const ok = await runInstall(action, { autoConfirm });
        process.exit(ok ? 0 : 1);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
      return;
    }
    case "deploy": {
      try {
        const ok = await runDeploy(parseDeployArgs(process.argv.slice(3)));
        process.exit(ok ? 0 : 1);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
      return;
    }
    case "logs": {
      try {
        const code = await runLogs(process.argv.slice(3));
        process.exit(code);
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
      return;
    }
    case "deployments": {
      // Read-only listing — no header, no resolver, just enumerate
      // installs/. Used by `mise run deployments`.
      process.exit(runDeployments());
    }
    case "tfstate-path": {
      // Resolve the active deployment and print its terraform state
      // path. Used by mise.toml `terraform:prod:*` tasks to inject
      // -state=<path> into raw `terraform` invocations so two
      // deployments can coexist without clobbering each other.
      // Stdout-only (path), stderr for any errors so callers can do
      // `STATE=$(bun run src/index.ts tfstate-path)`.
      try {
        const { defaultPaths } = await import("./install/render.ts");
        process.stdout.write(defaultPaths().tfStatePath + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(`tfstate-path: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
    default: {
      console.error(`Unknown command: ${subcommand}`);
      console.error(
        "Usage: x1 (setup | configure | configure:check | deployments | install [| install:<phase>] | deploy [--yes] [--tag <sha>] [--skip-build] | logs [<component>] [flags])",
      );
      process.exit(2);
    }
  }
}

main();
