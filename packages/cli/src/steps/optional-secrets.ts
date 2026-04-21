import { confirm, isCancel, password } from "@clack/prompts";

export interface OptionalSecrets {
  openai: string | null;
  githubPat: string | null;
}

/**
 * OpenAI + GitHub PAT are optional on first install. Each unlocks a
 * feature; missing either doesn't block the rest of the stack.
 *
 *   - OpenAI: required for collections with vector search / embeddings.
 *     Agents still write + read non-vector data without it.
 *   - GitHub PAT: lets agents clone private repos. Public repos work
 *     without credentials.
 *
 * Both can be added later via the web UI — this step exists so the
 * first-run experience doesn't require four trips to the settings
 * page.
 */
export async function promptOptionalSecrets(): Promise<OptionalSecrets | null> {
  const wantOpenai = await confirm({
    message: "Configure an OpenAI API key now? (enables vector embeddings)",
    initialValue: false,
  });
  if (isCancel(wantOpenai)) return null;

  let openai: string | null = null;
  if (wantOpenai) {
    const v = await password({
      message: "OpenAI API key",
      mask: "•",
      validate: (raw) => {
        const t = raw.trim();
        if (!t) return "Empty — skip this step or paste a key.";
        if (!t.startsWith("sk-"))
          return "OpenAI API keys start with 'sk-'.";
        return undefined;
      },
    });
    if (isCancel(v)) return null;
    openai = v.trim();
  }

  const wantGh = await confirm({
    message: "Configure a GitHub personal access token? (for private repos)",
    initialValue: false,
  });
  if (isCancel(wantGh)) return null;

  let githubPat: string | null = null;
  if (wantGh) {
    const v = await password({
      message: "GitHub PAT",
      mask: "•",
      validate: (raw) => {
        const t = raw.trim();
        if (!t) return "Empty — skip this step or paste a token.";
        if (!/^(gh[pousr]_|github_pat_)/.test(t))
          return "GitHub tokens start with 'ghp_', 'gho_', 'github_pat_', etc.";
        return undefined;
      },
    });
    if (isCancel(v)) return null;
    githubPat = v.trim();
  }

  return { openai, githubPat };
}
