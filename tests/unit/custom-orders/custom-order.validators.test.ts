import { describe, expect, it } from "vitest";
import {
  createCustomOrderInput,
  updateCustomOrderInput,
  closeCustomOrderInput,
  reopenCustomOrderInput,
  customOrderCommentInput,
  listCustomOrdersInput,
} from "@/modules/custom-orders/custom-order.validators.js";

const input = {
  title: "Dinner set",
  description: "Six dinner plates with a blue rim",
  materials: "Stoneware",
  pieceCount: 6,
  startDate: "2026-11-01",
  deadline: "2026-12-01",
  locationId: "000000000000000000000001",
  currency: "CZK",
};
describe("custom order validation", () => {
  it("accepts a complete order without billing or a customer account", () => {
    expect(createCustomOrderInput.parse(input)).toMatchObject({
      quotedAmount: null,
      customerId: null,
      assigneeId: null,
      customer: { name: "", email: "", phone: "" },
    });
  });
  it.each(["title", "description", "materials"])("requires %s", (field) => {
    expect(
      createCustomOrderInput.safeParse({ ...input, [field]: "  " }).success,
    ).toBe(false);
  });
  it.each([0, -1, 1.5, 1000001])(
    "rejects invalid piece count %s",
    (pieceCount) => {
      expect(
        createCustomOrderInput.safeParse({ ...input, pieceCount }).success,
      ).toBe(false);
    },
  );
  it("rejects impossible dates and deadlines before start", () => {
    expect(
      createCustomOrderInput.safeParse({ ...input, deadline: "2026-02-31" })
        .success,
    ).toBe(false);
    expect(
      createCustomOrderInput.safeParse({ ...input, deadline: "2026-10-31" })
        .success,
    ).toBe(false);
    expect(
      createCustomOrderInput.safeParse({ ...input, deadline: input.startDate })
        .success,
    ).toBe(true);
  });
  it("accepts a named unregistered customer with optional contacts", () => {
    expect(
      createCustomOrderInput.parse({ ...input, customer: { name: "Ada" } })
        .customer.name,
    ).toBe("Ada");
    expect(
      createCustomOrderInput.safeParse({
        ...input,
        customer: { name: "Ada", email: "bad" },
      }).success,
    ).toBe(false);
    expect(
      createCustomOrderInput.safeParse({
        ...input,
        customer: { email: "ada@example.test" },
      }).success,
    ).toBe(false);
  });
  it("rejects financial actions, injected state and history fields", () => {
    for (const extra of [
      { paymentStatus: "PAID" },
      { status: "closed" },
      { history: [] },
      { tenant: input.locationId },
    ])
      expect(
        createCustomOrderInput.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
  });
  it("enforces quote precision for the selected currency", () => {
    expect(
      createCustomOrderInput.safeParse({ ...input, quotedAmount: 10.25 })
        .success,
    ).toBe(true);
    expect(
      createCustomOrderInput.safeParse({ ...input, quotedAmount: -1 }).success,
    ).toBe(false);
    expect(
      createCustomOrderInput.safeParse({ ...input, quotedAmount: 10.251 })
        .success,
    ).toBe(false);
    expect(
      createCustomOrderInput.safeParse({
        ...input,
        quotedAmount: 10.25,
        currency: "JPY",
      }).success,
    ).toBe(false);
  });
  it("requires a revision for edits and an explicit reason for reopening", () => {
    expect(updateCustomOrderInput.safeParse(input).success).toBe(false);
    expect(
      updateCustomOrderInput.safeParse({ ...input, revision: 0 }).success,
    ).toBe(true);
    expect(
      reopenCustomOrderInput.safeParse({ revision: 0, reason: " " }).success,
    ).toBe(false);
    expect(
      closeCustomOrderInput.safeParse({ revision: 0, reason: "deleted" })
        .success,
    ).toBe(false);
    expect(
      customOrderCommentInput.safeParse({ revision: 0, body: " " }).success,
    ).toBe(false);
  });
  it("bounds pagination and rejects object search injection", () => {
    expect(
      listCustomOrdersInput.parse({ page: "2", limit: "6", status: "overdue" }),
    ).toMatchObject({ page: 2, limit: 6, status: "overdue" });
    expect(listCustomOrdersInput.safeParse({ limit: "5000" }).success).toBe(
      false,
    );
    expect(
      listCustomOrdersInput.safeParse({ search: { $ne: null } }).success,
    ).toBe(false);
  });
});
