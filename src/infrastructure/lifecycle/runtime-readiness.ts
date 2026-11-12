export type RuntimeReadinessState = "starting" | "ready" | "shutting_down";

let state: RuntimeReadinessState = "starting";

export const markRuntimeStarting = (): void => {
  state = "starting";
};

export const markRuntimeReady = (): void => {
  state = "ready";
};

export const markRuntimeShuttingDown = (): void => {
  state = "shutting_down";
};

export const getRuntimeReadiness = () => ({
  ready: state === "ready",
  state,
});
