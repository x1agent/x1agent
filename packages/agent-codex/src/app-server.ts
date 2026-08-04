import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type AppServerEvent = {
  method: string;
  params: Record<string, unknown>;
};

export type AppServerOptions = {
  binary: string;
  cwd: string;
  /** Optional explicit model. When omitted, use the account's app-server default. */
  model?: string;
  sandbox: "workspace-write" | "danger-full-access";
  onEvent: (event: AppServerEvent) => void;
  onServerRequest?: (request: JsonRpcMessage) => void;
  onStderr?: (line: string) => void;
  onExit?: (error: Error) => void;
  /** Bound JSON-RPC calls so a wedged subprocess cannot hang the session. */
  requestTimeoutMs?: number;
  /** Maximum time from turn/start acceptance to the terminal notification. */
  turnTimeoutMs?: number;
  /** Refresh the account-scoped model catalog even when a model is pinned. */
  discoverModels?: boolean;
};

export interface CodexModelInfo {
  id: string;
  label: string;
  isDefault: boolean;
}

export type CodexTurnInput =
  | { type: "text"; text: string; text_elements: never[] }
  | { type: "localImage"; path: string };

/** A terminal model/tool failure; the app-server connection remains usable. */
export class CodexTurnError extends Error {}

export function buildTurnInputs(
  text: string,
  localImages: string[] = [],
): CodexTurnInput[] {
  return [
    { type: "text", text, text_elements: [] },
    ...localImages.map((imagePath) => ({
      type: "localImage" as const,
      path: imagePath,
    })),
  ];
}

/** Small JSON-RPC client for the versioned Codex app-server stdio protocol. */
export class CodexAppServer {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private selectedModel = "";
  private discoveredModels: CodexModelInfo[] = [];
  private activeTurn:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;

  get model(): string {
    return this.selectedModel || this.options.model || "account-default";
  }

  get models(): readonly CodexModelInfo[] {
    return this.discoveredModels;
  }

  constructor(private readonly options: AppServerOptions) {
    this.proc = spawn(options.binary, ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_API_KEY:
          process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || "",
      },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.read(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) options.onStderr?.(line);
      }
    });
    this.proc.on("error", (error) => this.close(error));
    this.proc.on("exit", (code, signal) => {
      this.close(
        new Error(
          `codex app-server exited code=${code} signal=${signal ?? "none"}`,
        ),
      );
    });
  }

  private close(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.activeTurn?.reject(error);
    if (this.activeTurn) clearTimeout(this.activeTurn.timeout);
    this.activeTurn = undefined;
    this.options.onExit?.(error);
  }

  private clearActiveTurn() {
    if (this.activeTurn) clearTimeout(this.activeTurn.timeout);
    this.activeTurn = undefined;
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let newline = -1;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.options.onStderr?.(
          `invalid app-server JSON: ${line.slice(0, 200)}`,
        );
        continue;
      }
      if (
        message.id !== undefined &&
        (message.result !== undefined || message.error)
      ) {
        const waiter = this.pending.get(Number(message.id));
        if (!waiter) continue;
        this.pending.delete(Number(message.id));
        if (message.error)
          waiter.reject(
            new Error(message.error.message ?? "Codex JSON-RPC error"),
          );
        else waiter.resolve(message.result);
      } else if (message.method) {
        if (message.method === "turn/completed") {
          const turn = message.params?.turn as
            | { error?: { message?: string }; status?: string }
            | undefined;
          if (this.activeTurn) clearTimeout(this.activeTurn.timeout);
          if (turn?.status === "failed" || turn?.error) {
            this.activeTurn?.reject(
              new CodexTurnError(turn.error?.message ?? "Codex turn failed"),
            );
          } else {
            this.activeTurn?.resolve();
          }
          this.activeTurn = undefined;
        } else if (message.method === "turn/failed") {
          const turn = message.params?.turn as
            | { error?: { message?: string }; status?: string }
            | undefined;
          if (this.activeTurn) clearTimeout(this.activeTurn.timeout);
          this.activeTurn?.reject(
            new CodexTurnError(turn?.error?.message ?? "Codex turn failed"),
          );
          this.activeTurn = undefined;
        }
        if (message.id !== undefined) this.options.onServerRequest?.(message);
        else
          this.options.onEvent({
            method: message.method,
            params: message.params ?? {},
          });
      }
    }
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.proc.stdin.write(line, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    if (!this.closed)
      this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async start(): Promise<string> {
    await this.request("initialize", {
      clientInfo: {
        name: "x1agent",
        title: "x1agent Codex runtime",
        version: "0.0.0",
      },
      capabilities: null,
    });
    this.notify("initialized");
    if (!this.options.model || this.options.discoverModels) {
      await this.discoverModels();
    }
    this.selectedModel =
      this.options.model ||
      this.discoveredModels.find((model) => model.isDefault)?.id ||
      this.discoveredModels[0]?.id ||
      "gpt-5.6-sol";
    const result = await this.request<{ thread: { id: string } }>(
      "thread/start",
      {
        model: this.selectedModel,
        cwd: this.options.cwd,
        sandbox: this.options.sandbox,
        approvalPolicy: "never",
        ephemeral: true,
        baseInstructions:
          "Follow the x1agent instructions in your Codex configuration.",
      },
    );
    return result.thread.id;
  }

  private async discoverModels(): Promise<void> {
    // The available model catalog is account-scoped. This is important for
    // ChatGPT login profiles, whose model ids differ from API-key defaults.
    try {
      const result = await this.request<{
        data?: Array<{
          id?: string;
          model?: string;
          displayName?: string;
          display_name?: string;
          name?: string;
          isDefault?: boolean;
          is_default?: boolean;
        }>;
      }>("model/list", {});
      this.discoveredModels = (result.data ?? []).flatMap((model) => {
        const id = model.id || model.model;
        if (!id) return [];
        return [
          {
            id,
            label: model.displayName || model.display_name || model.name || id,
            isDefault: model.isDefault === true || model.is_default === true,
          },
        ];
      });
    } catch (error) {
      this.options.onStderr?.(
        `model/list unavailable; using fallback gpt-5.6-sol: ${(error as Error).message}`,
      );
    }
  }

  async turn(
    threadId: string,
    text: string,
    localImages: string[] = [],
  ): Promise<void> {
    if (this.activeTurn) throw new Error("Codex turn already in flight");
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.activeTurn = undefined;
          reject(new Error("Codex turn timed out waiting for completion"));
        },
        this.options.turnTimeoutMs ?? 60 * 60_000,
      );
      this.activeTurn = { resolve, reject, timeout };
    });
    try {
      await this.request("turn/start", {
        threadId,
        cwd: this.options.cwd,
        model: this.model,
        input: buildTurnInputs(text, localImages),
        approvalPolicy: "never",
      });
      await completed;
    } catch (error) {
      this.clearActiveTurn();
      throw error;
    }
  }

  respond(id: number | string, result: unknown) {
    if (!this.closed)
      this.proc.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  stop() {
    if (this.closed) return;
    this.proc.kill("SIGTERM");
    this.close(new Error("Codex app-server stopped"));
  }
}
