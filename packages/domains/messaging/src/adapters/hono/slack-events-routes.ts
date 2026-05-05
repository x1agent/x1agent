import { Hono } from "hono";
import { DomainError } from "@x1agent/kernel";
import { verifySlackEventSignature } from "../../application/verify-slack-event-signature.js";
import type { SlackBotConfigStore } from "../../ports/slack-bot-config-store.js";
import type { SlackInstallStore } from "../../ports/slack-install-store.js";
import { SlackTeamId } from "../../domain/slack-install.js";

export interface SlackEventsRoutesConfig {
  configs: SlackBotConfigStore;
  installs: SlackInstallStore;
  /** Hook invoked when an `app_mention` arrives. v1 callers stub this
   *  with a "thanks, working on it" reply; full agent invocation lands
   *  in a follow-up. */
  onAppMention?: (input: AppMentionContext) => Promise<void>;
  /** Hook invoked when a `message.im` arrives. Same v1 pattern. */
  onDirectMessage?: (input: DirectMessageContext) => Promise<void>;
  /** Hook invoked when the bot itself joins a channel — register it. */
  onMemberJoinedChannel?: (input: ChannelMembershipContext) => Promise<void>;
  /** Hook invoked when the bot leaves a channel — mark removed. */
  onMemberLeftChannel?: (input: ChannelMembershipContext) => Promise<void>;
  /** Returns "now" — injected for deterministic tests. */
  now?: () => Date;
}

/**
 * Common payload pieces that downstream handlers consume.
 * The handler resolves these from the bot config + install before
 * calling the hook, so each hook receives the x1agent context, not
 * the raw Slack JSON.
 */
export interface BotResolution {
  botConfigId: string;
  agentId: string | null;
  workspaceId: string;
  slackTeamId: string;
  slackAppId: string;
  /** The resolved install id for this (bot, team) pair. Hooks can
   *  use it directly for channel-registry / install-revocation
   *  writes without a second `findByBotConfigAndTeam` lookup. */
  installId: string;
  /** Bot's plaintext xoxb-* token. Hooks use this to post replies. */
  botToken: string;
  /** Slack-side bot user id for filtering self-messages. */
  botUserId: string;
}

export interface AppMentionContext extends BotResolution {
  channelId: string;
  threadTs: string | null;
  /** Slack `ts` of the user message — useful for replying in-thread. */
  messageTs: string;
  userText: string;
  fromSlackUserId: string;
}

export interface DirectMessageContext extends BotResolution {
  channelId: string;
  threadTs: string | null;
  messageTs: string;
  userText: string;
  fromSlackUserId: string;
}

export interface ChannelMembershipContext extends BotResolution {
  channelId: string;
}

/** Top-level shape Slack POSTs us. */
interface SlackEventEnvelope {
  type: string;
  /** Slack API id of the app. Top-level for event_callback envelopes. */
  api_app_id?: string;
  team_id?: string;
  /** Present only when type === "url_verification". */
  challenge?: string;
  event?: SlackEvent;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  // member_joined_channel / member_left_channel — `user` is the user
  // id that joined or left. We only act when it's our bot user.
  channel_type?: string;
}

/**
 * The Slack events endpoint. Mounted at `/api/slack/events` so all
 * per-bot apps land here; the manifest builder bakes that URL into
 * every per-bot manifest. Routing is by `api_app_id` after HMAC
 * verification.
 *
 * The handler is intentionally tight on validation:
 *   - URL verification challenges are answered before any DB hit (Slack
 *     fires this on every subscription edit and during onboarding).
 *   - Signature verification happens BEFORE the body is interpreted as
 *     a typed event. Anything past verifySlackEventSignature is trusted.
 *   - Replay window is 5 minutes (see verify-slack-event-signature.ts).
 *
 * The handler responds 200 on every accepted event even if the
 * downstream hook fails — Slack treats non-2xx as a delivery failure
 * and retries with exponential backoff, which is almost always
 * worse than logging-and-moving-on for a transient handler bug.
 */
export function createSlackEventsRoutes(cfg: SlackEventsRoutesConfig): Hono {
  const app = new Hono();
  const now = cfg.now ?? (() => new Date());

  app.post("/", async (c) => {
    // Hard cap on body size BEFORE parsing. Slack events are tiny;
    // a 1MB ceiling is generous and keeps an unauthenticated endpoint
    // from being used as a DoS amplifier. Without this, an attacker
    // could send GB-scale bodies that we'd buffer in memory before
    // rejecting at HMAC verification.
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > 1_000_000)
      return c.json({ error: "body_too_large" }, 413);

    const rawBody = await c.req.text();
    if (rawBody.length > 1_000_000)
      return c.json({ error: "body_too_large" }, 413);

    let envelope: SlackEventEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SlackEventEnvelope;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    // url_verification arrives without an api_app_id at the top level
    // and is meant to be answered before any signature check would
    // make sense (Slack only knows it has the right URL after we echo
    // the challenge back). We answer it directly.
    if (envelope.type === "url_verification" && envelope.challenge) {
      return c.json({ challenge: envelope.challenge });
    }

    if (envelope.type !== "event_callback") {
      // Other envelope types (e.g. interactivity payloads, slash
      // commands) don't flow through this endpoint in v1.
      return c.json({ ok: true });
    }

    // Slack retries on >3s response. If we get a retry header, the
    // earlier delivery attempt likely already triggered the hook; a
    // second hook firing would post a duplicate ack reply. Short-
    // circuit retries with 200 OK so Slack stops trying. Lose the
    // event (idempotent processing for app_mention / message.im is
    // a follow-up).
    const retryNum = c.req.header("x-slack-retry-num");
    if (retryNum && Number(retryNum) > 0) {
      return c.json({ ok: true, retry_dropped: true });
    }

    const slackAppId = envelope.api_app_id;
    const slackTeamIdStr = envelope.team_id;
    if (!slackAppId || !slackTeamIdStr)
      return c.json({ error: "missing_app_or_team" }, 400);

    const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
    const signature = c.req.header("x-slack-signature") ?? "";
    if (!timestamp || !signature)
      return c.json({ error: "missing_signature_headers" }, 401);

    try {
      await verifySlackEventSignature(
        { configs: cfg.configs, now },
        { slackAppId, rawBody, timestamp, signature },
      );
    } catch {
      // Collapse all signature-verify failure modes to one opaque
      // response. Distinct error codes (missing_secret vs replay vs
      // mismatch) would let an attacker enumerate bot states. Detail
      // stays in the server logs; the wire returns one shape.
      return c.json({ error: "unauthorized" }, 401);
    }

    // Past this line the body is trusted. Resolve the bot config and
    // its install for this Slack team — hooks need the bot token to
    // post replies and the agent id to route invocations.
    //
    // DB / decrypt errors return 200 (not 5xx) so Slack doesn't retry
    // forever and disable the subscription. Same philosophy as the
    // hook-failure branch at the bottom of this handler.
    let config: Awaited<ReturnType<typeof cfg.configs.findBySlackAppId>>;
    let install: Awaited<ReturnType<typeof cfg.installs.findByBotConfigAndTeam>>;
    try {
      config = await cfg.configs.findBySlackAppId(slackAppId);
    } catch (err) {
      console.error("[slack/events] config lookup failed:", err);
      return c.json({ ok: true, lookup_failed: true });
    }
    if (!config) return c.json({ ok: true, bot_unknown: true });

    // Empty-string botUserId sentinel can't filter the bot's own DM —
    // the OAuth callback hasn't stamped slack_bot_user_id yet (brief
    // window between Slack's app creation and the first install
    // landing in our DB). Drop the event rather than risk an echo loop.
    if (!config.slackBotUserId) return c.json({ ok: true, bot_not_ready: true });

    const slackTeamId = SlackTeamId(slackTeamIdStr);
    try {
      install = await cfg.installs.findByBotConfigAndTeam(config.id, slackTeamId);
    } catch (err) {
      console.error("[slack/events] install lookup failed:", err);
      return c.json({ ok: true, lookup_failed: true });
    }
    if (!install || install.revokedAt)
      return c.json({ ok: true, install_unknown: true });

    const resolution: BotResolution = {
      botConfigId: config.id as string,
      agentId: config.agentId,
      workspaceId: config.workspaceId as string,
      slackTeamId: install.slackTeamId as string,
      slackAppId,
      installId: install.id as string,
      botToken: install.botToken,
      botUserId: config.slackBotUserId ?? "",
    };

    const event = envelope.event;
    if (!event) return c.json({ ok: true });

    try {
      if (event.type === "app_mention") {
        // Skip mentions from the bot itself — same echo-loop guard as
        // the DM branch. Bots can mention themselves if a reply text
        // contains <@botUserId>; without this, the reply triggers a
        // mention event which triggers another reply.
        if (event.user === resolution.botUserId) return c.json({ ok: true });
        if (!event.channel || !event.user || !event.ts) {
          return c.json({ ok: true });
        }
        await cfg.onAppMention?.({
          ...resolution,
          channelId: event.channel,
          threadTs: event.thread_ts ?? null,
          messageTs: event.ts,
          userText: event.text ?? "",
          fromSlackUserId: event.user,
        });
      } else if (event.type === "message" && event.channel_type === "im") {
        // Skip messages from the bot itself to prevent feedback loops.
        if (event.user === resolution.botUserId) return c.json({ ok: true });
        if (!event.channel || !event.user || !event.ts) {
          return c.json({ ok: true });
        }
        await cfg.onDirectMessage?.({
          ...resolution,
          channelId: event.channel,
          threadTs: event.thread_ts ?? null,
          messageTs: event.ts,
          userText: event.text ?? "",
          fromSlackUserId: event.user,
        });
      } else if (event.type === "member_joined_channel") {
        // Only react when our bot user is the one joining. Slack
        // sends this for every channel join in the workspace from
        // anyone's perspective; we only care about ourselves.
        if (event.user === resolution.botUserId && event.channel) {
          await cfg.onMemberJoinedChannel?.({
            ...resolution,
            channelId: event.channel,
          });
        }
      } else if (event.type === "member_left_channel") {
        if (event.user === resolution.botUserId && event.channel) {
          await cfg.onMemberLeftChannel?.({
            ...resolution,
            channelId: event.channel,
          });
        }
      }
    } catch (err) {
      // Hooks failing should NOT cause Slack to retry. Slack treats
      // non-2xx as a delivery failure, retries with backoff, then
      // disables the subscription after enough failures. Better to
      // log and move on; the hook owner can re-run on a follow-up
      // event or reconcile via background job.
      console.error("[slack/events] hook failed:", err);
    }

    return c.json({ ok: true });
  });

  return app;
}
