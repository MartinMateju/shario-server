import type { OperationsCheck } from "./operations.config.js";

const MINUTE = 60_000;
// Freshness budgets include the actual schedule interval plus execution/retry
// tolerance. Hourly and ten-minute jobs must not use a one-minute budget.
export const CRITICAL_CRON_BUDGETS: Record<string, { successMs: number; runMs: number }> = {
  sendOutAccessCodes: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processTenantBillingEmailOutbox: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processPendingCommunicationDeliveries: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processMembershipNotificationOutbox: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processWaitlistEmailOutbox: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processVoucherDeliveryOutbox: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  reconcilePaidVoucherPurchases: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processVoucherManagementRefunds: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  processBookingPaymentRefunds: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  reconcileVoucherCheckoutSessions: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  reconcilePieceCheckouts: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  reconcileCourseWaitlists: { successMs: 5 * MINUTE, runMs: 4 * MINUTE },
  removeExpiredTempBookings: { successMs: 7 * MINUTE, runMs: 5 * MINUTE },
  sendOutNotificationsAfterPayment: { successMs: 7 * MINUTE, runMs: 5 * MINUTE },
  reportPaidUnfulfilledOrders: { successMs: 25 * MINUTE, runMs: 5 * MINUTE },
  reconcileMemberships: { successMs: 25 * MINUTE, runMs: 10 * MINUTE },
  sendUpcomingBookingReminders: { successMs: 75 * MINUTE, runMs: 10 * MINUTE },
  reconcileExpiredTenantTrials: { successMs: 75 * MINUTE, runMs: 10 * MINUTE },
};

type CronSample = {
  registeredAt: number;
  activeSince: number | null;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastOutcome: "success" | "failure" | null;
  stopped: boolean;
};

export class CronHealthRegistry {
  private readonly samples = new Map<string, CronSample>();

  register(name: string, now = Date.now()): void {
    if (!CRITICAL_CRON_BUDGETS[name]) return;
    this.samples.set(name, {
      registeredAt: now, activeSince: null, lastSucceededAt: null,
      lastFailedAt: null, lastOutcome: null, stopped: false,
    });
  }

  started(name: string, now = Date.now()): void {
    const sample = this.samples.get(name);
    if (sample) sample.activeSince = now;
  }

  finished(name: string, succeeded: boolean, now = Date.now()): void {
    const sample = this.samples.get(name);
    if (!sample) return;
    sample.activeSince = null;
    sample.lastOutcome = succeeded ? "success" : "failure";
    if (succeeded) sample.lastSucceededAt = now;
    else sample.lastFailedAt = now;
  }

  stop(name: string): void {
    const sample = this.samples.get(name);
    if (sample) sample.stopped = true;
  }

  checks(now = Date.now()): OperationsCheck[] {
    return Object.entries(CRITICAL_CRON_BUDGETS).map(([name, budget]) => {
      const sample = this.samples.get(name);
      const id = `cron.${name}`;
      if (!sample) return { id, status: "unhealthy", reason: "not_registered" };
      const activeElapsedMs = sample.activeSince === null ? 0 : Math.max(0, now - sample.activeSince);
      const ageMs = Math.max(0, now - (sample.lastSucceededAt ?? sample.registeredAt));
      const reason = sample.stopped ? "stopped"
        : activeElapsedMs > budget.runMs ? "run_overdue"
        : sample.lastOutcome === "failure" ? "last_run_failed"
        : ageMs > budget.successMs ? "success_overdue"
        : sample.lastSucceededAt === null ? "startup_grace" : "healthy";
      return {
        id,
        status: ["healthy", "startup_grace"].includes(reason) ? "ok" : "unhealthy",
        reason, activeElapsedMs, ageMs, thresholdMs: budget.successMs,
        lastSucceededAt: sample.lastSucceededAt === null ? null : new Date(sample.lastSucceededAt).toISOString(),
        lastFailedAt: sample.lastFailedAt === null ? null : new Date(sample.lastFailedAt).toISOString(),
      };
    });
  }
}

export const cronHealth = new CronHealthRegistry();
