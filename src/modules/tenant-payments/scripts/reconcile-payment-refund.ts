/** Targeted operator repair. Never discovers/scans accounts or issues refunds. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { getTenantPaymentStripe, getTenantPaymentStripeLivemode, getConnectedAccountRequestOptions } from "../tenant-payment.stripe.gateway.js";
import { findTenantPaymentAccountByStripeAccount } from "../tenant-payment-account.repository.js";
import { reconcilePaymentRefundEvent, type RefundReconciliationEvent } from "../services/payment-refund-reconciliation.service.js";

const usage = "Usage: reconcile-payment-refund.ts --account acct_ID --charge ch_ID [--apply]. Default: read-only verification.\n";
export function parseRefundReconciliationArgs(args: string[]) {
  let account: string | undefined, charge: string | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--account" && account === undefined && /^acct_[A-Za-z0-9]+$/.test(args[i + 1] ?? "")) account = args[++i];
    else if (flag === "--charge" && charge === undefined && /^ch_[A-Za-z0-9]+$/.test(args[i + 1] ?? "")) charge = args[++i];
    else if (flag === "--apply" && !apply) apply = true;
    else throw new Error("Invalid arguments");
  }
  if (!account || !charge) throw new Error("Missing account or charge");
  return { account, charge, apply };
}
type Dependencies = {
  connect: () => Promise<unknown>; disconnect: () => Promise<unknown>;
  findAccount: (id: string) => Promise<any>; retrieveCharge: (account: string, charge: string) => Promise<any>;
  livemode: () => boolean; reconcile: (event: RefundReconciliationEvent) => Promise<void>;
  out: (value: string) => unknown; error: (value: string) => unknown;
};
const defaultDependencies: Dependencies = {
  connect: async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("Missing database configuration");
    return mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 20000 });
  },
  disconnect: () => mongoose.disconnect(), findAccount: findTenantPaymentAccountByStripeAccount,
  retrieveCharge: (account, charge) => getTenantPaymentStripe().charges.retrieve(charge, {}, getConnectedAccountRequestOptions(account)),
  livemode: getTenantPaymentStripeLivemode, reconcile: reconcilePaymentRefundEvent,
  out: (value) => process.stdout.write(value), error: (value) => process.stderr.write(value),
};
export async function runRefundReconciliationCommand(args: string[], deps: Dependencies = defaultDependencies): Promise<number> {
  let parsed: ReturnType<typeof parseRefundReconciliationArgs>;
  try { parsed = parseRefundReconciliationArgs(args); }
  catch { deps.error(usage); return 1; }
  let status = 0;
  try {
    await deps.connect();
    const account = await deps.findAccount(parsed.account);
    if (!account || account.livemode !== deps.livemode()) throw new Error("Account mode mismatch");
    const charge = await deps.retrieveCharge(parsed.account, parsed.charge);
    if (charge.id !== parsed.charge || charge.livemode !== account.livemode || !charge.payment_intent) throw new Error("Charge binding mismatch");
    if (parsed.apply) {
      await deps.reconcile({ id: `operator-reconcile:${charge.id}`, account: parsed.account, livemode: charge.livemode, type: "charge.refunded", data: { object: charge } });
      deps.out("Reconciliation completed. Inspect Payments refund reviews for required benefit or mapping action.\n");
    } else deps.out("Account and charge verified. No database writes or financial actions performed. Add --apply to record current provider refund state.\n");
  } catch {
    // Mongo/provider errors can contain credentials, request headers or account
    // details. The CLI deliberately never prints the exception or stack.
    deps.error("Refund reconciliation failed. Verify configuration, account/charge mode, connectivity and operator permissions, then inspect the review before retrying.\n");
    status = 1;
  } finally {
    try { await deps.disconnect(); } catch { deps.error("Database cleanup failed.\n"); status = 1; }
  }
  return status;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runRefundReconciliationCommand(process.argv.slice(2));
