import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Async channel that feeds user messages into the Claude Agent SDK.
 *
 * The SDK's query() expects `prompt: AsyncIterable<SDKUserMessage>`. This
 * channel bridges the HTTP inject endpoint (POST :8788/inject) to that
 * iterable: each push() either resolves a pending next() or queues for
 * the SDK's next pull.
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
