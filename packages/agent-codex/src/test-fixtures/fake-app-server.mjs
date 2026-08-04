#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  } else if (message.method === "model/list") {
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: {
          data: [
            { id: "fake", displayName: "Fake Default", isDefault: true },
            { id: "fake-fast", displayName: "Fake Fast", isDefault: false },
          ],
        },
      }) + "\n",
    );
  } else if (message.method === "thread/start") {
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: { thread: { id: "thread-1" } },
      }) + "\n",
    );
  } else if (message.method === "turn/start") {
    process.stdout.write(
      JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }) +
        "\n",
    );
    setTimeout(
      () =>
        process.stdout.write(
          JSON.stringify({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          }) + "\n",
        ),
      40,
    );
  }
}
