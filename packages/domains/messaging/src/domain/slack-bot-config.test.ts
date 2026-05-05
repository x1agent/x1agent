import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import {
  SlackBotConfigId,
  SlackBotName,
  SlackBotConfigNameTakenError,
  SlackBotAlreadyPairedError,
} from "./slack-bot-config.js";

describe("SlackBotConfigId", () => {
  it("accepts a valid uuid", () => {
    const id = SlackBotConfigId("0192f1c5-3d8e-7c00-9b1a-1234567890ab");
    expect(id as string).toBe("0192f1c5-3d8e-7c00-9b1a-1234567890ab");
  });

  it("rejects non-uuid strings", () => {
    expect(() => SlackBotConfigId("not-a-uuid")).toThrow(ValidationError);
    expect(() => SlackBotConfigId("")).toThrow(ValidationError);
  });

  it("normalizes case", () => {
    const id = SlackBotConfigId("0192F1C5-3D8E-7C00-9B1A-1234567890AB");
    expect(id as string).toBe("0192f1c5-3d8e-7c00-9b1a-1234567890ab");
  });
});

describe("SlackBotName", () => {
  it("strips a leading @", () => {
    expect(SlackBotName("@triage") as string).toBe("triage");
  });

  it("preserves the bare name", () => {
    expect(SlackBotName("triage") as string).toBe("triage");
  });

  it("trims surrounding whitespace", () => {
    expect(SlackBotName("  triage  ") as string).toBe("triage");
  });

  it("rejects empty", () => {
    expect(() => SlackBotName("")).toThrow(ValidationError);
    expect(() => SlackBotName("   ")).toThrow(ValidationError);
    expect(() => SlackBotName("@")).toThrow(ValidationError);
  });

  it("rejects names over 80 characters", () => {
    expect(() => SlackBotName("a".repeat(81))).toThrow(ValidationError);
  });

  it("accepts an 80-character name", () => {
    const max = "a".repeat(80);
    expect(SlackBotName(max) as string).toBe(max);
  });
});

describe("SlackBotConfigNameTakenError", () => {
  it("carries the conflicting name in its code and message", () => {
    const err = new SlackBotConfigNameTakenError("triage");
    expect(err.code).toBe("slack_bot_config_name_taken");
    expect(err.message).toContain("triage");
    expect(err.botName).toBe("triage");
  });
});

describe("SlackBotAlreadyPairedError", () => {
  it("includes the current agent id for the UI to surface", () => {
    const err = new SlackBotAlreadyPairedError("bot-1", "agent-7");
    expect(err.code).toBe("slack_bot_already_paired");
    expect(err.currentAgentId).toBe("agent-7");
  });
});
