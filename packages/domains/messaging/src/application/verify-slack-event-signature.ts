import { createHmac, timingSafeEqual } from "node:crypto";
import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import {
  SlackSigningSecretInvalidError,
  SlackSigningSecretMissingError,
} from "../domain/slack-bot-config.js";

export interface VerifySlackEventSignatureDeps {
  configs: SlackBotConfigStore;
  /** Returns "now" — injected for deterministic tests. */
  now: () => Date;
}

export interface VerifySlackEventSignatureInput {
  slackAppId: string;
  rawBody: string;
  /** Header `x-slack-request-timestamp`, seconds since epoch as string. */
  timestamp: string;
  /** Header `x-slack-signature`, format `v0=<hex>`. */
  signature: string;
}

/**
 * Replay window — Slack's recommended bound. Past five minutes, even
 * a valid signature is rejected because a captured request beyond
 * that horizon is treated as suspect. The window is intentionally
 * tight to limit the value of a stolen request payload.
 */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Verify a Slack inbound-event signature.
 *
 * The flow assumes the caller has already parsed the body enough to
 * read `api_app_id` and pulled it out of the event payload. We use
 * that field — *unverified* — to look up the per-app signing secret;
 * an attacker putting someone else's app_id in a forged body still
 * has to produce a signature using THAT app's secret, which they
 * don't have, so the verification step rejects them downstream.
 *
 * Throws on:
 *   - missing signing secret on file (`SlackSigningSecretMissingError`)
 *   - replay window violation
 *   - signature mismatch
 *
 * Returns void on success.
 */
export async function verifySlackEventSignature(
  deps: VerifySlackEventSignatureDeps,
  input: VerifySlackEventSignatureInput,
): Promise<void> {
  const secret = await deps.configs.getSigningSecretByAppId(input.slackAppId);
  if (!secret) throw new SlackSigningSecretMissingError(input.slackAppId);

  const tsNum = Number(input.timestamp);
  if (!Number.isFinite(tsNum))
    throw new SlackSigningSecretInvalidError("timestamp not numeric");
  const ageMs = Math.abs(deps.now().getTime() - tsNum * 1000);
  if (ageMs > REPLAY_WINDOW_MS)
    throw new SlackSigningSecretInvalidError("timestamp outside replay window");

  // Slack's signature scheme: HMAC-SHA256(secret, "v0:" + ts + ":" + body),
  // hex-encoded, prefixed with "v0=".
  const baseString = `v0:${input.timestamp}:${input.rawBody}`;
  const computed = `v0=${createHmac("sha256", secret)
    .update(baseString)
    .digest("hex")}`;

  // Always compare in constant time over the same fixed length (the
  // SHA-256 hex prefix is 67 bytes — `v0=` + 64 hex chars). Pad or
  // truncate the supplied signature to that exact length before
  // comparing. Earlier-returning on length mismatch is technically a
  // tiny side-channel (every Slack signature is exactly 67 bytes, so
  // there's nothing to learn from it, but defense-in-depth is cheap).
  const expected = Buffer.from(computed);
  const padded = Buffer.alloc(expected.length);
  Buffer.from(input.signature).copy(padded, 0, 0, expected.length);
  const ok = timingSafeEqual(expected, padded);
  // Also require the original length matches (without short-circuiting
  // before timingSafeEqual). Combined check: same length AND constant-
  // time-equal.
  if (!ok || input.signature.length !== expected.length)
    throw new SlackSigningSecretInvalidError("signature mismatch");
}
