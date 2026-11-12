import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/index.js";

export type DashboardQuery = {
  date?: string;
  locationId?: string;
};

export type DashboardContext = {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
};

export type DashboardCoverageEntry = {
  source: string;
  reason: string;
};

export type DashboardFlowKey =
  | "booked"
  | "arriving"
  | "inStudio"
  | "readyToFire"
  | "inKiln"
  | "readyForPickup";

export type DashboardAttentionKey =
  | "unpaidBookings"
  | "completedFiringsAwaitingNotification"
  | "readyForPickup"
  | "lowStock"
  | "overdueTasks";

