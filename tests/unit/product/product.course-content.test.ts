import { describe, expect, it } from "vitest";
import { Product } from "@/modules/product/product.model.js";
import { updateProductSchema } from "@/modules/product/product.validators.js";
import { toProductCatalogDto } from "@/modules/product/product.utils.js";
import { serializeCourseContent } from "@/modules/product/product.course-content.js";

const content = {
  name: { cs: "Hrnčířský kurz", en: "Pottery course", nl: "Keramiekcursus" },
  description: { cs: "Tvořte s námi.", en: "Make with us." },
  details: {
    en: "What is included\nClay, glaze and firing.\n\nBring an apron.",
  },
  durationLabel: { en: "4 × 2.5 hours" },
  images: ["https://cdn.example.com/course.webp", "/images/course-detail.jpg"],
};
const product = (extra = {}) =>
  new Product({
    tenant: "507f1f77bcf86cd799439099",
    createdBy: "507f1f77bcf86cd799439098",
    name: "Existing legacy course",
    type: "course",
    kind: "class",
    price: 2000,
    currency: "CZK",
    maxNumberOfParticipants: 4,
    ...extra,
  });

describe("additive localized course presentation", () => {
  it("roundtrips plain course content through product storage and safe catalog without replacing identity or price", async () => {
    const doc = product({ courseContent: content });
    await expect(doc.validate()).resolves.toBeUndefined();
    const restored = Product.hydrate(doc.toObject());
    const dto = toProductCatalogDto(restored);
    expect(dto.courseContent).toEqual(content);
    expect(dto).toMatchObject({
      id: String(doc._id),
      name: "Existing legacy course",
      price: 2000,
      maxNumberOfParticipants: 4,
    });
    expect(dto).not.toHaveProperty("createdBy");
  });

  it("keeps absent legacy content absent and accepts JSON multipart updates", () => {
    expect(product().toObject()).not.toHaveProperty("courseContent");
    expect(toProductCatalogDto(product())).not.toHaveProperty("courseContent");
    expect(
      updateProductSchema.parse({
        id: "507f1f77bcf86cd799439011",
        courseContent: JSON.stringify(content),
      }).courseContent,
    ).toEqual(content);
    expect(
      updateProductSchema.parse({
        id: "507f1f77bcf86cd799439011",
        price: 1800,
      }),
    ).not.toHaveProperty("courseContent");
  });

  it("supports optional unique publication locations without changing a class product location", async () => {
    const scoped = { ...content, locationIds: ["507f1f77bcf86cd799439013"] };
    const doc = product({ courseContent: scoped });
    await doc.validate();
    expect(toProductCatalogDto(doc).courseContent).toEqual(scoped);
    expect(doc.location ?? null).toBeNull();
    expect(updateProductSchema.parse({ id: "507f1f77bcf86cd799439011", courseContent: { ...content, locationIds: [] } }).courseContent?.locationIds).toEqual([]);
  });

  it.each([
    { ...content, name: { en: "<script>alert(1)</script>" } },
    { ...content, details: { en: "x".repeat(16001) } },
    { ...content, durationLabel: { en: "x".repeat(121) } },
    { ...content, images: Array(13).fill("https://cdn.example.com/a.jpg") },
    { ...content, images: ["javascript:alert(1)"] },
    { ...content, images: ["//untrusted.test/a.jpg"] },
    { ...content, locationIds: ["invalid"] },
    { ...content, locationIds: Array(2).fill("507f1f77bcf86cd799439013") },
    { ...content, arbitraryHtml: "<div>Hi</div>" },
    { ...content, name: { invented: "Unsupported locale" } },
  ])("rejects unsafe or unbounded content: %o", (courseContent) => {
    expect(
      updateProductSchema.safeParse({
        id: "507f1f77bcf86cd799439011",
        courseContent,
      }).success,
    ).toBe(false);
    expect(serializeCourseContent(courseContent)).toBeUndefined();
  });
});
