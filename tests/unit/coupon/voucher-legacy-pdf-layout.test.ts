import { describe, expect, it } from "vitest";
import {
  degrees,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";

import { modifyPromoCodePdf } from "@/infrastructure/pdf/pdf.utils.js";

const templates = [
  "coupon-templates/Atelier_Klei_Poukaz_04_Toceni_na_kruhu_pro_zacatecniky.pdf",
  "coupon-templates/Atelier_Klei_Poukaz_06_Glazovani.pdf",
  "coupon-templates/Atelier_Klei_Poukaz_07_Clay_play_Zakladni_modelovani.pdf",
  "coupon-templates/poukaz-v-hodnot-500-k-e817b36e-09dc-41ac-bb32-7bf680dfacc7.pdf",
  "coupon-templates/Atelier_Klei_Poukaz_1500_Kc.pdf",
  "coupon-templates/Atelier_Klei_Poukaz_2000_Kc.pdf",
  "coupon-templates/Atelier_Klei_Poukaz_1000_Kc.pdf",
];

async function template({
  size = [595.2, 283.44],
  rotation = 0,
  cropped = false,
}: { size?: number[]; rotation?: number; cropped?: boolean } = {}) {
  const document = await PDFDocument.create();
  const page = document.addPage([size[0], size[1]]);
  page.setRotation(degrees(rotation));
  if (cropped) page.setCropBox(5, 5, size[0] - 10, size[1] - 10);
  page.drawLine({ start: { x: 401, y: 21.5 }, end: { x: 572.28, y: 21.5 } });
  return Buffer.from(await document.save());
}

async function readPrintedCode(buffer: Buffer) {
  const document = await PDFDocument.load(buffer);
  const content = document.context.enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream)
    .map(([, object]) => Buffer.from(decodePDFRawStream(object as PDFRawStream).decode()).toString())
    .join("\n");
  const printed = content.match(/\/Helvetica-\S+ ([\d.]+) Tf[\s\S]*?1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*<([A-Fa-f0-9]+)> Tj/);
  if (!printed) throw new Error("No printed voucher code in generated PDF");
  return {
    document,
    content,
    size: Number(printed[1]),
    x: Number(printed[2]),
    y: Number(printed[3]),
    text: Buffer.from(printed[4], "hex").toString(),
    font: await document.embedFont(StandardFonts.Helvetica),
  };
}

describe("historical voucher PDF code placement", () => {
  it.each(templates)("centers the code above the printed line on %s", async (templateKey) => {
    const printed = await readPrintedCode(await modifyPromoCodePdf({
      promoCode: "ABC-DEF-123",
      templateBuffer: await template(),
      templateKey,
    }));
    const width = printed.font.widthOfTextAtSize(printed.text, printed.size);
    const descent = printed.font.heightAtSize(printed.size) - printed.font.heightAtSize(printed.size, { descender: false });

    expect(printed.text).toBe("ABC-DEF-123");
    expect(printed.size).toBe(8.5);
    expect(printed.x + width / 2).toBeCloseTo(486.64, 6);
    expect(printed.x).toBeGreaterThan(401);
    expect(printed.x + width).toBeLessThan(572.28);
    expect(printed.y - descent).toBeGreaterThan(21.5);
    expect(printed.y).toBe(26);
    expect(printed.document.getPages()[0].getSize()).toEqual({ width: 595.2, height: 283.44 });
    expect(printed.content).toContain("401 21.5 m");
    expect(printed.content).toContain("572.28 21.5 l");
  });

  it("fits a long historical reference within the same printed line", async () => {
    const printed = await readPrintedCode(await modifyPromoCodePdf({
      promoCode: "W".repeat(64),
      templateBuffer: await template(),
      templateKey: templates[0],
    }));
    const width = printed.font.widthOfTextAtSize(printed.text, printed.size);
    expect(printed.text).toBe("W".repeat(64));
    expect(printed.x).toBeCloseTo(401, 6);
    expect(printed.x + width).toBeCloseTo(572.28, 6);
    expect(printed.size).toBeLessThan(8.5);
    expect(printed.y).toBe(26);
  });

  it.each([
    { label: "an unrelated same-sized template", templateKey: "coupon-templates/another-studio.pdf" },
    { label: "a template without a saved key", templateKey: undefined },
    { label: "a similarly named replacement", templateKey: `${templates[0]}.replacement` },
    { label: "a different page size", templateKey: templates[0], size: [842, 595] },
    { label: "a rotated page", templateKey: templates[0], rotation: 90 },
    { label: "a cropped page", templateKey: templates[0], cropped: true },
  ])("preserves existing coordinates for $label", async ({ templateKey, ...options }) => {
    const printed = await readPrintedCode(await modifyPromoCodePdf({
      promoCode: "ABC-DEF-123",
      templateBuffer: await template(options),
      templateKey,
    }));
    expect({ x: printed.x, y: printed.y, size: printed.size }).toEqual({ x: 428, y: 17, size: 8 });
  });
});
