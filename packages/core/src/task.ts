import type { StageTaskStatus } from "@uma-stage/contracts";

export interface CommandResult {
  commandId: string;
  status: Extract<StageTaskStatus, "completed" | "failed" | "cancelled">;
  error?: {
    code: string;
    message: string;
  };
}

export interface StageTask {
  readonly id: string;
  readonly status: StageTaskStatus;
  readonly completion: Promise<CommandResult>;
  cancel(reason?: string): void;
}

export class RuntimeTask implements StageTask {
  status: StageTaskStatus = "pending";
  readonly completion: Promise<CommandResult>;
  readonly #resolve: (result: CommandResult) => void;
  #cancelHandler: ((reason: string) => void) | undefined;

  constructor(readonly id: string) {
    let resolvePromise!: (result: CommandResult) => void;
    this.completion = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    this.#resolve = resolvePromise;
  }

  onCancel(handler: (reason: string) => void): void {
    this.#cancelHandler = handler;
  }

  start(): void {
    if (this.status === "pending") this.status = "running";
  }

  complete(): void {
    if (this.isTerminal()) return;
    this.status = "completed";
    this.#resolve({ commandId: this.id, status: "completed" });
  }

  fail(code: string, message: string): void {
    if (this.isTerminal()) return;
    this.status = "failed";
    this.#resolve({ commandId: this.id, status: "failed", error: { code, message } });
  }

  cancel(reason = "Cancelled"): void {
    if (this.isTerminal()) return;
    if (this.#cancelHandler) {
      this.#cancelHandler(reason);
      return;
    }
    this.finishCancellation(reason);
  }

  finishCancellation(reason: string): void {
    if (this.isTerminal()) return;
    this.status = "cancelled";
    this.#resolve({
      commandId: this.id,
      status: "cancelled",
      error: { code: "CANCELLED", message: reason },
    });
  }

  private isTerminal(): boolean {
    return this.status === "completed" || this.status === "failed" || this.status === "cancelled";
  }
}
