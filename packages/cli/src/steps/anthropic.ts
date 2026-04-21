import { isCancel, log, password } from "@clack/prompts";

export interface AnthropicSource {
  kind: "api_key";
  value: string;
}

/**
 * Anthropic credential source for agent pods. API key only — per
 * Anthropic's February 2026 policy, Claude Code OAuth tokens
 * (the `~/.claude` folder) cannot legally be used with the Agent
 * SDK, which is what x1agent drives sessions through. The only
 * supported credential for a platform like this one is an API key
 * issued from the Anthropic Console.
 */
export async function promptAnthropic(): Promise<AnthropicSource | null> {
  const key = await password({
    message: "Anthropic API key (required — sk-ant-...)",
    mask: "•",
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Required. Get one at https://console.anthropic.com";
      if (!t.startsWith("sk-ant-"))
        return "Anthropic API keys start with 'sk-ant-'.";
      return undefined;
    },
  });
  if (isCancel(key)) return null;

  log.info("Key captured. It will be written to the x1agent-secrets namespace.");
  return { kind: "api_key", value: key.trim() };
}
