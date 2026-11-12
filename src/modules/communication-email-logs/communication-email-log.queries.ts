import type { CommunicationEmailLogStatus } from "./communication-email-log.constants.js";

export const emailLogStatusFilter = (
  status?: CommunicationEmailLogStatus | "all",
) => {
  if (!status || status === "all") {
    return {};
  }

  return { status };
};
