import cron, { type ScheduledTask } from "node-cron";

import { logger } from "@/config/logger.js";

type CronTask = () => unknown | Promise<unknown>;

type CronLogger = Pick<typeof logger, "error" | "info" | "warn">;

type ScheduleCron = (expression: string, callback: () => void) => ScheduledTask;

export class CronSupervisor {
  private readonly scheduledTasks: ScheduledTask[] = [];
  private readonly runningNames = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private acceptingRuns = true;

  constructor(
    private readonly scheduleCron: ScheduleCron = cron.schedule,
    private readonly log: CronLogger = logger,
  ) {}

  schedule(name: string, expression: string, task: CronTask): ScheduledTask {
    if (!this.acceptingRuns) {
      throw new Error(
        "Cannot register a cron job after the scheduler stopped.",
      );
    }

    const scheduledTask = this.scheduleCron(expression, () => {
      void this.run(name, task);
    });

    this.scheduledTasks.push(scheduledTask);
    return scheduledTask;
  }

  async run(name: string, task: CronTask): Promise<void> {
    if (!this.acceptingRuns) {
      return;
    }

    if (this.runningNames.has(name)) {
      this.log.warn(
        { cron: name },
        "Cron job skipped because its previous run is still active.",
      );
      return;
    }

    this.runningNames.add(name);

    let execution: Promise<void>;
    execution = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch((error) => {
        this.log.error(
          {
            err: error,
            cron: name,
          },
          "Cron job failed.",
        );
      })
      .finally(() => {
        this.runningNames.delete(name);
        this.inFlight.delete(execution);
      });

    this.inFlight.add(execution);
    await execution;
  }

  stop(): void {
    if (!this.acceptingRuns) {
      return;
    }

    this.acceptingRuns = false;

    for (const task of this.scheduledTasks) {
      try {
        task.stop();
      } catch (error) {
        this.log.error({ err: error }, "Failed to stop a cron task.");
      }
    }

    this.log.info(
      { taskCount: this.scheduledTasks.length },
      "Cron jobs stopped.",
    );
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  get activeRunCount(): number {
    return this.inFlight.size;
  }
}

export default CronSupervisor;
