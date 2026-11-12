import { describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import sharp from "sharp";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import {
  DEFAULT_VOUCHER_DESIGN,
  VOUCHER_DESIGN_FONTS,
} from "@/modules/coupon/voucher-design.js";
import { normalizeVoucherGiftMessage } from "@/modules/coupon/voucher-delivery-design.js";
import {
  buildVoucherLayout,
  renderVoucherPdf,
  renderVoucherSvg,
  VoucherDesignRenderError,
  type VoucherRenderInput,
} from "@/modules/coupon/voucher-design.renderer.js";

const input = (): VoucherRenderInput => ({
  design: structuredClone(DEFAULT_VOUCHER_DESIGN),
  metadata: {
    promoCode: "KLEI-ABCD-1234",
    amountMinor: 125000,
    currency: "CZK",
    expiresAt: new Date("2027-09-15T21:59:59.999Z"),
    timezone: "Europe/Prague",
    locale: "cs",
  },
});

describe("voucher preview and PDF rendering", () => {
  it.each(["shario-sans-v1", "editorial-serif-v1"] as const)(
    "applies a custom main-title color in both SVG and PDF with %s",
    async (font) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.design.colors.title = "#FF0000";
      const layout = await buildVoucherLayout(fixture);
      const text = layout.elements.filter((item) => item.kind === "text");
      expect(text.find((item) => item.id === "title")?.color).toBe("#FF0000");
      expect(
        text
          .filter((item) => item.id !== "title")
          .every((item) => item.color === fixture.design.colors.text),
      ).toBe(true);
      expect(await renderVoucherSvg(fixture)).toContain(
        '<g aria-label="Gift voucher" fill="#FF0000">',
      );
      const pdf = await PDFDocument.load(await renderVoucherPdf(fixture));
      const content = pdf.context
        .enumerateIndirectObjects()
        .filter(([, object]) => object instanceof PDFRawStream)
        .map(([, object]) =>
          Buffer.from(
            decodePDFRawStream(object as PDFRawStream).decode(),
          ).toString(),
        )
        .join("\n");
      expect(content).toContain("1 0 0 rg");

      delete fixture.design.colors.title;
      fixture.design.colors.text = "#003366";
      const inherited = await buildVoucherLayout(fixture);
      expect(
        inherited.elements
          .filter((item) => item.kind === "text")
          .every((item) => item.color === "#003366"),
      ).toBe(true);
      expect(await renderVoucherSvg(fixture)).not.toContain('fill="#FF0000"');
    },
  );

  it.each([
    ["shario-sans-v1", "manrope", "manrope"],
    ["editorial-serif-v1", "playfair-display", "geist"],
    ["warm-serif-v1", "fraunces", "geist"],
    ["modern-condensed-v1", "barlow-condensed", "geist"],
  ] as const)(
    "renders %s with the website's real display and body faces in both title weights",
    async (font, display, body) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.design.content.title = "Dárkový poukaz";
      fixture.design.content.message = "Příliš žluťoučký kůň. Tvořte s námi!";
      for (const titleWeight of ["regular", "bold"] as const) {
        fixture.design.typography.titleWeight = titleWeight;
        const layout = await buildVoucherLayout(fixture);
        for (const [id, family] of [
          ["title", display],
          ["message", body],
        ]) {
          const element = layout.elements.find(
            (item) => item.kind === "text" && item.id === id,
          );
          expect(element?.kind).toBe("text");
          if (element?.kind === "text") {
            expect(element.glyphs.length).toBeGreaterThan(0);
            expect(
              element.glyphs.every((glyph) =>
                glyph.source.id.startsWith(`${family}-`),
              ),
            ).toBe(true);
          }
        }
        expect(await renderVoucherSvg(fixture)).toContain("Dárkový poukaz");
        const pdf = await PDFDocument.load(await renderVoucherPdf(fixture));
        expect(pdf.getPageCount()).toBe(1);
        if (font === "shario-sans-v1") {
          // Keep the existing outline rendering contract for the Shario family.
          const embeddedNames = pdf.context
            .enumerateIndirectObjects()
            .filter(([, object]) => object instanceof PDFDict)
            .map(([, object]) =>
              (object as PDFDict).get(PDFName.of("FontName"))?.toString(),
            );
          expect(embeddedNames.some((name) => name?.includes("Manrope"))).toBe(
            false,
          );
        }
      }
    },
  );

  it("embeds intact Czech serif outlines, including glyphs corrupted by short subset offsets", async () => {
    const fixture = input();
    fixture.design.typography.font = "serif";
    fixture.design.content.message =
      "Přijďte si vyzkoušet práci s hlínou. V ceně je veškerý materiál.";
    fixture.giftMessage =
      "Emilko, přejeme Ti krásné tvoření. Ať Tě hlína těší!";
    const layout = await buildVoucherLayout(fixture);
    const expected = new Map<string, string>();
    for (const element of layout.elements) {
      if (element.kind !== "text") continue;
      for (const glyph of element.glyphs) {
        if (["š", "ě", "ř", "ť"].includes(glyph.character)) {
          expected.set(
            `${glyph.source.face.postscriptName}:${glyph.character}`,
            glyph.outline.path.toSVG(),
          );
        }
      }
    }
    const found = new Set<string>();
    const pdf = await PDFDocument.load(await renderVoucherPdf(fixture));
    const streamBytes = (dictionary: PDFDict, key: string) => {
      const stream = dictionary.lookup(PDFName.of(key));
      if (!(stream instanceof PDFRawStream))
        throw new Error(`Expected a PDF stream for ${key}.`);
      return Buffer.from(decodePDFRawStream(stream).decode());
    };
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (
        !(object instanceof PDFDict) ||
        object.get(PDFName.of("Subtype")) !== PDFName.of("Type0")
      )
        continue;
      const cmap = streamBytes(object, "ToUnicode").toString("utf8");
      const descendant = object
        .lookup(PDFName.of("DescendantFonts"), PDFArray)
        .lookup(0, PDFDict);
      const descriptor = descendant.lookup(
        PDFName.of("FontDescriptor"),
        PDFDict,
      );
      const font = fontkit.create(streamBytes(descriptor, "FontFile2"));
      for (const match of cmap.matchAll(
        /^<([0-9a-f]+)> <(0161|011b|0159|0165)>$/gim,
      )) {
        const character = String.fromCodePoint(parseInt(match[2], 16));
        const key = `${font.postscriptName}:${character}`;
        if (!expected.has(key)) continue;
        expect(font.getGlyph(parseInt(match[1], 16)).path.toSVG(), key).toBe(
          expected.get(key),
        );
        found.add(key);
      }
    }
    expect(found).toEqual(new Set(expected.keys()));
    expect(found.size).toBeGreaterThanOrEqual(4);
  });

  it.each(VOUCHER_DESIGN_FONTS)(
    "prints a separate Czech gift message in %s without replacing tenant copy or moving redemption facts",
    async (font) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.design.content.message =
        "Přijďte si vyzkoušet práci s hlínou a užijte si chvíli pro sebe. "
          .repeat(7)
          .slice(0, 400)
          .trim();
      fixture.design.content.footer =
        "atelierklei.cz | Vše pro radost z tvorby.";
      const originalDesign = structuredClone(fixture.design);
      const original = await buildVoucherLayout(fixture);
      fixture.giftMessage =
        "Emilko, přejeme Ti spoustu krásných chvil při tvoření. S láskou máma a táta. "
          .repeat(4)
          .slice(0, 240)
          .trim();
      expect(
        fixture.design.content.message.length + fixture.giftMessage.length,
      ).toBeGreaterThan(400);
      const personalized = await buildVoucherLayout(fixture);
      const gift = personalized.elements.find(
        (element) => element.kind === "text" && element.id === "giftMessage",
      );
      expect(gift?.kind).toBe("text");
      if (gift?.kind === "text") {
        expect(gift.text).toBe(fixture.giftMessage);
        expect(gift.size).toBeGreaterThanOrEqual(9);
        expect(gift.glyphs.every((glyph) => glyph.outline.id !== 0)).toBe(true);
      }
      for (const id of ["message", "footer", "code", "expiry"]) {
        const before = original.elements.find(
          (element) => element.kind === "text" && element.id === id,
        );
        const after = personalized.elements.find(
          (element) => element.kind === "text" && element.id === id,
        );
        expect(after?.kind).toBe("text");
        if (before?.kind === "text" && after?.kind === "text") {
          expect(after.text).toBe(before.text);
          if (id !== "message") {
            expect(after.box).toEqual(before.box);
            expect(after.size).toBe(before.size);
          }
        }
      }
      expect(fixture.design).toEqual(originalDesign);
      const svg = await renderVoucherSvg(fixture);
      expect(svg).toContain("VĚNOVÁNÍ");
      expect(svg).toContain(fixture.giftMessage);
      const pdf = await PDFDocument.load(await renderVoucherPdf(fixture));
      expect(pdf.getPageCount()).toBe(1);
      expect(pdf.getPage(0).getSize()).toEqual({ width: 840, height: 400 });
    },
  );

  it("normalizes personal copy, escapes markup, and leaves the original layout intact for empty messages", async () => {
    expect(normalizeVoucherGiftMessage("  Da\u0301rek\r\ns láskou.  ")).toBe(
      "Dárek\ns láskou.",
    );
    const fixture = input();
    const originalSvg = await renderVoucherSvg(fixture);
    expect(await renderVoucherSvg({ ...fixture, giftMessage: "  \n " })).toBe(
      originalSvg,
    );
    const svg = await renderVoucherSvg({
      ...fixture,
      giftMessage: '<script>alert("dárek")</script> & text',
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain(
      "&lt;script&gt;alert(&quot;dárek&quot;)&lt;/script&gt; &amp; text",
    );
  });

  it.each([
    "x".repeat(241),
    "Dárek\u0000",
    "Dárek\u202e",
    "Dárek\u2067",
    "Dárek\u200b",
    "Dárek\u2060",
    "\ufeffDárek",
  ])(
    "rejects invalid personal copy before rendering: %j",
    async (giftMessage) => {
      await expect(
        renderVoucherSvg({ ...input(), giftMessage }),
      ).rejects.toMatchObject({
        code: "VOUCHER_GIFT_MESSAGE_INVALID",
        statusCode: 400,
      });
    },
  );

  it("rejects gift message overflow and unsupported glyphs without truncating customer copy", async () => {
    await expect(
      renderVoucherSvg({ ...input(), giftMessage: "a\n".repeat(20) }),
    ).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_TEXT_OVERFLOW",
      message: expect.stringContaining("voucher copy"),
    });
    await expect(
      renderVoucherSvg({ ...input(), giftMessage: "Darujte radost 🦄" }),
    ).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_UNSUPPORTED_CHARACTER",
    });
  });

  it.each(VOUCHER_DESIGN_FONTS)(
    "renders Czech, Latin and numbers with %s, retaining every glyph within its reserved box",
    async (font) => {
      const fixture = input();
      fixture.design.typography.font = font;
      fixture.design.content = {
        brandName: "Ateliér Klei - Brno, hlína a tvoření",
        title: "Dárkový poukaz",
        subtitle: "Příliš žluťoučký kůň úpěl ďábelské ódy",
        message:
          "Darujte radost z tvorby. Poukaz jednoduše uplatníte při rezervaci dílny na našem webu. V ceně je veškerý materiál i výpal.",
        footer: "atelierklei.cz | Člověk, který tvoří, dává světu něco svého.",
      };
      const layout = await buildVoucherLayout(fixture);
      for (const element of layout.elements) {
        if (element.kind !== "text") continue;
        for (const glyph of element.glyphs) {
          expect(
            glyph.outline.id,
            `${element.id}: ${glyph.character}`,
          ).not.toBe(0);
          expect(glyph.x).toBeGreaterThanOrEqual(element.box.x);
          expect(glyph.x + glyph.advance * glyph.size).toBeLessThanOrEqual(
            element.box.x + element.box.width + 0.001,
          );
          expect(
            glyph.baseline -
              (glyph.outline.bbox.maxY * glyph.size) /
                glyph.source.face.unitsPerEm,
          ).toBeGreaterThanOrEqual(element.box.y - 0.001);
          expect(
            glyph.baseline -
              (glyph.outline.bbox.minY * glyph.size) /
                glyph.source.face.unitsPerEm,
          ).toBeLessThanOrEqual(element.box.y + element.box.height + 0.001);
        }
      }
      const buffer = await renderVoucherPdf(fixture);
      const pdf = await PDFDocument.load(buffer);
      expect(pdf.getPageCount()).toBe(1);
      expect(pdf.getPage(0).getSize()).toEqual({ width: 840, height: 400 });
      expect(buffer.length).toBeGreaterThan(10000);
    },
  );

  it("renders the authoritative code and local expiration without a monetary block, forces sample codes and escapes template strings", async () => {
    const fixture = input();
    fixture.metadata.expiresAt = new Date("2027-09-16T00:30:00Z");
    fixture.metadata.timezone = "America/Los_Angeles";
    fixture.design.content.message = '<script>alert("hello")</script> & text';
    const real = await renderVoucherSvg(fixture);
    expect(real).toContain("KLEI-ABCD-1234");
    expect(real).not.toContain("1 250,00 Kč");
    expect(real).not.toContain("HODNOTA");
    expect(real).toContain("15. 9. 2027");
    expect(real).not.toContain("<script>");
    expect(real).toContain(
      "&lt;script&gt;alert(&quot;hello&quot;)&lt;/script&gt; &amp; text",
    );
    expect(real).not.toContain("<text");
    expect(real).not.toContain("@font-face");
    const sample = await renderVoucherSvg({ ...fixture, sample: true });
    expect(sample).not.toContain("KLEI-ABCD-1234");
    expect(sample).toContain("SAMPLE-0000-0000");
    expect(sample).toContain("VZOR - NELZE UPLATNIT");
    fixture.metadata.expiresAt = null;
    expect(await renderVoucherSvg(fixture)).toContain("Bez omezení");
  });

  it("wraps long Czech text and URLs, and rejects content that cannot fit instead of truncating", async () => {
    const fixture = input();
    fixture.design.content.title =
      "Žluťoučký dárkový poukaz plný zážitků pro přátele, rodiče i všechny tvořivé duše";
    fixture.design.content.message =
      "Přijďte si vyzkoušet práci s hlínou a užijte si chvíli pro sebe. "
        .repeat(6)
        .trim();
    fixture.design.content.footer = `https://atelierklei.cz/${"rezervace".repeat(14)}`;
    const layout = await buildVoucherLayout(fixture);
    const message = layout.elements.find(
      (element) => element.kind === "text" && element.id === "message",
    );
    expect(message?.kind).toBe("text");
    if (message?.kind === "text")
      expect(message.text).toBe(fixture.design.content.message);
    fixture.design.content.title = "a\n".repeat(30).trim();
    await expect(renderVoucherSvg(fixture)).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_TEXT_OVERFLOW",
      statusCode: 400,
    });
    fixture.design.content.title = "Darujte radost 🦄";
    await expect(renderVoucherSvg(fixture)).rejects.toBeInstanceOf(
      VoucherDesignRenderError,
    );
    await expect(renderVoucherSvg(fixture)).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_UNSUPPORTED_CHARACTER",
    });
  });

  it("uses matching image rectangles and clipping for cover, contain and transparent logos", async () => {
    const fixture = input();
    const photo = await sharp({
      create: { width: 400, height: 100, channels: 3, background: "#cc5500" },
    })
      .jpeg()
      .toBuffer();
    const logo = await sharp({
      create: {
        width: 100,
        height: 200,
        channels: 4,
        background: { r: 20, g: 20, b: 20, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    fixture.assets = { image: photo, logo };
    const cover = await buildVoucherLayout(fixture);
    const photoCover = cover.elements.find(
      (element) => element.kind === "image" && element.mime === "image/jpeg",
    );
    expect(photoCover?.kind).toBe("image");
    if (photoCover?.kind === "image") {
      expect(photoCover.box.height).toBe(photoCover.clipBox.height);
      expect(photoCover.box.width).toBeGreaterThan(photoCover.clipBox.width);
    }
    fixture.design.imageFit = "contain";
    const contain = await buildVoucherLayout(fixture);
    const photoContain = contain.elements.find(
      (element) => element.kind === "image" && element.mime === "image/jpeg",
    );
    if (photoContain?.kind === "image") {
      expect(photoContain.box.width).toBe(photoContain.clipBox.width);
      expect(photoContain.box.height).toBeLessThan(photoContain.clipBox.height);
    }
    const svg = await renderVoucherSvg(fixture);
    expect(svg).toContain("<clipPath");
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain("data:image/jpeg;base64,");
    expect(
      (await PDFDocument.load(await renderVoucherPdf(fixture))).getPageCount(),
    ).toBe(1);
    fixture.assets.image = Buffer.from("<svg onload='alert(1)'></svg>");
    await expect(renderVoucherSvg(fixture)).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_ASSET_INVALID",
    });
  });

  it("validates financial metadata even though amounts are not printed", async () => {
    const fixture = input();
    fixture.metadata.currency = "JPY";
    fixture.metadata.amountMinor = 1500;
    fixture.metadata.locale = "en";
    expect(await renderVoucherSvg(fixture)).not.toContain("JP¥1,500");
    fixture.metadata.currency = "INVALID";
    await expect(renderVoucherSvg(fixture)).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_METADATA_INVALID",
    });
    fixture.metadata.amountMinor = -100;
    await expect(renderVoucherSvg(fixture)).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_METADATA_INVALID",
    });
    fixture.metadata.currency = "EUR";
    fixture.metadata.amountMinor = 0;
    await expect(renderVoucherSvg(fixture)).rejects.toMatchObject({
      code: "VOUCHER_DESIGN_METADATA_INVALID",
    });
    expect(await renderVoucherSvg({ ...fixture, sample: true })).toContain(
      "SAMPLE-0000-0000",
    );
  });

  it.each(STUDIO_COMMERCE_CURRENCIES)(
    "accepts %s financial snapshots without rendering a monetary block",
    async (currency) => {
      const fixture = input();
      fixture.metadata.currency = currency;
      const originalMetadata = structuredClone(fixture.metadata);
      const layout = await buildVoucherLayout(fixture);
      expect(
        layout.elements.some(
          (element) =>
            element.kind === "text" &&
            ["amount", "amountLabel"].includes(element.id),
        ),
      ).toBe(false);
      expect(fixture.metadata).toEqual(originalMetadata);
    },
  );
});
