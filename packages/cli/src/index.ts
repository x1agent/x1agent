#!/usr/bin/env bun
import { intro, log, outro, cancel } from "@clack/prompts";
import { runSetup } from "./steps/setup.ts";

const subcommand = process.argv[2] ?? "setup";

async function main() {
  if (subcommand !== "setup") {
    console.error(`Unknown command: ${subcommand}`);
    console.error("Usage: x1 setup");
    process.exit(2);
  }

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
}

main();
