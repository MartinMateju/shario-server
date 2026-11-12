vi.mock("@/infrastructure/email/tenant-email-layout.service.js", () => ({ applyTenantEmailLayout: async (input: { html?: string }) => input.html }));
import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: vi.fn(),
  codes: vi.fn(),
  orderUpdate: vi.fn(),
  claim: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  latest: vi.fn(),
  exists: vi.fn(),
  assets: vi.fn(),
  pdf: vi.fn(),
  legacyPdf: vi.fn(),
  template: vi.fn(),
  customer: vi.fn(),
  admin: vi.fn(),
  send: vi.fn(),
  submit: vi.fn(),
  resolveSender: vi.fn(),
  postmark: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { findOne: mocks.order, updateOne: mocks.orderUpdate },
  Coupon: { find: mocks.codes },
}));
vi.mock("@/modules/coupon/voucher-delivery.model.js", () => ({
  VoucherDeliveryModel: {
    findOneAndUpdate: mocks.claim,
    updateOne: mocks.update,
    updateMany: mocks.updateMany,
    findOne: mocks.latest,
    exists: mocks.exists,
  },
}));
vi.mock("@/modules/product/services/voucher-design.service.js", () => ({
  resolveVoucherDesignAssets: mocks.assets,
}));
vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.lock,
}));
vi.mock("@/modules/coupon/voucher-design.renderer.js", () => ({
  renderVoucherPdf: mocks.pdf,
}));
vi.mock("@/infrastructure/pdf/pdf.utils.js", () => ({
  modifyPromoCodePdf: mocks.legacyPdf,
}));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  getObjectBufferFromR2: mocks.template,
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.send,
}));
vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({ resolveManagedSender: mocks.resolveSender }),
);
vi.mock("@/infrastructure/email/postmark.client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/infrastructure/email/postmark.client.js")
  >()),
  sendPostmarkEmail: mocks.postmark,
}));
vi.mock("@/modules/coupon/coupon-email.service.js", () => ({
  couponEmailService: {
    prepareCustomerCouponOrderEmail: mocks.customer,
    prepareAdminCouponOrderEmail: mocks.admin,
  },
  VOUCHER_EMAIL_ATTACHMENT_LIMIT_BYTES: 6 * 1024 * 1024,
}));
vi.mock("@/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";
import {
  buildPurchasedVoucherAttachments,
  enqueueVoucherDelivery,
  getVoucherOrderDocument,
  getVoucherDocumentDescriptors,
  processVoucherDeliveryOutbox,
  recoverStaleVoucherDeliveryClaims,
  requestVoucherCustomerResend,
  voucherDeliveryInternals,
} from "@/modules/coupon/voucher-delivery.service.js";

const tenant = "aaaaaaaaaaaaaaaaaaaaaaaa";
const orderId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const couponId = "cccccccccccccccccccccccc";
let order: any;
let codes: any[];
const session = { inTransaction: () => true } as any;
const query = (value: unknown) => {
  const q: any = {};
  for (const name of ["select", "sort", "session", "lean"])
    q[name] = vi.fn(() => q);
  q.exec = vi.fn(async () =>
    typeof value === "function" ? (value as Function)() : value,
  );
  return q;
};
const job = (channel = "customer", extra: Record<string, unknown> = {}) => ({
  _id: `job-${channel}`,
  tenant,
  couponOrder: orderId,
  channel,
  generation: 0,
  status: "sending",
  attempts: 1,
  ...extra,
});
const runJobs = (...jobs: any[]) => {
  for (const row of jobs) mocks.claim.mockReturnValueOnce(query(row));
  mocks.claim.mockReturnValue(query(null));
};
const statusUpdates = () =>
  mocks.update.mock.calls.map(([, update]) => update.$set).filter(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  order = {
    _id: orderId,
    tenant,
    product: "dddddddddddddddddddddddd",
    quantity: 1,
    coupons: [couponId],
    promoCodesSnapshot: ["GIFT-CODE-001"],
    productNameSnapshot: "Clay Play",
    unitPriceSnapshot: 1500,
    currencySnapshot: "CZK",
    email: "buyer@example.test",
    paidAt: new Date("2026-09-15"),
    processedAt: new Date("2026-09-15"),
    refundState: "none",
    refundedAmountMinor: 0,
    expiresAtSnapshot: new Date("2099-09-15"),
    validityTimezoneSnapshot: "Europe/Prague",
    localeSnapshot: "cs",
    designSnapshot: JSON.parse(JSON.stringify(DEFAULT_VOUCHER_DESIGN)),
    giftMessageSnapshot: "Pro Emilku",
    deliveryResendGeneration: 0,
    deliveryResendDay: "",
    deliveryResendDayCount: 0,
    save: vi.fn(async () => order),
  };
  codes = [
    {
      _id: couponId,
      promoCode: "GIFT-CODE-001",
      revokedAt: null,
      expiresAt: order.expiresAtSnapshot,
    },
  ];
  mocks.order.mockImplementation(() => query(() => order));
  mocks.codes.mockImplementation(() => query(() => codes));
  mocks.update.mockImplementation(() => query({ modifiedCount: 1 }));
  mocks.orderUpdate.mockImplementation(() => query({ modifiedCount: 1 }));
  mocks.updateMany.mockImplementation(() => query({ modifiedCount: 0 }));
  mocks.latest.mockImplementation(() => query(null));
  mocks.exists.mockImplementation(() => query(null));
  mocks.assets.mockResolvedValue({ image: Buffer.from("IMAGE") });
  mocks.pdf.mockResolvedValue(Buffer.from("PERSONALIZED PDF"));
  mocks.template.mockResolvedValue(Buffer.from("TEMPLATE"));
  mocks.legacyPdf.mockResolvedValue(Buffer.from("LEGACY PDF"));
  mocks.customer.mockResolvedValue({
    to: order.email,
    subject: "Your gift",
    html: "<p>Gift</p>",
  });
  mocks.admin.mockResolvedValue({
    to: "owner@example.test",
    subject: "Purchase",
    html: "<p>Order</p>",
  });
  mocks.submit.mockResolvedValue({
    provider: "postmark",
    providerMessageId: "postmark-accepted",
    status: "sent",
  });
  mocks.send.mockImplementation(async (input) => {
    await input.beforeSend?.();
    return mocks.submit(input);
  });
  vi.spyOn(mongoose.connection, "transaction").mockImplementation(
    async (fn: any) => fn(session),
  );
  runJobs();
});

describe("purchased voucher artifacts", () => {
  it("uses immutable artwork, code, amount, expiry and gift message without looking up the current offering", async () => {
    const result = await buildPurchasedVoucherAttachments(order);
    expect(result[0]).toMatchObject({
      filename: "Clay_Play_1.pdf",
      content: Buffer.from("PERSONALIZED PDF"),
    });
    expect(mocks.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        design: order.designSnapshot,
        giftMessage: "Pro Emilku",
        metadata: {
          promoCode: "GIFT-CODE-001",
          amountMinor: 150000,
          currency: "CZK",
          expiresAt: order.expiresAtSnapshot,
          timezone: "Europe/Prague",
          locale: "cs",
          productName: "Clay Play",
        },
      }),
    );
    expect(mocks.template).not.toHaveBeenCalled();
    expect(mocks.codes.mock.calls[0][0]).toEqual({ tenant, order: orderId });
  });

  it("retains the original code and artwork on a failed asset retry", async () => {
    mocks.assets.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(buildPurchasedVoucherAttachments(order)).rejects.toThrow(
      "Storage unavailable",
    );
    const before = JSON.stringify(order.designSnapshot);
    await buildPurchasedVoucherAttachments(order);
    expect(JSON.stringify(order.designSnapshot)).toBe(before);
    expect(order.promoCodesSnapshot).toEqual(["GIFT-CODE-001"]);
    expect(mocks.pdf.mock.calls[0][0].metadata.expiresAt).toBe(
      order.expiresAtSnapshot,
    );
  });

  it("keeps legacy PDF delivery and descriptor names compatible", async () => {
    order.designSnapshot = undefined;
    order.voucherTemplateKeySnapshot = "retained-legacy-template.pdf";
    const document = await getVoucherOrderDocument({
      tenantId: tenant,
      couponOrderId: orderId,
      index: 0,
    });
    expect(document.filename).toBe(
      getVoucherDocumentDescriptors(order)[0].filename,
    );
    expect(mocks.template).toHaveBeenCalledWith({
      key: "retained-legacy-template.pdf",
    });
    expect(mocks.legacyPdf).toHaveBeenCalledWith({
      promoCode: "GIFT-CODE-001",
      templateBuffer: Buffer.from("TEMPLATE"),
      templateKey: "retained-legacy-template.pdf",
    });
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("renders one requested PDF from a multi-voucher purchase, including its historical expiry", async () => {
    order.quantity = 2;
    order.coupons.push("eeeeeeeeeeeeeeeeeeeeeeee");
    order.promoCodesSnapshot.push("SECOND-GIFT-CODE");
    order.expiresAtSnapshot = new Date("2020-01-01");
    codes[0].expiresAt = order.expiresAtSnapshot;
    codes.push({
      _id: "eeeeeeeeeeeeeeeeeeeeeeee",
      promoCode: "SECOND-GIFT-CODE",
      expiresAt: order.expiresAtSnapshot,
    });
    const document = await getVoucherOrderDocument({
      tenantId: tenant,
      couponOrderId: orderId,
      index: 1,
    });
    expect(document.filename).toBe("Clay_Play_2.pdf");
    expect(mocks.pdf).toHaveBeenCalledTimes(1);
    expect(mocks.pdf.mock.calls[0][0].metadata).toMatchObject({
      promoCode: "SECOND-GIFT-CODE",
      expiresAt: order.expiresAtSnapshot,
    });
    await expect(
      requestVoucherCustomerResend({
        tenantId: tenant,
        couponOrderId: orderId,
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_DELIVERY_SUPPRESSED" });
  });

  it("stops email attachment rendering once the secure-link size threshold is crossed", async () => {
    order.quantity = 2;
    order.coupons.push("eeeeeeeeeeeeeeeeeeeeeeee");
    order.promoCodesSnapshot.push("SECOND-GIFT-CODE");
    codes.push({
      _id: "eeeeeeeeeeeeeeeeeeeeeeee",
      promoCode: "SECOND-GIFT-CODE",
    });
    mocks.pdf.mockResolvedValue(Buffer.alloc(7 * 1024 * 1024));
    const attachments = await buildPurchasedVoucherAttachments(order, {
      maxAttachmentBytes: 6 * 1024 * 1024,
    });
    expect(mocks.pdf).toHaveBeenCalledTimes(1);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].content.length).toBeGreaterThan(6 * 1024 * 1024);
  });

  it.each([
    ["unpaid", { paidAt: null }, "VOUCHER_DELIVERY_NOT_READY"],
    ["unissued", { processedAt: null }, "VOUCHER_DELIVERY_NOT_READY"],
    ["refunded", { refundState: "revoked" }, "VOUCHER_DELIVERY_SUPPRESSED"],
    [
      "partial refund",
      { refundedAmountMinor: 1 },
      "VOUCHER_DELIVERY_SUPPRESSED",
    ],
    [
      "expired",
      { expiresAtSnapshot: new Date(0) },
      "VOUCHER_DELIVERY_SUPPRESSED",
    ],
  ])("refuses %s documents before rendering", async (_label, changes, code) => {
    Object.assign(order, changes);
    await expect(buildPurchasedVoucherAttachments(order)).rejects.toMatchObject(
      { code },
    );
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("refuses a revoked, missing or foreign order code and invalid document indices", async () => {
    codes[0].revokedAt = new Date();
    await expect(buildPurchasedVoucherAttachments(order)).rejects.toMatchObject(
      { code: "VOUCHER_DELIVERY_SUPPRESSED" },
    );
    codes = [];
    await expect(buildPurchasedVoucherAttachments(order)).rejects.toMatchObject(
      { code: "VOUCHER_DELIVERY_NOT_READY" },
    );
    codes = [{ _id: "eeeeeeeeeeeeeeeeeeeeeeee", promoCode: "GIFT-CODE-001" }];
    await expect(buildPurchasedVoucherAttachments(order)).rejects.toMatchObject(
      { code: "VOUCHER_DELIVERY_NOT_READY" },
    );
    codes = [{ _id: couponId, promoCode: "GIFT-CODE-001" }];
    await expect(
      getVoucherOrderDocument({
        tenantId: tenant,
        couponOrderId: orderId,
        index: 1,
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_DOCUMENT_NOT_FOUND" });
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
});

describe("independent durable voucher delivery", () => {
  it("enqueues separate deterministic customer/admin intents inside the issuance transaction only", async () => {
    await enqueueVoucherDelivery({
      tenantId: tenant,
      couponOrderId: orderId,
      session,
    });
    expect(mocks.update).toHaveBeenCalledTimes(2);
    const ids = mocks.update.mock.calls.map(([filter]) => filter._id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(
      voucherDeliveryInternals.intentId(tenant, orderId, "customer", 0),
    );
    for (const [, update, options] of mocks.update.mock.calls) {
      expect(update.$setOnInsert.status).toBe("pending");
      expect(options).toEqual({ upsert: true, session });
      expect(JSON.stringify(update)).not.toContain("GIFT-CODE");
    }
    expect(mocks.send).not.toHaveBeenCalled();
    await expect(
      enqueueVoucherDelivery({
        tenantId: tenant,
        couponOrderId: orderId,
        session: {} as any,
      }),
    ).rejects.toThrow("requires the issuance transaction");
  });

  it("records acceptance with a stable Message-ID and tenant-scoped compatibility flags", async () => {
    runJobs(job());
    expect(await processVoucherDeliveryOutbox()).toEqual({
      processed: 1,
      sent: 1,
    });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      to: order.email,
      tenantId: tenant,
      orderId,
      deliveryId: "job-customer",
      headers: { "Message-ID": "<voucher.job-customer@shario.io>" },
    });
    expect(mocks.send.mock.calls[0][0]).not.toHaveProperty("messageId");
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({
        status: "sent",
        providerMessageId: "postmark-accepted",
      }),
    );
    expect(mocks.orderUpdate.mock.calls[0][0]).toEqual({
      _id: orderId,
      tenant,
    });
    expect(mocks.orderUpdate.mock.calls[0][1][0].$set.customerEmailSent).toBe(
      true,
    );
    expect(mocks.orderUpdate.mock.calls[0][2]).toEqual({
      session,
      updatePipeline: true,
    });
  });

  it.each(["customer", "admin"] as const)(
    "keeps real %s delivery metadata within provider limits while retaining the Message-ID header",
    async (channel) => {
      const deliveryId = voucherDeliveryInternals.intentId(
        tenant,
        orderId,
        channel,
        2,
      );
      expect(deliveryId).toMatch(/^[a-f0-9]{64}$/);
      const headerMessageId = `<voucher.${deliveryId}@shario.io>`;
      expect(headerMessageId.length).toBeGreaterThan(80);
      const managed = await vi.importActual<
        typeof import("@/infrastructure/email/managed-email.service.js")
      >("@/infrastructure/email/managed-email.service.js");
      mocks.resolveSender.mockResolvedValue({
        id: "eeeeeeeeeeeeeeeeeeeeeeee",
        displayName: "Voucher studio",
        fromEmail: "voucher-studio@notify.shario.io",
        replyToEmail: "studio@example.test",
        postmarkServerToken: "test-server-token",
      });
      mocks.postmark.mockResolvedValue({
        provider: "postmark",
        providerMessageId: "postmark-accepted",
        status: "sent",
      });
      mocks.send.mockImplementation(managed.sendManagedTenantEmail);
      runJobs(job(channel, { _id: deliveryId, generation: 2 }));

      await expect(processVoucherDeliveryOutbox()).resolves.toEqual({
        processed: 1,
        sent: 1,
      });

      expect(mocks.postmark).toHaveBeenCalledOnce();
      const payload = mocks.postmark.mock.calls[0][0];
      expect(payload.metadata).toEqual({
        tenantId: tenant,
        managedSenderId: "eeeeeeeeeeeeeeeeeeeeeeee",
        deliveryId,
        orderId,
      });
      for (const value of Object.values(payload.metadata)) {
        expect(String(value).length).toBeLessThanOrEqual(80);
      }
      expect(payload.headers).toContainEqual({
        Name: "Message-ID",
        Value: headerMessageId,
      });
      expect(payload.headers).toContainEqual({
        Name: "X-Shario-Delivery-Key",
        Value: deliveryId,
      });
      expect(statusUpdates()).toContainEqual(
        expect.objectContaining({
          status: "sent",
          providerMessageId: "postmark-accepted",
        }),
      );
    },
  );

  it("continues admin delivery after a known customer provider rejection", async () => {
    runJobs(job(), job("admin"));
    mocks.submit.mockRejectedValueOnce(
      Object.assign(new Error("Rate limited"), { deliveryOutcome: "not_sent" }),
    );
    expect(await processVoucherDeliveryOutbox()).toEqual({
      processed: 2,
      sent: 1,
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        nextAttemptAt: expect.any(Date),
        providerAttemptStartedAt: null,
      }),
    );
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: "sent" }),
    );
  });

  it("does not repeat customer email when only an admin retry remains", async () => {
    order.customerEmailSent = true;
    runJobs(job("admin", { attempts: 2 }));
    await processVoucherDeliveryOutbox();
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0][0].to).toBe("owner@example.test");
  });

  it("retries sender lookup failures without marking a provider attempt", async () => {
    runJobs(job());
    mocks.send.mockRejectedValueOnce(new Error("Sender lookup unavailable"));
    await processVoucherDeliveryOutbox();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(statusUpdates()).toContainEqual(expect.objectContaining({
      status: "failed", nextAttemptAt: expect.any(Date),
    }));
    expect(statusUpdates().some(update => update.providerAttemptStartedAt instanceof Date)).toBe(false);
  });

  it("does not schedule permanent provider rejection for automatic retry", async () => {
    runJobs(job());
    mocks.submit.mockRejectedValueOnce(Object.assign(new Error("Recipient inactive"), {
      deliveryOutcome: "not_sent", permanent: true, code: "POSTMARK_406",
    }));
    await processVoucherDeliveryOutbox();
    expect(statusUpdates()).toContainEqual(expect.objectContaining({
      status: "failed", nextAttemptAt: null, providerAttemptStartedAt: null,
    }));
    expect(mocks.orderUpdate).not.toHaveBeenCalled();
  });

  it("rechecks refunds after resolving the sender and before submitting", async () => {
    runJobs(job());
    mocks.send.mockImplementationOnce(async input => {
      order.refundState = "revoked";
      await input.beforeSend();
      return mocks.submit(input);
    });
    await processVoucherDeliveryOutbox();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(statusUpdates()).toContainEqual(expect.objectContaining({
      status: "suppressed", nextAttemptAt: null,
    }));
    expect(statusUpdates().some(update => update.providerAttemptStartedAt instanceof Date)).toBe(false);
  });

  it("records a skipped admin without falsely marking admin email sent", async () => {
    runJobs(job("admin"));
    mocks.admin.mockResolvedValue(null);
    expect(await processVoucherDeliveryOutbox()).toEqual({
      processed: 1,
      sent: 0,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: "skipped" }),
    );
    expect(mocks.orderUpdate.mock.calls[0][1][0].$set).toEqual({
      adminEmailSkipped: true,
      adminEmailSkipReason: "No eligible tenant notification recipient.",
    });
  });

  it.each([{ refundState: "revoked" }, { refundedAmountMinor: 1 }])(
    "suppresses email if a refund arrives during PDF generation: %j",
    async (changes) => {
      runJobs(job(), job("admin"));
      mocks.pdf.mockImplementation(async () => {
        Object.assign(order, changes);
        return Buffer.from("PDF");
      });
      await processVoucherDeliveryOutbox();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(
        statusUpdates().filter((update) => update.status === "suppressed"),
      ).toHaveLength(2);
    },
  );

  it("backs off bounded preparation failures without starting a provider attempt", async () => {
    runJobs(job("customer", { attempts: 8 }));
    mocks.assets.mockRejectedValue(new Error("Storage unavailable"));
    await processVoucherDeliveryOutbox();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: "failed", nextAttemptAt: null }),
    );
    expect(
      statusUpdates().some(
        (update) => update.providerAttemptStartedAt instanceof Date,
      ),
    ).toBe(false);
  });

  it("stops automatic retry when Postmark times out with an unknown outcome", async () => {
    runJobs(job());
    mocks.submit.mockRejectedValue(
      Object.assign(new Error("Request timeout"), { code: "POSTMARK_OUTCOME_UNKNOWN" }),
    );
    await processVoucherDeliveryOutbox();
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: "ambiguous", nextAttemptAt: null }),
    );
    expect(mocks.orderUpdate).not.toHaveBeenCalled();
  });

  it("does not retry automatically if Postmark accepted but persisting sent failed", async () => {
    runJobs(job());
    mocks.update.mockImplementation((_filter, update) => {
      if (update.$set?.status === "sent")
        return query(() => {
          throw new Error("Database unavailable");
        });
      return query({ modifiedCount: 1 });
    });
    await processVoucherDeliveryOutbox();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(statusUpdates()).toContainEqual(
      expect.objectContaining({ status: "ambiguous", nextAttemptAt: null }),
    );
  });

  it("fences a lease lost before the provider call", async () => {
    runJobs(job());
    mocks.update.mockReturnValue(query({ modifiedCount: 0 }));
    await processVoucherDeliveryOutbox();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("recovers interrupted preparation but quarantines an interrupted provider attempt", async () => {
    const now = new Date();
    await recoverStaleVoucherDeliveryClaims(now);
    expect(mocks.updateMany.mock.calls[0][0]).toMatchObject({
      status: "sending",
      providerAttemptStartedAt: null,
      claimExpiresAt: { $lte: now },
    });
    expect(mocks.updateMany.mock.calls[2][0]).toMatchObject({
      status: "sending",
      providerAttemptStartedAt: { $ne: null },
    });
    expect(mocks.updateMany.mock.calls[2][1].$set).toMatchObject({
      status: "ambiguous",
      nextAttemptAt: null,
    });
  });
});

describe("explicit buyer resend", () => {
  it("creates a new generation in the same transaction as cooldown bookkeeping", async () => {
    order.deliveryResendGeneration = 2;
    await requestVoucherCustomerResend({
      tenantId: tenant,
      couponOrderId: orderId,
    });
    expect(order.deliveryResendGeneration).toBe(3);
    expect(order.deliveryResendDayCount).toBe(1);
    expect(order.save).toHaveBeenCalledWith({ session });
    expect(mocks.update.mock.calls[0][1].$setOnInsert).toMatchObject({
      generation: 3,
      channel: "customer",
      status: "pending",
    });
    expect(mocks.update.mock.calls[0][2]).toMatchObject({ session });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      "in progress",
      () => mocks.exists.mockReturnValue(query({ _id: "active" })),
      "VOUCHER_DELIVERY_PENDING",
    ],
    [
      "cooldown",
      () => {
        order.deliveryResendRequestedAt = new Date();
      },
      "VOUCHER_DELIVERY_COOLDOWN",
    ],
    [
      "daily limit",
      () => {
        order.deliveryResendDay = new Date().toISOString().slice(0, 10);
        order.deliveryResendDayCount = 5;
      },
      "VOUCHER_DELIVERY_LIMIT",
    ],
  ])(
    "rejects a resend during %s without enqueueing",
    async (_label, setup, code) => {
      (setup as Function)();
      await expect(
        requestVoucherCustomerResend({
          tenantId: tenant,
          couponOrderId: orderId,
        }),
      ).rejects.toMatchObject({ code });
      expect(mocks.update).not.toHaveBeenCalled();
      expect(order.save).not.toHaveBeenCalled();
    },
  );
});
