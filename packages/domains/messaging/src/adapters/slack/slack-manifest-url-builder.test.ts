import { describe, it, expect } from "bun:test";
import { SlackManifestUrlBuilder } from "./slack-manifest-url-builder.js";
import { SlackBotName } from "../../domain/slack-bot-config.js";

describe("SlackManifestUrlBuilder", () => {
  it("returns a URL pointing at api.slack.com/apps with new_app=1", () => {
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({ botName: SlackBotName("triage"), state: "STATE_TOKEN" });
    const parsed = new URL(url);
    expect(parsed.host).toBe("api.slack.com");
    expect(parsed.pathname).toBe("/apps");
    expect(parsed.searchParams.get("new_app")).toBe("1");
  });

  it("embeds the bot name in the YAML manifest", () => {
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({ botName: SlackBotName("triage"), state: "STATE_TOKEN" });
    const yaml = new URL(url).searchParams.get("manifest_yaml") ?? "";
    expect(yaml).toContain('name: "triage"');
    expect(yaml).toContain('display_name: "triage"');
  });

  it("embeds the platform's OAuth callback URL with state baked in", () => {
    // P0 #1 regression: Slack's "Install to Workspace" button doesn't
    // propagate `state` through OAuth, so it has to live in the
    // redirect URL itself for our callback to identify the bot.
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({ botName: SlackBotName("triage"), state: "STATE_TOKEN" });
    const yaml = new URL(url).searchParams.get("manifest_yaml") ?? "";
    expect(yaml).toContain(
      "- https://api.example.com/oauth/slack/callback?state=STATE_TOKEN",
    );
  });

  it("URL-encodes special characters in the state token", () => {
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({
      botName: SlackBotName("triage"),
      state: "abc/def&xyz",
    });
    const yaml = new URL(url).searchParams.get("manifest_yaml") ?? "";
    expect(yaml).toContain("?state=abc%2Fdef%26xyz");
  });

  it("includes the events request URL", () => {
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({ botName: SlackBotName("triage"), state: "STATE_TOKEN" });
    const yaml = new URL(url).searchParams.get("manifest_yaml") ?? "";
    expect(yaml).toContain("request_url: https://api.example.com/api/slack/events");
  });

  it("subscribes only to invocation events by default", () => {
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({ botName: SlackBotName("triage"), state: "STATE_TOKEN" });
    const yaml = new URL(url).searchParams.get("manifest_yaml") ?? "";
    expect(yaml).toContain("- app_mention");
    expect(yaml).toContain("- message.im");
    // Channel firehose events must not appear by default.
    expect(yaml).not.toContain("- channels.history");
    expect(yaml).not.toContain("- groups.history");
    // The catch-all "message.channels" would forward every message.
    expect(yaml).not.toContain("- message.channels");
  });

  it("declares only the explicit-invocation bot scopes", () => {
    const url = new SlackManifestUrlBuilder({
      apiPublicUrl: "https://api.example.com",
    }).buildManifestUrl({ botName: SlackBotName("triage"), state: "STATE_TOKEN" });
    const yaml = new URL(url).searchParams.get("manifest_yaml") ?? "";
    expect(yaml).toContain("- app_mentions:read");
    expect(yaml).toContain("- chat:write");
    expect(yaml).toContain("- im:history");
    // Wide-net scopes must not appear in the default manifest.
    expect(yaml).not.toContain("- channels:history");
    expect(yaml).not.toContain("- groups:history");
  });
});
