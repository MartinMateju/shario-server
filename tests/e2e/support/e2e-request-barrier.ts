import type { RequestHandler } from "express";

import { assertE2ETestMode } from "@/config/e2e-mode.js";

export const createE2ERequestBarrier = (drainTimeoutMs = 30_000) => {
  let resetting = false;
  let activeRequests = 0;
  const idleListeners = new Set<() => void>();

  const middleware: RequestHandler = (req, res, next) => {
    assertE2ETestMode();
    if (req.method === "POST" && req.path === "/__e2e/reset") {
      next();
      return;
    }
    if (resetting) {
      res.status(503).json({ code: "E2E_RESET_IN_PROGRESS" });
      return;
    }

    activeRequests += 1;
    let ended = false;
    const release = () => {
      if (ended) return;
      ended = true;
      activeRequests -= 1;
      if (activeRequests === 0) {
        for (const listener of idleListeners) listener();
      }
    };
    // Client disconnect alone does not finish an asynchronous database write.
    // Wait until the handler ends its response, even on a closed socket.
    const end = res.end;
    res.end = ((...args: Parameters<typeof end>) => {
      try {
        return end.apply(res, args);
      } finally {
        release();
      }
    }) as typeof res.end;
    res.once("finish", release);
    next();
  };

  const runReset = async <T>(reset: () => Promise<T>): Promise<T> => {
    assertE2ETestMode();
    if (resetting) throw new Error("An E2E reset is already running.");
    resetting = true;
    try {
      if (activeRequests !== 0) {
        await new Promise<void>((resolve, reject) => {
          const complete = () => {
            clearTimeout(timer);
            idleListeners.delete(complete);
            resolve();
          };
          const timer = setTimeout(() => {
            idleListeners.delete(complete);
            reject(new Error("E2E reset refused: API requests did not drain."));
          }, drainTimeoutMs);
          idleListeners.add(complete);
        });
      }
      return await reset();
    } finally {
      resetting = false;
    }
  };

  return { middleware, runReset };
};

export const e2eRequestBarrier = createE2ERequestBarrier();
