import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendManagedTenantEmail: vi.fn(),
  provider: vi.fn(),
  sendEmail: vi.fn(),
  bookingFind: vi.fn(),
  tenantFind: vi.fn(),
  resolveCustomerBookingLink: vi.fn(),
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendManagedTenantEmail,
}));
vi.mock("@/infrastructure/email/nodemailer.client.js", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.bookingFind },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findById: mocks.tenantFind },
}));
vi.mock("@/modules/booking/customer-booking-link.service.js", () => ({
  resolveCustomerBookingLink: mocks.resolveCustomerBookingLink,
}));

import { sendNotificationEmail } from "@/modules/order/services/order.email.service.js";

const TENANT_ID = "507f1f77bcf86cd799439023";
const ORDER_ID = "507f1f77bcf86cd799439022";
const input = {
  type: "order_confirm" as const,
  order: { _id: ORDER_ID, tenant: TENANT_ID },
  user: { email: "customer@example.test" },
};
const pieceOrder = {
  ...input.order,
  currency: "EUR",
  grossAmountMinor: 1250,
  paidAmountMinor: 0,
  pieceCheckout: {
    state: "paid",
    method: "credits",
    items: [{ name: "Cup", registrationNumber: "P-42", amountMinor: 1250 }],
  },
};
const query = (result: unknown) => {
  const chain = {
    select: vi.fn(),
    populate: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(result),
  };
  chain.select.mockReturnValue(chain);
  chain.populate.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

describe("order confirmation managed transport boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.provider.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "pm-1",
    });
    mocks.sendManagedTenantEmail.mockImplementation(async ({ beforeSend }) => {
      await beforeSend?.();
      return mocks.provider();
    });
    mocks.tenantFind.mockReturnValue(
      query({
        name: "Clay studio",
        settings: { publicDefaultLanguage: "en", timezone: "UTC" },
      }),
    );
  });

  it("sends through the order tenant's managed identity with a stable delivery key", async () => {
    const beforeSend = vi.fn(async () => {
      expect(mocks.provider).not.toHaveBeenCalled();
    });
    await expect(
      sendNotificationEmail({ ...input, beforeSend, deliveryId: "attempt-1" }),
    ).resolves.toEqual({
      provider: "postmark",
      providerMessageId: "pm-1",
      template: "order-confirm-location-v3",
    });
    expect(mocks.sendManagedTenantEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        to: input.user.email,
        beforeSend,
        orderId: ORDER_ID,
        deliveryId: "attempt-1",
        idempotencyKey: `order-confirm:${ORDER_ID}`,
        headers: expect.objectContaining({
          "X-Shario-Delivery-Key": `order-confirm:${ORDER_ID}`,
        }),
      }),
    );
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("preserves the booking details and localized portal link", async () => {
    mocks.bookingFind.mockReturnValue(
      query([
        {
          _id: "booking",
          start: "2026-10-20T08:00:00Z",
          end: "2026-10-20T10:00:00Z",
          bookingProduct: { name: { EN: "Studio time" } },
          numberOfGuests: 2,
          location: { name: "Clay studio", booking: { timezone: "UTC" } },
        },
      ]),
    );
    mocks.resolveCustomerBookingLink.mockResolvedValue({
      locale: "en",
      url: "https://clay.shario.io/en/portal?tab=my-bookings",
    });
    await sendNotificationEmail({
      ...input,
      order: { ...input.order, workshopBookings: ["booking"] },
    });
    const email = mocks.sendManagedTenantEmail.mock.calls[0][0];
    expect(email.html).toContain("Studio time");
    expect(email.text).toContain(
      "Manage booking: https://clay.shario.io/en/portal?tab=my-bookings",
    );
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: TENANT_ID }),
    );
  });

  it("preserves credit top-up copy without adding a booking link", async () => {
    await sendNotificationEmail({
      ...input,
      order: { ...input.order, creditPurchase: { amount: 500 } },
    });
    const email = mocks.sendManagedTenantEmail.mock.calls[0][0];
    expect(email.html).toContain("500");
    expect(email.html).toContain("kreditů jsme připsali");
    expect(mocks.resolveCustomerBookingLink).not.toHaveBeenCalled();
  });

  it("renders a full-credit piece payment from its saved snapshot without loading bookings", async () => {
    await expect(
      sendNotificationEmail({ ...input, order: pieceOrder }),
    ).resolves.toMatchObject({
      template: "piece-payment-confirm-v1",
      provider: "postmark",
    });
    const email = mocks.sendManagedTenantEmail.mock.calls[0][0];
    expect(email.subject).toContain("Piece payment confirmation");
    expect(email.text).toContain("P-42");
    expect(email.text).toMatch(/Total paid: EUR\s12\.50/);
    expect(email.text).toContain("Paid with studio credits");
    expect(email.html).not.toContain("Manage booking");
    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.resolveCustomerBookingLink).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, order: { _id: ORDER_ID } },
    { ...input, user: { email: " " } },
    {
      ...input,
      order: {
        ...pieceOrder,
        pieceCheckout: { ...pieceOrder.pieceCheckout, state: "refunded" },
      },
    },
  ])("marks invalid source data as definitely not sent", async (params) => {
    const beforeSend = vi.fn();
    await expect(
      sendNotificationEmail({ ...params, beforeSend }),
    ).rejects.toMatchObject({
      code: "ORDER_CONFIRMATION_PREPARATION_FAILED",
      deliveryOutcome: "not_sent",
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it("marks a source-read failure before provider submission as definitely not sent", async () => {
    const broken = query(null);
    broken.exec.mockRejectedValue(new Error("Database unavailable"));
    mocks.tenantFind.mockReturnValue(broken);
    await expect(
      sendNotificationEmail({ ...input, order: pieceOrder }),
    ).rejects.toMatchObject({
      deliveryOutcome: "not_sent",
      message: "Database unavailable",
    });
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it("does not submit to the provider after the job loses its lease", async () => {
    await expect(
      sendNotificationEmail({
        ...input,
        beforeSend: async () => {
          throw Object.assign(new Error("lease expired"), {
            deliveryOutcome: "not_sent",
          });
        },
      }),
    ).rejects.toMatchObject({
      deliveryOutcome: "not_sent",
      message: "lease expired",
    });
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("Managed sender unavailable"), {
      deliveryOutcome: "not_sent",
    }),
    new Error("Provider outcome unknown"),
  ])(
    "preserves provider outcome classification without an SMTP fallback",
    async (error) => {
      mocks.sendManagedTenantEmail.mockRejectedValue(error);
      await expect(sendNotificationEmail(input)).rejects.toBe(error);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    },
  );
});
