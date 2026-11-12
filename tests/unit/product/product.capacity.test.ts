import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { MAX_PRODUCT_PARTICIPANTS } from "@/modules/product/product.constants.js";
import { productSchema } from "@/modules/product/product.schema.js";
import { toProductPublicDto } from "@/modules/product/product.utils.js";
import {
  createProductSchema,
  productListQuerySchema,
  updateProductSchema,
} from "@/modules/product/product.validators.js";

describe("product participant capacity", () => {
  it.each([
    "course",
    "workshop",
    "service",
    "public-course",
    "private-course",
    "public-workshop",
    "private-workshop",
  ])(
    "requires a capacity for %s products",
    (type) => {
      const result = createProductSchema.safeParse({
        name: "Course",
        type,
        price: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.flatten().fieldErrors.maxNumberOfParticipants).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/require a participant capacity/i),
          ]),
        );
      }
    },
  );

  it("allows an inactive bookable draft without capacity", () => {
    const result = createProductSchema.parse({
      name: "Draft workshop",
      type: "workshop",
      price: 0,
      isActive: "false",
    });

    expect(result).toMatchObject({
      isActive: false,
      maxNumberOfParticipants: null,
    });
  });

  it("parses false boolean form and query values semantically", () => {
    expect(
      createProductSchema.parse({
        name: "Inactive product",
        type: "physical-product",
        price: 100,
        isActive: "false",
      }).isActive,
    ).toBe(false);

    expect(
      updateProductSchema.parse({
        id: new mongoose.Types.ObjectId().toString(),
        isActive: "0",
      }).isActive,
    ).toBe(false);

    expect(
      productListQuerySchema.parse({
        isActive: "false",
      }).isActive,
    ).toBe(false);
  });

  it("coerces a bounded integer capacity from form input", () => {
    const result = createProductSchema.parse({
      name: "Course",
      type: "course",
      price: "100",
      maxNumberOfParticipants: "12",
    });

    expect(result.maxNumberOfParticipants).toBe(12);
  });

  it("rejects fractional and excessive capacities", () => {
    expect(() =>
      createProductSchema.parse({
        name: "Course",
        type: "course",
        price: 100,
        maxNumberOfParticipants: 1.5,
      }),
    ).toThrow();

    expect(() =>
      updateProductSchema.parse({
        id: new mongoose.Types.ObjectId().toString(),
        maxNumberOfParticipants: MAX_PRODUCT_PARTICIPANTS + 1,
      }),
    ).toThrow();
  });

  it("persists the field in the schema and exposes it in the public DTO", () => {
    expect(productSchema.path("maxNumberOfParticipants")).toBeDefined();

    const id = new mongoose.Types.ObjectId();
    const dto = toProductPublicDto({
      _id: id,
      name: "Course",
      description: "",
      sku: "",
      type: "course",
      price: 100,
      extraCharge: 0,
      maxNumberOfParticipants: 12,
      currency: "EUR",
      imageSrc: "",
      label: "",
      voucherTemplate: "",
      couponProduct: null,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as never);

    expect(dto).toMatchObject({
      id: String(id),
      _id: String(id),
      maxNumberOfParticipants: 12,
    });
  });
});
