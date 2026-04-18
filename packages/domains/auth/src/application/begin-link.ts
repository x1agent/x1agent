import { randomBytes } from "node:crypto";
import type { Clock } from "@x1agent/kernel";
import type { AuthProvider } from "../ports/auth-provider.js";
import type { LinkAttemptStore } from "../ports/link-attempt-store.js";
import { LinkState, type LinkAttempt } from "../domain/link-attempt.js";
import type { PersonId } from "../domain/person.js";

export interface BeginLinkDeps {
  authProvider: AuthProvider;
  linkAttempts: LinkAttemptStore;
  clock: Clock;
  ttlMs?: number;
}

export interface BeginLinkInput {
  initiatingPersonId: PersonId;
  redirectUri: string;
}

export interface BeginLinkResult {
  authorizeUrl: string;
  state: LinkState;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function mintState(): LinkState {
  return LinkState(randomBytes(32).toString("hex"));
}

export async function beginLink(
  deps: BeginLinkDeps,
  input: BeginLinkInput,
): Promise<BeginLinkResult> {
  const now = deps.clock.now();
  const state = mintState();
  const attempt: LinkAttempt = {
    state,
    initiatingPersonId: input.initiatingPersonId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + (deps.ttlMs ?? DEFAULT_TTL_MS)),
  };
  await deps.linkAttempts.put(attempt);
  return {
    state,
    authorizeUrl: deps.authProvider.getAuthorizeUrl(input.redirectUri, state),
  };
}
