import type { Server } from "node:http";

/** Waits until Node has either bound the listener or reported its bind error. */
export const waitForHttpServerListening = async (
  server: Server,
): Promise<void> => {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
};

/** Stops accepting connections and waits for every active HTTP request. */
export const closeHttpServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
        return;
      }

      resolve();
    });
    server.closeIdleConnections?.();
  });
};
