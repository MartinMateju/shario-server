import { logger } from "@/config/logger.js";

export type ShutdownStep = {
  name: string;
  run: () => unknown | Promise<unknown>;
};

export type ShutdownResult = {
  signal: string;
  drainTimedOut: boolean;
  cleanupTimedOut: string[];
  errors: Array<{ name: string; error: unknown }>;
};

type ShutdownLogger = Pick<typeof logger, "error" | "info" | "warn">;

type GracefulShutdownOptions = {
  markNotReady: () => unknown | Promise<unknown>;
  stopSchedulers?: () => unknown | Promise<unknown>;
  drainSteps: ShutdownStep[];
  forceAfterDrainTimeout?: () => unknown | Promise<unknown>;
  cleanupSteps: ShutdownStep[];
  drainTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  logger?: ShutdownLogger;
};

type TimedResult =
  | { timedOut: false; value: PromiseSettledResult<unknown> }
  | { timedOut: true };

const settleWithin = async (
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<TimedResult> => {
  const settled = operation.then(
    (value): PromiseSettledResult<unknown> => ({
      status: "fulfilled",
      value,
    }),
    (reason): PromiseSettledResult<unknown> => ({
      status: "rejected",
      reason,
    }),
  );

  if (timeoutMs <= 0) {
    void settled;
    return { timedOut: true };
  }

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<TimedResult>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const result = await Promise.race([
    settled.then((value): TimedResult => ({ timedOut: false, value })),
    timedOut,
  ]);

  if (timer) {
    clearTimeout(timer);
  }

  return result;
};

const normalizeTimeout = (
  value: number | undefined,
  fallback: number,
): number =>
  Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.trunc(Number(value)))
    : fallback;

export const createGracefulShutdown = (
  options: GracefulShutdownOptions,
): ((signal: string) => Promise<ShutdownResult>) => {
  const log = options.logger || logger;
  const drainTimeoutMs = normalizeTimeout(options.drainTimeoutMs, 30_000);
  const cleanupTimeoutMs = normalizeTimeout(options.cleanupTimeoutMs, 20_000);
  let shutdownPromise: Promise<ShutdownResult> | null = null;

  const runAndRecord = async (
    step: ShutdownStep,
    errors: ShutdownResult["errors"],
  ): Promise<void> => {
    try {
      await step.run();
    } catch (error) {
      errors.push({ name: step.name, error });
      log.error({ err: error, resource: step.name }, "Shutdown step failed.");
    }
  };

  const performShutdown = async (signal: string): Promise<ShutdownResult> => {
    const result: ShutdownResult = {
      signal,
      drainTimedOut: false,
      cleanupTimedOut: [],
      errors: [],
    };

    log.info({ signal }, "Graceful shutdown started.");

    const drainDeadline = Date.now() + drainTimeoutMs;
    const runBeforeDrain = async (step: ShutdownStep): Promise<boolean> => {
      const remainingTime = Math.max(0, drainDeadline - Date.now());
      const settled = await settleWithin(
        runAndRecord(step, result.errors),
        remainingTime,
      );
      return settled.timedOut;
    };

    result.drainTimedOut = await runBeforeDrain({
      name: "readiness",
      run: options.markNotReady,
    });

    if (options.stopSchedulers) {
      result.drainTimedOut =
        (await runBeforeDrain({
          name: "schedulers",
          run: options.stopSchedulers,
        })) || result.drainTimedOut;
    }

    const drainOperations = options.drainSteps.map((step) =>
      runAndRecord(step, result.errors),
    );
    const drainResult = await settleWithin(
      Promise.all(drainOperations),
      Math.max(0, drainDeadline - Date.now()),
    );

    if (drainResult.timedOut || result.drainTimedOut) {
      result.drainTimedOut = true;
      log.warn(
        { timeoutMs: drainTimeoutMs },
        "Graceful drain timed out; forcing open handles to close.",
      );
    }

    const cleanupSteps: ShutdownStep[] = [
      ...(result.drainTimedOut && options.forceAfterDrainTimeout
        ? [
            {
              name: "force-drain",
              run: options.forceAfterDrainTimeout,
            },
          ]
        : []),
      ...options.cleanupSteps,
    ];
    const cleanupDeadline = Date.now() + cleanupTimeoutMs;
    for (const [index, step] of cleanupSteps.entries()) {
      const remainingTime = Math.max(0, cleanupDeadline - Date.now());
      const remainingSteps = cleanupSteps.length - index;
      const stepBudget = Math.max(
        0,
        Math.floor(remainingTime / remainingSteps),
      );
      const cleanupResult = await settleWithin(
        runAndRecord(step, result.errors),
        stepBudget,
      );

      if (cleanupResult.timedOut) {
        result.cleanupTimedOut.push(step.name);
        log.warn(
          { resource: step.name, timeoutMs: stepBudget },
          "Shutdown cleanup step timed out.",
        );
      }
    }

    log.info(
      {
        signal,
        drainTimedOut: result.drainTimedOut,
        cleanupTimedOut: result.cleanupTimedOut,
        errorCount: result.errors.length,
      },
      "Graceful shutdown finished.",
    );

    return result;
  };

  return (signal: string): Promise<ShutdownResult> => {
    if (!shutdownPromise) {
      shutdownPromise = performShutdown(signal);
    }

    return shutdownPromise;
  };
};

export default createGracefulShutdown;
