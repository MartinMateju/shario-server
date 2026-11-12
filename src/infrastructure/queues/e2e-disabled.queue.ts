import type { Queue } from "bullmq";

/**
 * BullMQ must never connect during the hermetic browser-test server. Queue
 * writes fail explicitly so an E2E test cannot mistake an undelivered job for
 * successful delivery.
 */
export const createE2EDisabledQueue = <T>(
  queueName: string,
): Queue<T> =>
  ({
    add: async () => {
      throw new Error(
        `Queue "${queueName}" is disabled in E2E test mode.`,
      );
    },
    close: async () => undefined,
  }) as unknown as Queue<T>;
