import "dotenv/config";
import { setServers } from "node:dns";
import mongoose from "mongoose";
import {
  assertRecoveryApproval,
  applyNotificationRecoveryPlan,
  NotificationRecoveryConflictError,
  parseNotificationRecoveryArgs,
  planNotificationRecovery,
  type RecoveryPlan,
} from "../order.notification-recovery.js";

// Native collections only: dry-run never imports application models, creates
// indexes, starts workers, or invokes a provider. It only reads selected IDs.
const help = `Recover explicitly selected order confirmations (dry-run by default).
  --tenant-id <ObjectId>                   Required tenant scope
  --order-id <ObjectId>                    Exhausted localhost SMTP failure; repeatable
  --piece-order-id <ObjectId>              Paid piece order with no confirmation; repeatable
  --apply --approve-plan <dry-run token>   Requeue the reviewed current snapshot
Maximum 50 unique IDs. MONGO_URI comes from the deployment environment.
No message is sent directly. The running confirmation worker may claim an applied recovery immediately.`;

const report = (plan: RecoveryPlan, mode: string) => ({
  mode,
  tenantId: plan.tenantId,
  approvalToken: plan.approvalToken,
  counts: plan.counts,
  candidates: plan.candidates,
});

class ReviewError extends Error {}
const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(help);
    return;
  }
  let options: ReturnType<typeof parseNotificationRecoveryArgs>;
  try {
    options = parseNotificationRecoveryArgs(args);
  } catch (error) {
    throw new ReviewError((error as Error).message);
  }
  if (!process.env.MONGO_URI)
    throw new ReviewError(
      "MONGO_URI must be supplied by the deployment environment.",
    );
  const dns = process.env.DNS_SERVERS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (dns?.length) setServers(dns);
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
  });
  const db = mongoose.connection.db!;
  const orders = db.collection("orders");
  const tenant = new mongoose.Types.ObjectId(options.tenantId);
  const rows = await orders
    .find({
      tenant,
      _id: {
        $in: options.selections.map(
          ({ orderId }) => new mongoose.Types.ObjectId(orderId),
        ),
      },
    })
    .toArray();
  const userIds = [
    ...new Set(rows.map((order) => String(order.createdBy))),
  ].filter((id) => /^[a-f\d]{24}$/i.test(id));
  const users = await db
    .collection("users")
    .find(
      {
        tenant,
        _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) },
      },
      { projection: { _id: 1, email: 1 } },
    )
    .toArray();
  const now = new Date();
  const plan = planNotificationRecovery({
    tenantId: options.tenantId,
    selections: options.selections,
    orders: rows,
    userEmails: new Map(users.map((user) => [String(user._id), user.email])),
    now,
  });
  console.log(
    JSON.stringify(
      report(plan, options.apply ? "apply-preflight" : "dry-run"),
      null,
      2,
    ),
  );
  if (!options.apply) {
    if (plan.counts.rejected) process.exitCode = 1;
    return;
  }
  try {
    assertRecoveryApproval(plan, options.approvalToken);
  } catch (error) {
    throw new ReviewError((error as Error).message);
  }

  const session = await mongoose.startSession();
  try {
    await applyNotificationRecoveryPlan({
      plan,
      approvalToken: options.approvalToken,
      orders,
      session,
      now,
    });
  } finally {
    await session.endSession();
  }
  console.log(
    JSON.stringify(
      {
        mode: "applied",
        tenantId: plan.tenantId,
        recoveryId: plan.approvalToken,
        requeued: plan.operations.length,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        note: "Original events preserved. No direct sends; monitor the confirmation worker.",
      },
      null,
      2,
    ),
  );
};

main()
  .catch((error) => {
    // Never echo connection strings, provider payloads, addresses, or driver errors.
    console.error(
      error instanceof ReviewError ||
        error instanceof NotificationRecoveryConflictError
        ? error.message
        : "Recovery command failed. No direct emails were sent; inspect the reviewed order states before retrying.",
    );
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
