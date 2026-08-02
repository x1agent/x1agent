import { DomainError } from "@x1agent/kernel";

export interface AgentSkillSource {
  /** Canonical public GitHub repository URL (no credentials or query string). */
  repository: string;
  /** Branch, tag, or commit. Defaults to the repository's default branch. */
  ref: string;
  /** Repo-relative skill/plugin directory. Empty means repository root. */
  path: string;
}

export class InvalidAgentSkillSourceError extends DomainError {
  readonly code = "invalid_agent_skill_source";
  constructor(message: string) {
    super(message);
  }
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function parseAgentSkillSources(raw: unknown): AgentSkillSource[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InvalidAgentSkillSourceError("skill_sources must be an array");
  }
  if (raw.length > 20) {
    throw new InvalidAgentSkillSourceError(
      "an agent can reference at most 20 skill repositories",
    );
  }

  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new InvalidAgentSkillSourceError(
        `skill_sources[${index}] must be an object`,
      );
    }
    const value = item as Record<string, unknown>;
    const repository = String(value.repository ?? "")
      .trim()
      .replace(/\/$/, "");
    let url: URL;
    try {
      url = new URL(repository);
    } catch {
      throw new InvalidAgentSkillSourceError(
        `skill_sources[${index}].repository must be a GitHub URL`,
      );
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)
    ) {
      throw new InvalidAgentSkillSourceError(
        `skill_sources[${index}].repository must be https://github.com/<owner>/<repo>`,
      );
    }

    const ref = String(value.ref ?? "").trim();
    if (
      ref &&
      (!SAFE_REF.test(ref) || ref.includes("..") || ref.endsWith("/"))
    ) {
      throw new InvalidAgentSkillSourceError(
        `skill_sources[${index}].ref is not a safe git ref`,
      );
    }

    const sourcePath = String(value.path ?? "")
      .trim()
      .replace(/^\.\//, "");
    if (
      sourcePath.startsWith("/") ||
      sourcePath.split("/").some((part) => part === "..") ||
      sourcePath.includes("\\")
    ) {
      throw new InvalidAgentSkillSourceError(
        `skill_sources[${index}].path must stay inside the repository`,
      );
    }

    return { repository, ref, path: sourcePath.replace(/\/$/, "") };
  });
}
