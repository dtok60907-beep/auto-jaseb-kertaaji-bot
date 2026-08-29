import type {
  RuntimeRepeatingTaskHandle,
  RuntimeRepeatingTaskScheduler,
} from "./contracts.ts";

export class SerialRuntimeRepeatingTaskScheduler implements RuntimeRepeatingTaskScheduler {
  start(intervalMilliseconds: number, task: () => Promise<"CONTINUE" | "STOP">): RuntimeRepeatingTaskHandle {
    if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds < 1) {
      throw new TypeError("INVALID_REPEAT_INTERVAL");
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: Promise<void> = Promise.resolve();

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        timer = null;
        running = (async () => {
          let decision: "CONTINUE" | "STOP" = "STOP";
          try {
            decision = await task();
          } catch {
            decision = "STOP";
          }
          if (decision === "STOP") stopped = true;
          else schedule();
        })();
      }, intervalMilliseconds);
    };

    schedule();
    return Object.freeze({
      async stop() {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        await running;
      },
    });
  }
}
