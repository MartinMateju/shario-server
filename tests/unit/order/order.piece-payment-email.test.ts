import { describe, expect, it } from "vitest";

import { buildPiecePaymentConfirmationEmail } from "@/modules/order/services/order.email.service.js";

const order = {
  _id: "507f1f77bcf86cd799439022",
  currency: "EUR",
  grossAmountMinor: 187550,
  paidAmountMinor: 0,
  paidAt: "2026-10-19T12:00:00Z",
  pieceCheckout: {
    state: "paid",
    method: "credits",
    refundedAmountMinor: 0,
    items: [
      { name: "Large vase", registrationNumber: "P-001", amountMinor: 180000 },
      { name: "Small cup", registrationNumber: "P-002", amountMinor: 7550 },
    ],
  },
};
const user = { firstname: "Ada", email: "ada@example.test" };
const tenant = {
  name: "Clay studio",
  settings: { publicDefaultLanguage: "en", timezone: "Europe/Prague" },
};
const render = (selected = order, studio = tenant) =>
  buildPiecePaymentConfirmationEmail({ order: selected, user, tenant: studio });

describe("piece payment confirmation", () => {
  it("lists every saved piece and the full amount paid with credits", () => {
    const email = render();
    expect(email.subject).toContain("Clay studio | Piece payment confirmation");
    for (const item of order.pieceCheckout.items) {
      expect(email.text).toContain(item.name);
      expect(email.text).toContain(item.registrationNumber);
      expect(email.html).toContain(item.registrationNumber);
    }
    expect(email.text).toMatch(/Total paid: EUR\s1,875\.50/);
    expect(email.text).toContain("Paid with studio credits");
    expect(email.text).toContain("14:00");
    expect(`${email.html}\n${email.text}`).not.toMatch(
      /Manage booking|portal\?|<a |paid by card|invoice/i,
    );
  });

  it("uses Czech payment and card copy with the saved currency", () => {
    const email = render(
      {
        ...order,
        currency: "CZK",
        pieceCheckout: { ...order.pieceCheckout, method: "card" },
      },
      {
        ...tenant,
        settings: { ...tenant.settings, publicDefaultLanguage: "cs" },
      },
    );
    expect(email.subject).toContain("Potvrzení platby za výrobky");
    expect(email.text).toContain("Registrační číslo: P-001");
    expect(email.text).toMatch(/Celkem uhrazeno: 1\s875,50\sCZK/);
    expect(email.text).toContain("Uhrazeno kartou");
    expect(email.text).not.toContain("Uhrazeno kredity");
  });

  it.each([
    ["JPY", 1875, /Total paid: JPY\s1,875/],
    ["CLP", 1875, /Total paid: CLP\s1,875/],
    ["HUF", 187550, /Total paid: HUF\s1,875\.50/],
  ] as const)(
    "formats %s using its supported minor units",
    (currency, amountMinor, expected) => {
      const email = render({
        ...order,
        currency,
        grossAmountMinor: amountMinor,
        pieceCheckout: {
          ...order.pieceCheckout,
          items: [{ ...order.pieceCheckout.items[0], amountMinor }],
        },
      });
      expect(email.text).toMatch(expected);
    },
  );

  it("escapes customer, studio and piece data in HTML", () => {
    const email = buildPiecePaymentConfirmationEmail({
      order: {
        ...order,
        pieceCheckout: {
          ...order.pieceCheckout,
          items: [
            {
              name: '<script>alert("piece")</script>',
              registrationNumber: "<b>P&1</b>",
              amountMinor: order.grossAmountMinor,
            },
          ],
        },
      },
      user: { firstname: "<img src=x>" },
      tenant: { ...tenant, name: "Clay & <studio>" },
    });
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;b&gt;P&amp;1&lt;/b&gt;");
    expect(email.html).toContain("Clay &amp; &lt;studio&gt;");
    expect(email.html).toContain("&lt;img src=x&gt;");
    expect(email.html).not.toContain("<script>");
  });

  it.each(["pending", "cancelled", "refunded"])(
    "does not confirm a %s checkout",
    (state) => {
      expect(() =>
        render({ ...order, pieceCheckout: { ...order.pieceCheckout, state } }),
      ).toThrow("settled piece checkout");
    },
  );

  it("fails before sending misleading totals or missing registration details", () => {
    expect(() => render({ ...order, grossAmountMinor: 1 })).toThrow(
      "totals do not match",
    );
    expect(() =>
      render({
        ...order,
        pieceCheckout: {
          ...order.pieceCheckout,
          items: [
            {
              ...order.pieceCheckout.items[0],
              registrationNumber: "",
              amountMinor: order.grossAmountMinor,
            },
          ],
        },
      }),
    ).toThrow("invalid item snapshot");
  });

  it("does not confirm the full payment after any refund has been recorded", () => {
    expect(() =>
      render({
        ...order,
        pieceCheckout: { ...order.pieceCheckout, refundedAmountMinor: 50 },
      }),
    ).toThrow("settled piece checkout");
  });
});
