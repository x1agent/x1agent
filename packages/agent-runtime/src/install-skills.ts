import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillSource {
  repository: string;
  ref?: string;
  path?: string;
}

type Run = (command: string, args: string[]) => Promise<void>;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function isSkillDirectory(directory: string): boolean {
  return existsSync(path.join(directory, "SKILL.md"));
}

export function discoverSkillDirectories(sourceDirectory: string): string[] {
  if (isSkillDirectory(sourceDirectory)) return [sourceDirectory];
  const skillsDirectory = path.join(sourceDirectory, "skills");
  if (!existsSync(skillsDirectory)) return [];
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDirectory, entry.name))
    .filter(isSkillDirectory)
    .sort();
}

function assertContainedTree(directory: string, repositoryRoot: string): void {
  const repositoryReal = realpathSync(repositoryRoot);
  const rootPrefix = `${repositoryReal}${path.sep}`;
  const visit = (current: string) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(current);
      if (target !== repositoryReal && !target.startsWith(rootPrefix)) {
        throw new Error(
          `skill contains a symlink outside its repository: ${current}`,
        );
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(current))
        visit(path.join(current, child));
    }
  };
  visit(directory);
}

async function cloneSource(
  source: SkillSource,
  destination: string,
  exec: Run,
) {
  const ref = source.ref?.trim();
  if (!ref) {
    await exec("git", [
      "clone",
      "--depth",
      "1",
      "--",
      source.repository,
      destination,
    ]);
    return;
  }
  try {
    await exec("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      ref,
      "--",
      source.repository,
      destination,
    ]);
  } catch {
    rmSync(destination, { recursive: true, force: true });
    await exec("git", ["init", destination]);
    await exec("git", [
      "-C",
      destination,
      "remote",
      "add",
      "origin",
      source.repository,
    ]);
    await exec("git", [
      "-C",
      destination,
      "fetch",
      "--depth",
      "1",
      "origin",
      ref,
    ]);
    await exec("git", [
      "-C",
      destination,
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
  }
}

export async function installSkillSources(
  sources: SkillSource[],
  options: { homeDir?: string; exec?: Run } = {},
): Promise<string[]> {
  if (sources.length === 0) return [];
  const homeDir = options.homeDir ?? process.env.HOME ?? "/home/agent";
  const destinations = [
    path.join(homeDir, ".claude", "skills"),
    path.join(homeDir, ".agents", "skills"),
  ];
  for (const destination of destinations)
    mkdirSync(destination, { recursive: true });

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "x1agent-skills-"));
  const installed = new Set<string>();
  try {
    for (const [index, source] of sources.entries()) {
      const checkout = path.join(tempRoot, `source-${index}`);
      await cloneSource(source, checkout, options.exec ?? run);
      const relative = source.path?.trim().replace(/^\.\//, "") ?? "";
      const requestedReal = realpathSync(path.resolve(checkout, relative));
      const checkoutReal = realpathSync(checkout);
      if (
        requestedReal !== checkoutReal &&
        !requestedReal.startsWith(`${checkoutReal}${path.sep}`)
      ) {
        throw new Error(`skill path escapes repository: ${relative}`);
      }
      const skills = discoverSkillDirectories(requestedReal);
      if (skills.length === 0) {
        throw new Error(
          `no SKILL.md found at ${source.repository}${relative ? `/${relative}` : ""}`,
        );
      }
      for (const skill of skills) {
        const name = path.basename(skill);
        if (installed.has(name))
          throw new Error(`duplicate skill name: ${name}`);
        assertContainedTree(skill, checkoutReal);
        for (const destination of destinations) {
          cpSync(skill, path.join(destination, name), {
            recursive: true,
            dereference: true,
            errorOnExist: true,
          });
        }
        installed.add(name);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return [...installed];
}

export function parseSkillSourcesJson(raw: string | undefined): SkillSource[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("AGENT_SKILL_SOURCES_JSON must be an array");
  return parsed as SkillSource[];
}

async function main() {
  const installed = await installSkillSources(
    parseSkillSourcesJson(process.env.AGENT_SKILL_SOURCES_JSON),
  );
  if (installed.length > 0)
    console.log(`[skills] installed ${installed.join(", ")}`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`[skills] installation failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
