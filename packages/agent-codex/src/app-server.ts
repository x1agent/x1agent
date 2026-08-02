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
};

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

  get model(): string {
    return this.selectedModel || this.options.model || "account-default";
  }

  constructor(private readonly options: AppServerOptions) {
    this.proc = spawn(options.binary, ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_API_KEY: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || "",
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
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`codex app-server exited code=${code} signal=${signal ?? "none"}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
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
        this.options.onStderr?.(`invalid app-server JSON: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const waiter = this.pending.get(Number(message.id));
        if (!waiter) continue;
        this.pending.delete(Number(message.id));
        if (message.error) waiter.reject(new Error(message.error.message ?? "Codex JSON-RPC error"));
        else waiter.resolve(message.result);
      } else if (message.method) {
        if (message.id !== undefined) this.options.onServerRequest?.(message);
        else this.options.onEvent({ method: message.method, params: message.params ?? {} });
      }
    }
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.proc.stdin.write(line, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async start(): Promise<string> {
    await this.request("initialize", {
      clientInfo: { name: "x1agent", title: "x1agent Codex runtime", version: "0.0.0" },
      capabilities: null,
    });
    this.notify("initialized");
    this.selectedModel = this.options.model || await this.discoverDefaultModel();
    const result = await this.request<{ thread: { id: string } }>("thread/start", {
      model: this.selectedModel,
      cwd: this.options.cwd,
      sandbox: this.options.sandbox,
      approvalPolicy: "never",
      ephemeral: true,
      baseInstructions: "Follow the x1agent instructions in your Codex configuration.",
    });
    return result.thread.id;
  }

  private async discoverDefaultModel(): Promise<string> {
    // The available model catalog is account-scoped. This is important for
    // ChatGPT login profiles, whose model ids differ from API-key defaults.
    try {
      const result = await this.request<{
        data?: Array<{ id?: string; model?: string; isDefault?: boolean }>;
      }>("model/list", {});
      const models = result.data ?? [];
      const selected = models.find((m) => m.isDefault) ?? models[0];
      const model = selected?.id || selected?.model;
      if (model) return model;
    } catch (error) {
      this.options.onStderr?.(
        `model/list unavailable; using fallback gpt-5.6-sol: ${(error as Error).message}`,
      );
    }
    return "gpt-5.6-sol";
  }

  async turn(threadId: string, text: string): Promise<void> {
    await this.request("turn/start", {
      threadId,
      cwd: this.options.cwd,
      model: this.model,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "never",
    });
  }

  respond(id: number | string, result: unknown) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.proc.kill("SIGTERM");
  }
}
