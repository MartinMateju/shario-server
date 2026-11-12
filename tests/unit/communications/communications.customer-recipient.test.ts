import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeCustomerComposeRecipient } from "@/modules/communications/communications.recipient.js";

const customer = {
  firstname: "Anna",
  lastname: "Novak",
  email: "Anna@Example.COM",
  phone: "+420 123 456 789",
  customId: "anna-1",
};

describe("customer-linked compose recipients", () => {
  it("canonicalizes equivalent email and WhatsApp identities from the tenant customer", () => {
    expect(
      canonicalizeCustomerComposeRecipient({
        channel: "email",
        customer,
        requestedRecipient: { email: " anna@example.com " },
      }),
    ).toEqual({
      name: "Anna Novak",
      email: "anna@example.com",
    });

    expect(
      canonicalizeCustomerComposeRecipient({
        channel: "whatsapp",
        customer,
        requestedRecipient: { whatsappId: "420123456789" },
      }),
    ).toEqual({
      name: "Anna Novak",
      phone: "+420 123 456 789",
      whatsappId: "+420 123 456 789",
    });
  });

  it("rejects a caller-provided recipient that differs from the linked customer", () => {
    let error: unknown;
    try {
      canonicalizeCustomerComposeRecipient({
        channel: "email",
        customer,
        requestedRecipient: { email: "other@example.com" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      statusCode: 400,
      code: "COMMUNICATION_CUSTOMER_RECIPIENT_MISMATCH",
    });
  });

  it("rejects a channel for which the selected customer has no identity", () => {
    let error: unknown;
    try {
      canonicalizeCustomerComposeRecipient({
        channel: "email",
        customer: { ...customer, email: "" },
        requestedRecipient: { email: "other@example.com" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      statusCode: 400,
      code: "COMMUNICATION_CUSTOMER_CHANNEL_IDENTITY_MISSING",
    });
  });

  it("canonicalizes before both idempotency replay and conversation creation", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/modules/communications/services/communications.service.ts",
      ),
      "utf8",
    );

    const composeSource = source.slice(source.indexOf("async compose("));
    const customerLookup = composeSource.indexOf(
      "const linkedCustomer = await assertTenantCustomer",
    );
    const canonicalization = composeSource.indexOf(
      "canonicalizeCustomerComposeRecipient",
      customerLookup,
    );
    const replayLookup = composeSource.indexOf("if (input.idempotencyKey)");
    const conversationCreate = composeSource.indexOf(
      "CommunicationConversationModel.create",
    );

    expect(customerLookup).toBeGreaterThanOrEqual(0);
    expect(canonicalization).toBeGreaterThan(customerLookup);
    expect(canonicalization).toBeLessThan(replayLookup);
    expect(canonicalization).toBeLessThan(conversationCreate);
  });
});
