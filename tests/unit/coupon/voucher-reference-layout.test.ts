import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  DEFAULT_VOUCHER_DESIGN,
  VOUCHER_DESIGN_FONTS,
} from "@/modules/coupon/voucher-design.js";
import {
  buildVoucherLayout,
  type VoucherLayout,
  type VoucherRenderInput,
} from "@/modules/coupon/voucher-design.renderer.js";

type Box = { x: number; y: number; width: number; height: number };
type TextElement = Extract<VoucherLayout["elements"][number], { kind: "text" }>;

let photograph: Buffer;
beforeAll(async () => {
  photograph = await sharp({
    create: { width: 600, height: 600, channels: 3, background: "#987b62" },
  })
    .jpeg()
    .toBuffer();
});

const input = (): VoucherRenderInput => ({
  design: structuredClone(DEFAULT_VOUCHER_DESIGN),
  assets: { image: photograph },
  metadata: {
    promoCode: "KLEI-ABCD-1234",
    amountMinor: 150000,
    currency: "CZK",
    expiresAt: new Date("2027-09-17T21:59:59.999Z"),
    timezone: "Europe/Prague",
    locale: "cs",
  },
});

function text(layout: VoucherLayout, id: string): TextElement {
  const element = layout.elements.find(
    (item) => item.kind === "text" && item.id === id,
  );
  if (element?.kind !== "text") throw new Error(`Missing voucher text: ${id}`);
  return element;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

function expectTextToFit(layout: VoucherLayout) {
  const elements = layout.elements.filter((item) => item.kind === "text");
  for (const [index, element] of elements.entries()) {
    expect(element.box.x).toBeGreaterThanOrEqual(0);
    expect(element.box.y).toBeGreaterThanOrEqual(0);
    expect(element.box.x + element.box.width).toBeLessThanOrEqual(layout.width);
    expect(element.box.y + element.box.height).toBeLessThanOrEqual(
      layout.height,
    );
    // This catches dropped text as well as bounding boxes that fit but whose
    // glyphs escape into the neighboring metadata or photograph.
    expect(
      element.glyphs
        .map((glyph) => glyph.character)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(element.text.replace(/\s/g, ""));
    for (const glyph of element.glyphs) {
      expect(glyph.x).toBeGreaterThanOrEqual(element.box.x);
      expect(glyph.x + glyph.advance * glyph.size).toBeLessThanOrEqual(
        element.box.x + element.box.width + 0.001,
      );
      const scale = glyph.size / glyph.source.face.unitsPerEm;
      expect(
        glyph.baseline - glyph.outline.bbox.maxY * scale,
      ).toBeGreaterThanOrEqual(element.box.y - 0.001);
      expect(
        glyph.baseline - glyph.outline.bbox.minY * scale,
      ).toBeLessThanOrEqual(element.box.y + element.box.height + 0.001);
    }
    for (const other of elements.slice(index + 1)) {
      expect(
        overlaps(element.box, other.box),
        `${element.id} overlaps ${other.id}`,
      ).toBe(false);
    }
  }
}

describe("reference voucher composition", () => {
  it("uses equal halves with an edge-to-edge photograph and all redemption facts on the left", async () => {
    const fixture = input();
    fixture.sample = true;
    const layout = await buildVoucherLayout(fixture);
    expect({ width: layout.width, height: layout.height }).toEqual({
      width: 840,
      height: 400,
    });
    const photo = layout.elements.find((item) => item.kind === "image");
    if (photo?.kind !== "image") throw new Error("Missing voucher photograph");
    expect(photo.clipBox).toEqual({ x: 420, y: 0, width: 420, height: 400 });
    expect(photo.clipBox.y + photo.clipBox.height).toBe(400);

    for (const id of ["codeLabel", "code", "expiryLabel", "expiry", "sample"]) {
      expect(
        overlaps(text(layout, id).box, photo.clipBox),
        `${id} overlays the photograph`,
      ).toBe(false);
    }
    expect(
      layout.elements.some(
        (item) =>
          item.kind === "text" && ["amount", "amountLabel"].includes(item.id),
      ),
    ).toBe(false);
    for (const item of layout.elements) {
      if (item.kind === "text")
        expect(item.box.x + item.box.width).toBeLessThanOrEqual(420);
    }
    expect(text(layout, "code").text).toBe("SAMPLE-0000-0000");
    expect(text(layout, "sample").text).toBe("VZOR - NELZE UPLATNIT");
    // The only page-wide fill is the paper itself; no colored metadata strip.
    expect(
      layout.elements.filter(
        (item) => item.kind === "rect" && item.box.width === layout.width,
      ),
    ).toEqual([
      {
        kind: "rect",
        color: fixture.design.colors.background,
        box: { x: 0, y: 0, width: 840, height: 400 },
      },
    ]);
    expectTextToFit(layout);
  });

  it("uses an undecorated image panel when artwork is absent", async () => {
    const fixture = input();
    fixture.assets = {};
    const layout = await buildVoucherLayout(fixture);
    expect(layout.elements.some((item) => item.kind === "image")).toBe(false);
    const rectangles = layout.elements.filter((item) => item.kind === "rect");
    expect(rectangles).toHaveLength(3); // Paper, plain image panel, code rule.
    expect(
      rectangles.filter((item) => item.color === fixture.design.colors.accent),
    ).toEqual([
      {
        kind: "rect",
        color: fixture.design.colors.accent,
        box: { x: 420, y: 0, width: 420, height: 400 },
      },
    ]);
    expectTextToFit(layout);
  });

  it("keeps maximum footer copy separate from the non-redeemable sample marking", async () => {
    const fixture = input();
    fixture.sample = true;
    fixture.design.typography.font = "mono";
    fixture.design.content.footer =
      `https://atelierklei.cz/${"rezervace".repeat(18)}`.slice(0, 160);
    fixture.metadata.locale = "en";
    fixture.metadata.expiresAt = null;
    const layout = await buildVoucherLayout(fixture);
    expect(text(layout, "footer").text).toBe(fixture.design.content.footer);
    expect(text(layout, "sample").text).toBe("SAMPLE - NOT REDEEMABLE");
    expect(text(layout, "expiry").text).toBe("No expiry");
    expectTextToFit(layout);
  });

  it.each([false, true])(
    "retains previously accepted wide sans footers when sample=%s",
    async (sample) => {
      const fixture = input();
      fixture.sample = sample;
      fixture.design.typography.font = "sans";
      fixture.design.content.footer = "W".repeat(160);
      fixture.metadata.promoCode = "W".repeat(64);
      const layout = await buildVoucherLayout(fixture);
      expect(text(layout, "footer").text).toBe(fixture.design.content.footer);
      expect(text(layout, "footer").size).toBeGreaterThanOrEqual(7.5);
      expectTextToFit(layout);
    },
  );

  it.each(VOUCHER_DESIGN_FONTS)(
    "retains dense previously accepted purchased copy in %s without shrinking personal/body copy below their floors",
    async (font) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.design.content.title = "W".repeat(80);
      fixture.design.content.subtitle = "W".repeat(120);
      fixture.design.content.message =
        "Přijďte si vyzkoušet práci s hlínou a užijte si chvíli pro sebe. "
          .repeat(7)
          .slice(0, 400)
          .trim();
      fixture.giftMessage = "W".repeat(240);
      const layout = await buildVoucherLayout(fixture);
      expect(text(layout, "title").text).toBe(fixture.design.content.title);
      expect(text(layout, "subtitle").text).toBe(
        fixture.design.content.subtitle,
      );
      expect(text(layout, "message").text).toBe(fixture.design.content.message);
      expect(text(layout, "giftMessage").text).toBe(fixture.giftMessage);
      expect(text(layout, "title").size).toBeGreaterThanOrEqual(12);
      expect(text(layout, "message").size).toBeGreaterThanOrEqual(7.5);
      expect(text(layout, "giftMessage").size).toBeGreaterThanOrEqual(9);
      const photo = layout.elements.find((item) => item.kind === "image");
      if (photo?.kind !== "image")
        throw new Error("Missing voucher photograph");
      expect(photo.clipBox).toEqual({ x: 420, y: 0, width: 420, height: 400 });
      expectTextToFit(layout);
    },
  );

  it.each(["transparent", "white"] as const)(
    "sizes the visible logo rather than its padded %s upload canvas",
    async (background) => {
      const ink = await sharp({
        create: { width: 100, height: 30, channels: 4, background: "#3266da" },
      })
        .png()
        .toBuffer();
      const logo = await sharp({
        create: {
          width: 400,
          height: 400,
          channels: 4,
          background:
            background === "transparent"
              ? { r: 0, g: 0, b: 0, alpha: 0 }
              : "#ffffff",
        },
      })
        .composite([{ input: ink, left: 150, top: 185 }])
        .png()
        .toBuffer();
      const fixture = input();
      fixture.assets!.logo = logo;
      const layout = await buildVoucherLayout(fixture);
      const logoElement = layout.elements.find(
        (item) => item.kind === "image" && item.mime === "image/png",
      );
      if (logoElement?.kind !== "image")
        throw new Error("Missing trimmed voucher logo");
      expect(logoElement.image.width).toBe(100);
      expect(logoElement.image.height).toBe(30);
      expect(logoElement.box.x).toBe(32);
      expect(logoElement.box.y).toBe(28);
      expect(logoElement.box.width).toBeCloseTo(120);
      expect(logoElement.box.height).toBeCloseTo(36);
      expectTextToFit(layout);
    },
  );

  it("uses the reference semibold display weight while retaining regular copy", async () => {
    const fixture = input();
    fixture.design.typography.font = "shario-sans-v1";
    fixture.design.content.footer = "atelierklei.cz";
    const layout = await buildVoucherLayout(fixture);
    for (const id of ["brandName", "title", "subtitle", "footer"]) {
      expect(
        text(layout, id).glyphs.every(
          (glyph) => glyph.source.id === "manrope-semibold",
        ),
      ).toBe(true);
    }
    expect(
      text(layout, "message").glyphs.every(
        (glyph) => glyph.source.id === "manrope-regular",
      ),
    ).toBe(true);
    fixture.design.typography.titleWeight = "regular";
    const regular = await buildVoucherLayout(fixture);
    expect(
      text(regular, "title").glyphs.every(
        (glyph) => glyph.source.id === "manrope-regular",
      ),
    ).toBe(true);
  });

  it.each(["shario-sans-v1", "serif"] as const)(
    "fits a wide 64-character code left of the image without touching expiry or footer in %s",
    async (font) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.metadata.promoCode = "W".repeat(64);
      const layout = await buildVoucherLayout(fixture);
      const code = text(layout, "code");
      const photo = layout.elements.find((item) => item.kind === "image");
      const rule = layout.elements.find(
        (item) => item.kind === "rect" && item.box.height < 1,
      );
      if (photo?.kind !== "image" || rule?.kind !== "rect") {
        throw new Error("Missing voucher photograph or code rule");
      }
      expect(code.box.x + code.box.width).toBeLessThanOrEqual(photo.clipBox.x);
      expect(code.box.y).toBeGreaterThan(rule.box.y);
      expect(code.box.y + code.box.height).toBeLessThan(354);
      expect(code.size).toBeGreaterThanOrEqual(8);
      expectTextToFit(layout);
    },
  );

  it.each(VOUCHER_DESIGN_FONTS)(
    "keeps long personalized copy and extreme redemption metadata complete in %s",
    async (font) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.design.content.brandName =
        "Ateliér Klei - prostor pro keramiku, tvorbu a společné zážitky".slice(
          0,
          60,
        );
      fixture.design.content.subtitle =
        "Přijďte tvořit s námi a darujte krásné chvíle. "
          .repeat(3)
          .slice(0, 120)
          .trim();
      fixture.design.content.title =
        "Žluťoučký dárkový poukaz plný zážitků pro přátele, rodiče i všechny tvořivé duše";
      fixture.design.content.message =
        "Přijďte si vyzkoušet práci s hlínou a užijte si chvíli pro sebe. "
          .repeat(7)
          .slice(0, 400)
          .trim();
      fixture.design.content.footer =
        `https://atelierklei.cz/${"rezervace".repeat(18)}`.slice(0, 160);
      fixture.giftMessage =
        "Emilko, přejeme Ti spoustu krásných chvil při tvoření. S láskou máma a táta. "
          .repeat(4)
          .slice(0, 240)
          .trim();
      fixture.metadata.promoCode = "W".repeat(64);
      fixture.metadata.amountMinor = Number.MAX_SAFE_INTEGER;
      const layout = await buildVoucherLayout(fixture);
      expect(text(layout, "code").text).toBe(fixture.metadata.promoCode);
      expect(
        layout.elements.some(
          (item) => item.kind === "text" && item.id === "amount",
        ),
      ).toBe(false);
      expect(text(layout, "expiry").text).toBe("17. 9. 2027");
      expect(text(layout, "title").text).toBe(fixture.design.content.title);
      expect(text(layout, "message").text).toBe(fixture.design.content.message);
      expect(text(layout, "giftMessage").text).toBe(fixture.giftMessage);
      const photo = layout.elements.find((item) => item.kind === "image");
      if (photo?.kind !== "image")
        throw new Error("Missing personalized voucher photograph");
      expect(photo.clipBox).toEqual({ x: 420, y: 0, width: 420, height: 400 });
      for (const item of layout.elements) {
        if (item.kind === "text")
          expect(
            overlaps(item.box, photo.clipBox),
            `${item.id} overlays the photograph`,
          ).toBe(false);
      }
      expectTextToFit(layout);
    },
  );
});
