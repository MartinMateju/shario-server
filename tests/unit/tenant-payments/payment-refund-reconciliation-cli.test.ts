import { describe, expect, it, vi } from "vitest";
import { parseRefundReconciliationArgs, runRefundReconciliationCommand } from "@/modules/tenant-payments/scripts/reconcile-payment-refund.js";
const valid = ["--account", "acct_test", "--charge", "ch_test"];
const deps = () => ({ connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined), findAccount: vi.fn().mockResolvedValue({ livemode: false }), retrieveCharge: vi.fn().mockResolvedValue({ id: "ch_test", livemode: false, payment_intent: "pi_test" }), livemode: () => false, reconcile: vi.fn().mockResolvedValue(undefined), out: vi.fn(), error: vi.fn() });
describe("targeted refund reconciliation CLI", () => {
  it.each([["--apply", "false"], ["--apply", "--apply"], ["--account", "acct_other"], ["--charge", "ch_other"], ["--unknown"], ["stray"], ["--apply=false"]])("rejects ambiguous or stray arguments %j before connections", async (extra) => {
    const d = deps(); expect(await runRefundReconciliationCommand([...valid, ...extra], d)).toBe(1);
    expect(d.connect).not.toHaveBeenCalled(); expect(d.reconcile).not.toHaveBeenCalled();
  });
  it("defaults to read-only account/charge verification", async () => {
    expect(parseRefundReconciliationArgs(valid).apply).toBe(false);
    const d = deps(); expect(await runRefundReconciliationCommand(valid, d)).toBe(0);
    expect(d.retrieveCharge).toHaveBeenCalledWith("acct_test", "ch_test");
    expect(d.reconcile).not.toHaveBeenCalled(); expect(d.disconnect).toHaveBeenCalledOnce();
  });
  it("only an exact standalone --apply invokes verified reconciliation", async () => {
    const d = deps(); expect(await runRefundReconciliationCommand([...valid, "--apply"], d)).toBe(0);
    expect(d.reconcile).toHaveBeenCalledOnce();
  });
  it("fails closed for the wrong mode and redacts provider/database exceptions", async () => {
    const d = deps(); d.findAccount.mockResolvedValue({ livemode: true });
    expect(await runRefundReconciliationCommand([...valid, "--apply"], d)).toBe(1); expect(d.reconcile).not.toHaveBeenCalled();
    d.connect.mockRejectedValue(new Error("mongodb://secret:password@host?api_key=provider-secret"));
    expect(await runRefundReconciliationCommand(valid, d)).toBe(1);
    expect(JSON.stringify(d.error.mock.calls)).not.toMatch(/password|provider-secret|mongodb:\/\//);
  });
});
