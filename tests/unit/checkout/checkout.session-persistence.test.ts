import { describe, expect, it, vi } from "vitest";

import {
  attachStripeSessionOrExpire,
  createDurableStripeCheckoutSession,
} from "@/modules/checkout/checkout.session-persistence.js";

describe("Stripe Checkout Session persistence", () => {
  it("persists the order before creating a chargeable Session", async () => {
    const persistenceError = new Error("database unavailable");
    const persistOrder = vi.fn().mockRejectedValue(persistenceError);
    const createSession = vi.fn();

    await expect(
      createDurableStripeCheckoutSession({
        persistOrder,
        createSession,
        attach: vi.fn(),
        expire: vi.fn(),
      }),
    ).rejects.toBe(persistenceError);

    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not create a Session when a duplicate order snapshot is unsafe", async () => {
    const snapshotError = new Error("snapshot changed");
    const createSession = vi.fn();

    await expect(
      createDurableStripeCheckoutSession({
        persistOrder: vi.fn().mockResolvedValue({ id: "order" }),
        validatePersistedOrder: vi.fn(() => {
          throw snapshotError;
        }),
        createSession,
        attach: vi.fn(),
        expire: vi.fn(),
      }),
    ).rejects.toBe(snapshotError);

    expect(createSession).not.toHaveBeenCalled();
  });

  it("expires a created Session when its atomic order attachment fails", async () => {
    const persistenceError = new Error("order update failed");
    const expire = vi.fn().mockResolvedValue(undefined);

    await expect(
      attachStripeSessionOrExpire({
        sessionId: "cs_orphaned",
        attach: vi.fn().mockRejectedValue(persistenceError),
        expire,
      }),
    ).rejects.toBe(persistenceError);

    expect(expire).toHaveBeenCalledWith("cs_orphaned");
  });

  it("does not return a Session unless exactly one order was attached", async () => {
    const expire = vi.fn().mockResolvedValue(undefined);

    await expect(
      attachStripeSessionOrExpire({
        sessionId: "cs_unattached",
        attach: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
        expire,
      }),
    ).rejects.toThrow(/could not be attached/);

    expect(expire).toHaveBeenCalledWith("cs_unattached");
  });
});
