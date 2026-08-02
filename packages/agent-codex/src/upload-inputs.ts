import {
  resolveImageTokens,
  type ResolveOpts,
} from "../../agent-runtime/src/image-tokens.js";

const RESOLVED_UPLOAD_PATH_RE =
  /\/workspace\/\.x1\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)/gi;

export function extractLocalImagePaths(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(RESOLVED_UPLOAD_PATH_RE)) {
    seen.add(match[0]);
  }
  return [...seen];
}

export async function prepareCodexTurnInput(
  text: string,
  options: ResolveOpts,
): Promise<{ text: string; localImages: string[] }> {
  const resolvedText = await resolveImageTokens(text, options);
  return {
    text: resolvedText,
    localImages: extractLocalImagePaths(resolvedText),
  };
}
