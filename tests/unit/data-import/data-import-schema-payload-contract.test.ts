import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const productSchema = read("src/modules/product/product.schema.ts");
const bookingSchema = read("src/modules/booking/booking.schema.ts");
const productExecution = read(
  "src/modules/data-import/services/product-import-execution.service.ts",
);
const bookingExecution = read(
  "src/modules/data-import/services/booking-import-execution.service.ts",
);

const bookingPayload = bookingExecution.slice(
  bookingExecution.indexOf("const bookingPayload"),
  bookingExecution.indexOf("const availabilityWarning"),
);

describe("data import persistence safety contract", () => {
  it("keeps product import metadata private and tenant-idempotent", () => {
    expect(productSchema).toContain("const productImportMetadataSchema");
    expect(productSchema).toMatch(
      /importMetadata:\s*\{[\s\S]*?type:\s*productImportMetadataSchema,[\s\S]*?select:\s*false/,
    );
    expect(productSchema).toContain('name: "tenant_1_product_importKey_1"');
    expect(productSchema).toContain('name: "tenant_1_product_externalId_1"');
    expect(productSchema).toContain('name: "tenant_1_product_fingerprint_1"');
    expect(productSchema).toContain(
      'name: "tenant_1_product_lastMutationKey_1"',
    );
    for (const field of [
      "importKey",
      "externalId",
      "fingerprint",
      "lastMutationKey",
    ]) {
      expect(productSchema).toMatch(
        new RegExp(
          `partialFilterExpression:\\s*\\{\\s*"importMetadata\\.${field}":\\s*\\{\\s*\\$type:\\s*"string"\\s*\\}`,
        ),
      );
    }
  });

  it("keeps booking import metadata private with three partial unique identities", () => {
    expect(bookingSchema).toContain("const bookingImportMetadataSchema");
    expect(bookingSchema).toMatch(
      /fingerprint:\s*\{\s*type:\s*String,\s*required:\s*true,\s*maxlength:\s*64\s*\}/,
    );
    expect(bookingSchema).toMatch(
      /importMetadata:\s*\{[\s\S]*?type:\s*bookingImportMetadataSchema,[\s\S]*?select:\s*false/,
    );
    expect(bookingSchema).toContain('name: "tenant_1_booking_importKey_1"');
    expect(bookingSchema).toContain('name: "tenant_1_booking_externalId_1"');
    expect(bookingSchema).toContain('name: "tenant_1_booking_fingerprint_1"');
    expect(bookingSchema.match(/partialFilterExpression:/g)).toHaveLength(3);
    expect(bookingSchema.match(/\{ \$type: "string" \}/g)).toHaveLength(3);
  });

  it("creates technical booking records without Orders, enrolments, or confirmation side effects", () => {
    expect(bookingPayload).toContain("participants: []");
    expect(bookingPayload).toContain("orders: []");
    expect(bookingPayload).toContain('paymentStatus: "CONFIRMED"');
    expect(bookingPayload).toContain("importKey: `${sessionId}:${rowNumber}`");
    expect(bookingPayload).toMatch(
      /wasReminderSent:\s*context\.kind === "class"\s*\? context\.historical\s*:\s*true/,
    );
    expect(bookingPayload).not.toContain("confirmationSentAt");
    expect(bookingExecution).not.toMatch(
      /OrderModel|enqueue.*email|send.*email/i,
    );
  });

  it("only updates import-owned bookings without Orders and preserves their import key", () => {
    expect(bookingExecution).toContain(
      "if (!record.importMetadata || (record.orders || []).length)",
    );
    expect(bookingExecution).toContain("orders: { $size: 0 }");
    expect(bookingExecution).toContain(
      '"importMetadata.importId": { $exists: true }',
    );
    expect(bookingExecution).toContain("if (!record.importMetadata.importKey)");
    expect(bookingExecution).toContain(
      'set["importMetadata.importKey"] = `${sessionId}:${rowNumber}`',
    );
  });

  it("never writes Stripe relationship fields from product import rows", () => {
    expect(productExecution).not.toContain("stripeProductId");
    expect(productExecution).not.toContain("stripePriceId");
    expect(productExecution).not.toContain("couponProductId");
  });
});
