import { describe, expect, it } from "vitest";

import { EMAIL_TEMPLATE_VARIABLES } from "@/modules/email-template/email-template.rendering.js";
import {
  buildCommunicationEmailVariables,
  formatMinorCurrency,
} from "@/modules/communication-automations/services/communication-email-variables.service.js";

describe("communication email variables", () => {
  it("maps every advertised variable from real location, order and item shapes", () => {
    const ownTotal = formatMinorCurrency(240_000, "CZK", "cs");
    const variables = buildCommunicationEmailVariables({
      tenant: {
        name: "Tenant studio",
        publicSite: { branding: { logoUrl: "https://cdn.example/logo.png" } },
      },
      user: {
        _id: "507f191e810c19729de860ea",
        firstname: "Ada",
        lastname: "Lovelace",
        customId: "ADA-1",
        memberNumber: 234,
      },
      entity: {
        start: "2026-08-01T10:00:00.000Z",
        name: "Blue bowl",
        quantity: 2,
        location: {
          name: "Prague Studio",
          address: {
            line1: "Main 1",
            line2: "Floor 2",
            postalCode: "11000",
            city: "Prague",
            country: "CZ",
          },
          contact: { email: "studio@example.com", phone: "+420123" },
        },
        bookingProduct: { name: { cs: "Kurz", en: "Course" } },
        orders: [
          {
            _id: "507f191e810c19729de860eb",
            isPaid: true,
            createdBy: "507f191e810c19729de860ea",
            grossAmountMinor: 240_000,
            currency: "CZK",
          },
        ],
      },
      recipient: { email: "ada@example.com", name: "Ada Lovelace" },
      locale: "cs",
      timezone: "Europe/Prague",
    });

    expect(Object.keys(variables).sort()).toEqual(
      [...EMAIL_TEMPLATE_VARIABLES].sort(),
    );
    expect(variables).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      studio: "Prague Studio",
      studioName: "Prague Studio",
      studioAddress: "Main 1, Floor 2, 11000 Prague, CZ",
      studioEmail: "studio@example.com",
      studioPhone: "+420123",
      logo: "https://cdn.example/logo.png",
      productName: "Kurz",
      orderNumber: "507f191e810c19729de860eb",
      totalPrice: ownTotal,
      customId: "234",
    });
  });

  it("never exposes another purchaser's order or amount", () => {
    const variables = buildCommunicationEmailVariables({
      tenant: { name: "Studio" },
      user: {
        _id: "507f191e810c19729de860ea",
        firstname: "Ada",
      },
      entity: {
        orders: [
          {
            _id: "507f191e810c19729de860eb",
            isPaid: true,
            createdBy: "507f191e810c19729de860ea",
            grossAmountMinor: 1_000,
            currency: "EUR",
          },
          {
            _id: "507f191e810c19729de860ec",
            isPaid: true,
            createdBy: "507f191e810c19729de860ff",
            grossAmountMinor: 999_900,
            currency: "EUR",
          },
        ],
      },
      recipient: { email: "ada@example.com", name: "Ada" },
      locale: "en",
      timezone: "UTC",
    });

    expect(variables.orderNumber).toBe("507f191e810c19729de860eb");
    expect(variables.totalPrice).toBe(formatMinorCurrency(1_000, "EUR", "en"));
    expect(variables.orderNumber).not.toContain("860ec");
    expect(variables.totalPrice).not.toContain("9,999");
  });

  it("uses only the confirmed order when a customer has several purchases in one session", () => {
    const variables = buildCommunicationEmailVariables({
      tenant: { name: "Studio" }, user: { _id: "customer" },
      entity: { orders: [
        { _id: "old-order", createdBy: "customer", isPaid: true, grossAmountMinor: 500, currency: "EUR" },
        { _id: "confirmed-order", createdBy: "customer", isPaid: true, grossAmountMinor: 1000, currency: "EUR" },
      ] },
      sourceOrderId: "confirmed-order",
      recipient: { name: "Customer", email: "customer@example.com" }, locale: "en", timezone: "UTC",
    });
    expect(variables.orderNumber).toBe("confirmed-order");
    expect(variables.totalPrice).toBe(formatMinorCurrency(1000, "EUR", "en"));
  });
});
