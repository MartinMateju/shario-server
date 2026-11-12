const nonNegativeInteger = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(Math.floor(numeric), 0) : 0;
};

export type AutomationLimitBasis = "none" | "definitions" | "active";

/**
 * V1 used the field as an execution allowance, V2 counts all saved custom
 * definitions, and V3 deliberately counts only active automations.
 */
export const getAutomationLimitBasis = (
  planVersion: unknown,
): AutomationLimitBasis => {
  const version = nonNegativeInteger(planVersion);
  if (version < 2) return "none";
  return version === 2 ? "definitions" : "active";
};

export const getTeamAccountCapacity = ({
  planVersion,
  activeAdmins,
  activeStaff,
  wasActive,
  willBeActive,
  limit,
}: {
  planVersion: unknown;
  activeAdmins: unknown;
  activeStaff: unknown;
  wasActive: boolean;
  willBeActive: boolean;
  limit: unknown;
}) => {
  const current =
    nonNegativeInteger(activeAdmins) + nonNegativeInteger(activeStaff);
  const delta = Number(willBeActive) - Number(wasActive);
  const next = Math.max(current + delta, 0);
  const normalizedLimit = Math.max(nonNegativeInteger(limit), 1);

  return {
    applies: nonNegativeInteger(planVersion) >= 2,
    current,
    delta,
    next,
    limit: normalizedLimit,
    exceeded:
      nonNegativeInteger(planVersion) >= 2 &&
      delta > 0 &&
      next > normalizedLimit,
  };
};

export const getAutomationCapacity = ({
  planVersion,
  current,
  limit,
}: {
  planVersion: unknown;
  current: unknown;
  limit: unknown;
}) => {
  const normalizedCurrent = nonNegativeInteger(current);
  const normalizedLimit = nonNegativeInteger(limit);
  const applies = getAutomationLimitBasis(planVersion) !== "none";

  return {
    applies,
    current: normalizedCurrent,
    limit: normalizedLimit,
    reached: applies && normalizedCurrent >= normalizedLimit,
  };
};

