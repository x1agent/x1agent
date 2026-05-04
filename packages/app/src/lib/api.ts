export const API_BASE =
  import.meta.env.PUBLIC_API_URL || "http://localhost:30001";

/**
 * Build the URL the browser should open to start an MCP OAuth flow.
 *
 * The route lives on the API host (`api.<basedomain>`), not the app
 * host, so this MUST be an absolute URL. A relative path resolves
 * against the app origin and 404s.
 *
 * Tested in `mcp-oauth-url.test.ts` — keep that test in sync if the
 * server-side route shape changes.
 */
export function buildMcpOAuthStartUrl(input: {
  apiBase: string;
  workspaceSlug: string;
  catalogName: string;
  returnTo: string;
}): string {
  const { apiBase, workspaceSlug, catalogName, returnTo } = input;
  return (
    `${apiBase}/auth/mcp/start/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(catalogName)}` +
    `?return_to=${encodeURIComponent(returnTo)}`
  );
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
