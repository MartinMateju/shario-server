import { logger } from "@/config/logger.js";

type QueueErrorSource = {
  on(event: "error", listener: (error: Error) => void): unknown;
};

export const withQueueErrorLogging = <QueueType extends QueueErrorSource>(
  queue: QueueType,
  queueName: string,
): QueueType => {
  queue.on("error", (error) => {
    logger.error({ err: error, queue: queueName }, "BullMQ queue error.");
  });

  return queue;
};
