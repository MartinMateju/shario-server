import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireCheckoutOperation,
  completeCheckoutOperation,
  hashCheckoutRequest,
  validateCheckoutIdempotencyKey,
} from "@/modules/checkout/checkout-idempotency.service.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";

const queryResult = <T>(value: T) =>
  ({ exec: vi.fn().mockResolvedValue(value) }) as never;

describe("checkout request idempotency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires a bounded opaque Idempotency-Key", () => {
    expect(validateCheckoutIdempotencyKey("request_1234")).toBe("request_1234");
    expect(() => validateCheckoutIdempotencyKey("short")).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_IDEMPOTENCY_KEY_REQUIRED" }),
    );
    expect(() =>
      validateCheckoutIdempotencyKey("contains spaces"),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_IDEMPOTENCY_KEY_REQUIRED" }),
    );
  });

  it("uses a stable request fingerprint", () => {
    const objectId = new mongoose.Types.ObjectId();

    expect(
      hashCheckoutRequest({
        nested: { second: 2, first: 1 },
        objectId,
        items: [{ value: "a" }],
      }),
    ).toBe(
      hashCheckoutRequest({
        items: [{ value: "a" }],
        objectId: objectId.toHexString(),
        nested: { first: 1, second: 2 },
      }),
    );
  });

  it("stores only a hash of the client key and allocates stable resource ids", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const operationId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const cartId = new mongoose.Types.ObjectId();
    const findOne = vi
      .spyOn(CheckoutOperationModel, "findOne")
      .mockReturnValue(queryResult(null));
    const create = vi
      .spyOn(CheckoutOperationModel, "create")
      .mockResolvedValue({ _id: operationId, orderId, cartId } as never);

    const result = await acquireCheckoutOperation({
      tenantId: String(tenantId),
      userId: String(userId),
      kind: "card",
      idempotencyKey: "client-request-123",
      request: { cart: [{ quantity: 1 }] },
    });

    expect(findOne).toHaveBeenCalledOnce();
    const persisted = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("idempotencyKey");
    expect(persisted.keyHash).not.toBe("client-request-123");
    expect(result).toEqual({
      type: "acquired",
      lease: expect.objectContaining({
        operationId: String(operationId),
        orderId,
        cartId,
      }),
    });
  });

  it("replays the durable response for the same key and request", async () => {
    const request = { cart: [{ quantity: 1 }] };
    vi.spyOn(CheckoutOperationModel, "findOne").mockReturnValue(
      queryResult({
        requestHash: hashCheckoutRequest(request),
        state: "completed",
        response: { orderId: "order-1", url: "https://checkout.test" },
      }),
    );

    await expect(
      acquireCheckoutOperation({
        tenantId: String(new mongoose.Types.ObjectId()),
        userId: String(new mongoose.Types.ObjectId()),
        kind: "card",
        idempotencyKey: "client-request-123",
        request,
      }),
    ).resolves.toEqual({
      type: "replay",
      response: { orderId: "order-1", url: "https://checkout.test" },
    });
  });

  it("rejects reuse of a key with a different request", async () => {
    vi.spyOn(CheckoutOperationModel, "findOne").mockReturnValue(
      queryResult({
        requestHash: hashCheckoutRequest({ cart: [{ quantity: 1 }] }),
        state: "completed",
        response: { orderId: "order-1" },
      }),
    );

    await expect(
      acquireCheckoutOperation({
        tenantId: String(new mongoose.Types.ObjectId()),
        userId: String(new mongoose.Types.ObjectId()),
        kind: "card",
        idempotencyKey: "client-request-123",
        request: { cart: [{ quantity: 2 }] },
      }),
    ).rejects.toMatchObject({ code: "CHECKOUT_IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("reclaims an expired lease without changing order or cart identity", async () => {
    const request = { cart: [{ quantity: 1 }] };
    const operationId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const cartId = new mongoose.Types.ObjectId();
    const existing = {
      _id: operationId,
      orderId,
      cartId,
      requestHash: hashCheckoutRequest(request),
      state: "processing",
      leaseExpiresAt: new Date(Date.now() - 1_000),
    };
    vi.spyOn(CheckoutOperationModel, "findOne").mockReturnValue(
      queryResult(existing),
    );
    vi.spyOn(CheckoutOperationModel, "findOneAndUpdate").mockReturnValue(
      queryResult({ ...existing, leaseToken: "replacement" }),
    );

    const result = await acquireCheckoutOperation({
      tenantId: String(new mongoose.Types.ObjectId()),
      userId: String(new mongoose.Types.ObjectId()),
      kind: "credits",
      idempotencyKey: "client-request-123",
      request,
    });

    expect(result).toEqual({
      type: "acquired",
      lease: expect.objectContaining({
        operationId: String(operationId),
        orderId,
        cartId,
      }),
    });
  });

  it("defines tenant/user/kind isolation and expiry indexes", () => {
    const indexes = CheckoutOperationModel.schema.indexes();

    expect(indexes).toContainEqual([
      { tenant: 1, user: 1, kind: 1, keyHash: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(indexes).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
  });

  it("can complete the replay record in the checkout transaction", async () => {
    const session = { id: "mongo-session" } as never;
    const updateOne = vi
      .spyOn(CheckoutOperationModel, "updateOne")
      .mockReturnValue(queryResult({ modifiedCount: 1 }));
    const lease = {
      operationId: String(new mongoose.Types.ObjectId()),
      orderId: new mongoose.Types.ObjectId(),
      cartId: new mongoose.Types.ObjectId(),
      leaseToken: "lease-token",
    };

    await completeCheckoutOperation(
      lease,
      { success: true, orderId: String(lease.orderId) },
      session,
    );

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: lease.operationId,
        leaseToken: lease.leaseToken,
        state: "processing",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: "completed" }),
      }),
      { session },
    );
  });
});
