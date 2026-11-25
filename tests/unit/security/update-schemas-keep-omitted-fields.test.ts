import { describe, expect, it } from "vitest";

import { updateKnowledgeArticleSchema } from "@/modules/communications/communications.validators.js";
import { updateEventSchema } from "@/modules/event/event.validators.js";
import { updateLocationSchema } from "@/modules/location/location.validators.js";
import { updateProductSchema } from "@/modules/product/product.validators.js";
import { updateRegisteredSenderEmailSchema } from "@/modules/registered-sender-email/registered-sender-email.validators.js";
import {
  updateSupplierSchema,
  updateSupplyOrderSchema,
} from "@/modules/supplies/supply-order.validators.js";

const id = "64b7f0f0f0f0f0f0f0f0f0f0";

// A PATCH body must come out of validation with only the keys the caller
// sent. Create-time defaults leaking in would overwrite stored data.
describe("update schemas do not re-apply create defaults", () => {
  it.each([
    ["supply order", updateSupplyOrderSchema, { internalNote: "x" }],
    ["supplier", updateSupplierSchema, { note: "x" }],
    ["registered sender", updateRegisteredSenderEmailSchema, { note: "x" }],
    ["knowledge article", updateKnowledgeArticleSchema, { summary: "x" }],
    ["product", updateProductSchema, { id }],
    ["location", updateLocationSchema, { id }],
    ["event", updateEventSchema, { id }],
  ])("%s", (_name, schema, body) => {
    const parsed = (schema as any).parse(body);

    const sent = Object.keys(parsed).filter(
      (key) => parsed[key] !== undefined,
    );

    expect(sent.sort()).toEqual(Object.keys(body).sort());
  });
});
