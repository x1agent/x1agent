// TODO(codex-spike): duplicated from packages/agent/src/input-channel.ts. The
// only meaningful diff is the SDKUserMessage type is inlined locally instead
// of imported from @anthropic-ai/claude-agent-sdk so this package doesn't
// depend on the Claude SDK. Extract both copies into agent-runtime-base
// alongside a shared message-type interface in the spike's follow-up.

// Shape-compatible with @anthropic-ai/claude-agent-sdk's SDKUserMessage for
// the fields this channel produces. In v0 nothing in the Codex harness
// actually consumes this iterator — :8788/inject is stubbed — but we keep
// the channel intact so the v1 App Server path can wire it without
// reshaping the harness around it.
export interface SDKUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: string | null;
  session_id: string;
}

/**
 * Async channel that feeds user messages into an agent driver.
 *
 * The original Claude Agent SDK's query() expected `prompt:
 * AsyncIterable<SDKUserMessage>`. This channel bridges the HTTP inject
 * endpoint (POST :8788/inject) to that iterable: each push() either
 * resolves a pending next() or queues for the next pull.
 */
export function createInputChannel() {
  let waiting: ((msg: SDKUserMessage) => void) | null = null;
  const queue: SDKUserMessage[] = [];

  return {
    /**
     * Queue a user message for the SDK. When `parentToolUseId` is set the
     * message is delivered as a response to that specific tool call (used
     * by the AskUserQuestion / request_input flows), otherwise it starts
     * a new turn.
     */
    push(text: string, parentToolUseId?: string) {
      const msg: SDKUserMessage = {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: parentToolUseId || null,
        session_id: "",
      };
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(msg);
      } else {
        queue.push(msg);
      }
    },

    /** Test helper. */
    get pending() {
      return queue.length;
    },

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          return new Promise((resolve) => {
            waiting = (msg) => resolve({ value: msg, done: false });
          });
        },
      };
    },
  };
}
