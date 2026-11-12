import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import { normalizeOpenStudioBookingMode, normalizeProductOpenStudioBookingMode } from "@/modules/product/product-kind-v2.contract.js";
import { planProductKindV2Migration } from "@/modules/product/product-kind-v2.migration.js";
import { productSchema } from "@/modules/product/product.schema.js";
import { createProductSchema, updateProductSchema } from "@/modules/product/product.validators.js";
import {
  resolveRequestedOpenStudioBookingMode,
  resolveProductPublicCapacityLimit,
  resolveProductPrivateBookingSurcharge,
  toProductCatalogDto,
  toProductPublicDto,
} from "@/modules/product/product.utils.js";

const choiceProduct = {
  kind: "open-studio",
  type: "workshop",
  bookingMode: "customer-choice",
  openStudioPolicy: {
    publicCapacityMode: "fixed" as const,
    publicCapacityLimit: 2,
    privateBookingSurcharge: 150,
  },
};
const createInput = {
  name: "Shared or private studio",
  kind: "open-studio",
  bookingMode: "customer-choice",
  price: 125,
  maxNumberOfParticipants: 8,
};

describe("customer-choice Open Studio policy", () => {
  it("keeps the product option out of actual reservation modes", () => {
    expect(normalizeProductOpenStudioBookingMode("customer-choice")).toBe("customer-choice");
    expect(normalizeOpenStudioBookingMode("customer-choice")).toBeNull();
    expect(resolveRequestedOpenStudioBookingMode(choiceProduct, "public")).toBe("public");
    expect(resolveRequestedOpenStudioBookingMode(choiceProduct, "private")).toBe("private");
    expect(resolveRequestedOpenStudioBookingMode(choiceProduct)).toBeNull();
    expect(resolveRequestedOpenStudioBookingMode(choiceProduct, "customer-choice")).toBeNull();
  });

  it("preserves existing fixed policies regardless of customer input", () => {
    expect(resolveRequestedOpenStudioBookingMode({ type: "workshop" }, "private")).toBe("public");
    expect(resolveRequestedOpenStudioBookingMode({ type: "private-workshop" }, "public")).toBe("private");
    expect(resolveRequestedOpenStudioBookingMode({ kind: "class" }, "private")).toBeNull();
    expect(resolveProductPrivateBookingSurcharge({ ...choiceProduct, bookingMode: "private" })).toBe(0);
    expect(resolveProductPublicCapacityLimit({ ...choiceProduct, bookingMode: "public" })).toBeNull();
  });

  it("exposes the total public limit and flat private surcharge only for choice products", () => {
    expect(resolveProductPublicCapacityLimit(choiceProduct)).toBe(2);
    expect(resolveProductPrivateBookingSurcharge(choiceProduct)).toBe(150);
    expect(resolveProductPublicCapacityLimit({
      ...choiceProduct,
      openStudioPolicy: { ...choiceProduct.openStudioPolicy, publicCapacityMode: "activity" },
    })).toBeNull();
  });

  it("accepts activity defaults and multipart policy data", () => {
    expect(createProductSchema.parse(createInput).bookingMode).toBe("customer-choice");
    expect(createProductSchema.parse({
      ...createInput,
      openStudioPolicy: JSON.stringify(choiceProduct.openStudioPolicy),
    }).openStudioPolicy).toEqual(choiceProduct.openStudioPolicy);
    expect(updateProductSchema.parse({
      id: new mongoose.Types.ObjectId().toString(),
      openStudioPolicy: { privateBookingSurcharge: 50 },
    }).openStudioPolicy).toEqual({ privateBookingSurcharge: 50 });
  });

  it.each([
    { publicCapacityMode: "fixed" },
    { publicCapacityMode: "fixed", publicCapacityLimit: null },
    { publicCapacityMode: "fixed", publicCapacityLimit: 0 },
    { publicCapacityMode: "fixed", publicCapacityLimit: 1.5 },
    { publicCapacityMode: "fixed", publicCapacityLimit: -1 },
    { privateBookingSurcharge: -1 },
    { privateBookingSurcharge: Infinity },
    { privateBookingSurcharge: null },
  ])("rejects invalid policy %j", (openStudioPolicy) => {
    expect(createProductSchema.safeParse({ ...createInput, openStudioPolicy }).success).toBe(false);
  });

  it("rejects policy on other products and fixed modes", () => {
    expect(createProductSchema.safeParse({
      ...createInput, kind: "class", bookingMode: null, openStudioPolicy: choiceProduct.openStudioPolicy,
    }).success).toBe(false);
    expect(createProductSchema.safeParse({
      ...createInput, bookingMode: "public", openStudioPolicy: choiceProduct.openStudioPolicy,
    }).success).toBe(false);
  });

  it("persists and serializes the policy for both catalog and management clients", () => {
    const Model = mongoose.models.CustomerChoiceProductTest ?? mongoose.model("CustomerChoiceProductTest", productSchema);
    const product = new Model({
      ...createInput,
      ...choiceProduct,
      tenant: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
    });
    expect(product.validateSync()).toBeUndefined();
    expect(product.openStudioPolicy.publicCapacityLimit).toBe(2);
    expect(toProductPublicDto(product).openStudioPolicy).toEqual(choiceProduct.openStudioPolicy);
    expect(toProductCatalogDto(product).openStudioPolicy).toEqual(choiceProduct.openStudioPolicy);
    expect(toProductCatalogDto({ ...product.toObject(), openStudioPolicy: undefined } as never).openStudioPolicy).toEqual({
      publicCapacityMode: "activity", publicCapacityLimit: null, privateBookingSurcharge: 0,
    });
  });

  it("preserves customer choice when the additive migration is rerun", () => {
    expect(planProductKindV2Migration({
      _id: "choice", ...choiceProduct, kindContractVersion: 2,
    }).action).toBe("already-migrated");
  });
});
