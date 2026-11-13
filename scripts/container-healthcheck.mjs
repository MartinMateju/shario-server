import { get } from "node:http";

// Check only this container. Readiness includes the bounded MongoDB probe;
// Redis queues and worker delivery have their own operational monitoring.
const port = Number(process.env.PORT || 4311);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.exitCode = 1;
} else {
  const request = get(
    { hostname: "127.0.0.1", port, path: "/ready", timeout: 3000 },
    (response) => {
      response.resume();
      process.exitCode = response.statusCode === 200 ? 0 : 1;
    },
  );
  request.on("timeout", () => request.destroy(new Error("Readiness timed out")));
  request.on("error", () => { process.exitCode = 1; });
}
