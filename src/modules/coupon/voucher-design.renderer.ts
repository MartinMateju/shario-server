import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import sharp from "sharp";
import {
  PDFDocument,
  rgb,
  clip,
  endPath,
  rectangle,
  pushGraphicsState,
  popGraphicsState,
  scale,
  translate,
  type PDFFont,
  type PDFImage,
} from "pdf-lib";
import { AppError } from "@/shared/http/AppError.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import { normalizeVoucherTimezone } from "./voucher-policy.js";
import { normalizeVoucherGiftMessage } from "./voucher-delivery-design.js";
import {
  normalizeVoucherDesign,
  type VoucherDesign,
} from "./voucher-design.js";

export class VoucherDesignRenderError extends AppError {
  constructor(code: string, message: string) {
    super({ code, message, statusCode: 400 });
    this.name = "VoucherDesignRenderError";
  }
}
const fail = (code: string, message: string): never => {
  throw new VoucherDesignRenderError(code, message);
};

export type VoucherRenderMetadata = {
  promoCode: string;
  amountMinor: number;
  currency: string;
  expiresAt: Date | null;
  timezone: string;
  locale: string;
  productName?: string;
};
export type VoucherRenderInput = {
  design: VoucherDesign;
  /** Only trusted, normalized PNG/JPEG bytes. Asset fetching belongs to the tenant service. */
  assets?: { logo?: Buffer; image?: Buffer };
  metadata: VoucherRenderMetadata;
  /** Optional purchase-specific copy; never overwrites the tenant's message. */
  giftMessage?: string;
  sample?: boolean;
};
export const VOUCHER_PAGE = { width: 840, height: 400 } as const;
type Box = { x: number; y: number; width: number; height: number };
type Weight = "regular" | "bold" | "semibold";
type FontSource = {
  id: string;
  bytes: Buffer;
  face: any;
  /** Fontshare fonts are rendered as artwork, never redistributed in a PDF. */
  outlineOnly?: boolean;
};
type FontRole = "body" | "display" | "label";
type Glyph = {
  character: string;
  source: FontSource;
  outline: any;
  advance: number;
};
type PositionedGlyph = Glyph & { x: number; baseline: number; size: number };
type TextElement = {
  kind: "text";
  id: string;
  text: string;
  box: Box;
  color: string;
  glyphs: PositionedGlyph[];
  size: number;
};
type RectElement = { kind: "rect"; box: Box; color: string };
type ImageElement = {
  kind: "image";
  box: Box;
  clipBox: Box;
  bytes: Buffer;
  mime: "image/png" | "image/jpeg";
  image: PDFImage;
};
type Element = TextElement | RectElement | ImageElement;
export type VoucherLayout = {
  width: number;
  height: number;
  elements: Element[];
};
type Context = {
  pdf: PDFDocument;
  fonts: Record<FontRole, Record<Weight, FontSource[]>>;
  embedded: Map<string, PDFFont>;
};

const require = createRequire(import.meta.url);
const fontCache = new Map<string, Promise<FontSource[]>>();
type FontFamily =
  | "noto-sans"
  | "noto-serif"
  | "noto-sans-mono"
  | "manrope"
  | "geist"
  | "playfair-display"
  | "fraunces"
  | "barlow-condensed";

// Shario sans uses the same Manrope family as the client. Other saved font
// choices keep their existing display/body pairings for compatibility.
const FONT_PRESETS: Record<
  VoucherDesign["typography"]["font"],
  Record<FontRole, FontFamily>
> = {
  "shario-sans-v1": { body: "manrope", display: "manrope", label: "manrope" },
  "editorial-serif-v1": {
    body: "geist",
    display: "playfair-display",
    label: "geist",
  },
  "warm-serif-v1": { body: "geist", display: "fraunces", label: "geist" },
  "modern-condensed-v1": {
    body: "geist",
    display: "barlow-condensed",
    label: "barlow-condensed",
  },
  sans: { body: "noto-sans", display: "noto-sans", label: "noto-sans" },
  serif: { body: "noto-serif", display: "noto-serif", label: "noto-serif" },
  mono: {
    body: "noto-sans-mono",
    display: "noto-sans-mono",
    label: "noto-sans-mono",
  },
};

/**
 * Restore the bundled WOFF1 language subset to its original sfnt representation.
 * Embedding it intact avoids fontkit's second-subset loca offset rounding bug,
 * which otherwise turns some Czech serif glyphs into blank spaces in PDFs.
 * This accepts packaged dependencies only, never user-supplied font bytes.
 * Container format: https://www.w3.org/TR/WOFF/#WOFFHeader
 */
function unpackBundledWoff(woff: Buffer): Buffer {
  if (woff.length < 44 || woff.readUInt32BE(0) !== 0x774f4646)
    throw new Error("Bundled voucher font must use WOFF1.");
  const count = woff.readUInt16BE(12);
  const totalSize = woff.readUInt32BE(16);
  if (
    count < 1 ||
    44 + count * 20 > woff.length ||
    totalSize < 12 + count * 16 ||
    totalSize % 4 !== 0 ||
    totalSize > 2 * 1024 * 1024
  )
    throw new Error("Bundled voucher font directory is invalid.");
  const sfnt = Buffer.alloc(totalSize);
  woff.copy(sfnt, 0, 4, 8);
  const selector = Math.floor(Math.log2(count));
  sfnt.writeUInt16BE(count, 4);
  sfnt.writeUInt16BE(2 ** selector * 16, 6);
  sfnt.writeUInt16BE(selector, 8);
  sfnt.writeUInt16BE(count * 16 - 2 ** selector * 16, 10);
  let offset = 12 + count * 16;
  let headOffset: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = 44 + index * 20;
    const sourceOffset = woff.readUInt32BE(entry + 4);
    const compressedLength = woff.readUInt32BE(entry + 8);
    const length = woff.readUInt32BE(entry + 12);
    if (
      compressedLength > length ||
      sourceOffset + compressedLength > woff.length ||
      offset + length > sfnt.length
    )
      throw new Error("Bundled voucher font table is invalid.");
    const compressed = woff.subarray(
      sourceOffset,
      sourceOffset + compressedLength,
    );
    const table =
      compressedLength === length
        ? compressed
        : inflateSync(compressed, { maxOutputLength: length });
    if (table.length !== length)
      throw new Error("Bundled voucher font table size is invalid.");
    const target = 12 + index * 16;
    woff.copy(sfnt, target, entry, entry + 4);
    sfnt.writeUInt32BE(woff.readUInt32BE(entry + 16), target + 4);
    sfnt.writeUInt32BE(offset, target + 8);
    sfnt.writeUInt32BE(length, target + 12);
    table.copy(sfnt, offset);
    if (woff.toString("ascii", entry, entry + 4) === "head") {
      if (length < 12)
        throw new Error("Bundled voucher font header is invalid.");
      headOffset = offset;
    }
    offset += Math.ceil(length / 4) * 4;
  }
  if (offset !== totalSize || headOffset === undefined)
    throw new Error("Bundled voucher font structure is invalid.");
  // Table order may differ from the source sfnt, so recompute the whole-font sum.
  sfnt.writeUInt32BE(0, headOffset + 8);
  let sum = 0;
  for (let index = 0; index < sfnt.length; index += 4)
    sum = (sum + sfnt.readUInt32BE(index)) >>> 0;
  sfnt.writeUInt32BE((0xb1b0afba - sum) >>> 0, headOffset + 8);
  return sfnt;
}

const loadFont = (
  family: FontFamily,
  weight: Weight,
): Promise<FontSource[]> => {
  const key = `${family}-${weight}`;
  if (!fontCache.has(key)) {
    const loading = (async (): Promise<FontSource[]> => {
      let sources: FontSource[];
      const legacy = family.startsWith("noto-");
      if (family === "manrope") {
        const name =
          weight === "semibold"
            ? "Semibold"
            : weight === "bold"
              ? "Bold"
              : "Regular";
        const bytes = await readFile(
          new URL(
            `../../../assets/fonts/manrope/Manrope-${name}.ttf`,
            import.meta.url,
          ),
        );
        sources = [
          {
            id: `manrope-${weight}`,
            bytes,
            face: fontkit.create(bytes),
            outlineOnly: true,
          },
        ];
      } else {
        const subsets = legacy
          ? ["latin", "latin-ext", "cyrillic", "greek"]
          : ["latin", "latin-ext"];
        sources = await Promise.all(
          subsets.map(async (subset) => {
            const id = `${family}-${subset}-${weight === "bold" ? 700 : 400}-normal`;
            const woff = await readFile(
              require.resolve(`@fontsource/${family}/files/${id}.woff`),
            );
            const bytes = unpackBundledWoff(woff);
            return { id, bytes, face: fontkit.create(bytes) };
          }),
        );
      }
      // Currency symbols and scripts outside a display face's repertoire remain
      // printable; Latin/Czech characters always use the selected website face.
      return legacy
        ? sources
        : [...sources, ...(await loadFont("noto-sans", weight))];
    })();
    fontCache.set(key, loading);
    // An intermittent filesystem failure should not poison every future render.
    void loading.catch(() => {
      fontCache.delete(key);
    });
  }
  return fontCache.get(key)!;
};

const glyphsFor = (text: string, sources: FontSource[]): Glyph[] =>
  Array.from(text).map((character) => {
    const codePoint = character.codePointAt(0)!;
    const source = sources.find(({ face }) =>
      face.hasGlyphForCodePoint(codePoint),
    );
    if (!source) {
      fail(
        "VOUCHER_DESIGN_UNSUPPORTED_CHARACTER",
        `The selected voucher font cannot display ${character} (U+${codePoint.toString(16).toUpperCase()}). Use another character.`,
      );
    }
    const outline = source.face.glyphForCodePoint(codePoint);
    return {
      character,
      source,
      outline,
      advance: outline.advanceWidth / source.face.unitsPerEm,
    };
  });

/** Explicit glyph advances are shared by print and preview; browser font fallback never participates. */
function wrappedLines(
  text: string,
  sources: FontSource[],
  size: number,
  width: number,
): Glyph[][] {
  const result: Glyph[][] = [];
  for (const paragraph of text.replace(/\t/g, "    ").split("\n")) {
    let line: Glyph[] = [];
    let lineWidth = 0;
    for (const word of paragraph.split(/ +/)) {
      if (!word) continue;
      const letters = glyphsFor(word, sources);
      const wordWidth = letters.reduce(
        (sum, letter) => sum + letter.advance * size,
        0,
      );
      const space = glyphsFor(" ", sources)[0];
      if (line.length && lineWidth + space.advance * size + wordWidth > width) {
        result.push(line);
        line = [];
        lineWidth = 0;
      }
      if (line.length) {
        line.push(space);
        lineWidth += space.advance * size;
      }
      // A long URL or unbroken title is split safely without dropping content.
      for (const letter of letters) {
        if (line.length && lineWidth + letter.advance * size > width) {
          result.push(line);
          line = [];
          lineWidth = 0;
        }
        line.push(letter);
        lineWidth += letter.advance * size;
      }
    }
    result.push(line);
  }
  return result;
}

function textElement(input: {
  id: string;
  text: string;
  box: Box;
  color: string;
  fonts: FontSource[];
  preferredSize: number;
  minimumSize: number;
  lineSpacing?: number;
  overflowBox?: Box;
  fitContent?: boolean;
}): TextElement | null {
  if (!input.text) return null;
  const normalized = input.text.normalize("NFC");
  for (let size = input.preferredSize; size >= input.minimumSize; size -= 0.5) {
    const lines = wrappedLines(normalized, input.fonts, size, input.box.width);
    const glyphs = lines.flat();
    const ascent =
      Math.max(
        0.72,
        ...glyphs.map(
          ({ outline, source }) => outline.bbox.maxY / source.face.unitsPerEm,
        ),
      ) * size;
    const descent =
      Math.max(
        0.22,
        ...glyphs.map(
          ({ outline, source }) => -outline.bbox.minY / source.face.unitsPerEm,
        ),
      ) * size;
    const lineHeight = Math.max(
      size * (input.lineSpacing ?? 1.28),
      ascent + descent,
    );
    const height = ascent + descent + (lines.length - 1) * lineHeight;
    const maxWidth = Math.max(
      0,
      ...lines.map((line) =>
        line.reduce((sum, item) => sum + item.advance * size, 0),
      ),
    );
    if (height > input.box.height || maxWidth > input.box.width + 0.001)
      continue;
    const positioned: PositionedGlyph[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      let x = input.box.x;
      for (const glyph of lines[index]) {
        positioned.push({
          ...glyph,
          x,
          baseline: input.box.y + ascent + index * lineHeight,
          size,
        });
        x += glyph.advance * size;
      }
    }
    return {
      kind: "text",
      id: input.id,
      text: normalized,
      color: input.color,
      box: input.fitContent ? { ...input.box, height } : input.box,
      glyphs: positioned,
      size,
    };
  }
  if (input.overflowBox) {
    return textElement({
      ...input,
      box: input.overflowBox,
      overflowBox: undefined,
    });
  }
  return fail(
    "VOUCHER_DESIGN_TEXT_OVERFLOW",
    `The ${input.id} text is too long for this voucher layout. Please shorten it or remove extra line breaks.`,
  );
}

const hexRgb = (color: string) =>
  [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);

function metadataText(input: VoucherRenderInput) {
  const { metadata } = input;
  if (
    !metadata ||
    typeof metadata.promoCode !== "string" ||
    metadata.promoCode.length < 1 ||
    metadata.promoCode.length > 64 ||
    /[\u0000-\u0020\u007f-\u009f]/u.test(metadata.promoCode) ||
    !Number.isSafeInteger(metadata.amountMinor) ||
    metadata.amountMinor < (input.sample ? 0 : 1) ||
    typeof metadata.locale !== "string" ||
    metadata.locale.length > 35 ||
    (metadata.expiresAt !== null &&
      (!(metadata.expiresAt instanceof Date) ||
        !Number.isFinite(metadata.expiresAt.getTime())))
  ) {
    fail(
      "VOUCHER_DESIGN_METADATA_INVALID",
      "Voucher value, code, locale or expiration metadata is invalid.",
    );
  }
  const locale = metadata.locale.toLowerCase().startsWith("cs")
    ? "cs-CZ"
    : "en-GB";
  try {
    // Financial metadata remains authoritative and validated, even though the
    // gift artwork intentionally prints only the redemption code and expiry.
    normalizeStudioCommerceCurrency(metadata.currency);
  } catch {
    fail("VOUCHER_DESIGN_METADATA_INVALID", "Voucher currency is invalid.");
  }
  const cs = locale === "cs-CZ";
  const expiry = metadata.expiresAt
    ? new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "numeric",
        year: "numeric",
        timeZone: normalizeVoucherTimezone(metadata.timezone),
      }).format(metadata.expiresAt)
    : cs
      ? "Bez omezení"
      : "No expiry";
  return {
    code: input.sample ? "SAMPLE-0000-0000" : metadata.promoCode,
    expiry,
    codeLabel: cs ? "KÓD POUKAZU" : "VOUCHER CODE",
    expiryLabel: cs ? "PLATNOST DO" : "VALID UNTIL",
    sampleLabel: cs ? "VZOR - NELZE UPLATNIT" : "SAMPLE - NOT REDEEMABLE",
    giftMessageLabel: cs ? "VĚNOVÁNÍ" : "PERSONAL MESSAGE",
  };
}

async function imageElement(
  pdf: PDFDocument,
  bytes: Buffer,
  box: Box,
  fit: "cover" | "contain",
  align: "center" | "start" = "center",
): Promise<ImageElement> {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 8 ||
    bytes.length > 12 * 1024 * 1024
  ) {
    return fail(
      "VOUCHER_DESIGN_ASSET_INVALID",
      "Voucher image data is invalid.",
    );
  }
  let png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg)
    return fail(
      "VOUCHER_DESIGN_ASSET_INVALID",
      "Voucher images must be normalized PNG or JPEG files.",
    );
  let image: PDFImage;
  try {
    if (align === "start") {
      // Uploaded wordmarks often sit inside a much larger transparent/white
      // canvas. Measure the visible logo so that its left edge and visual size
      // match the print layout instead of centering a tiny mark in that canvas.
      bytes = await sharp(bytes, { limitInputPixels: 24_000_000 })
        .trim({ threshold: 4 })
        .png()
        .toBuffer();
      png = true;
    }
    image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch {
    return fail(
      "VOUCHER_DESIGN_ASSET_INVALID",
      "Voucher image could not be read.",
    );
  }
  const ratio =
    fit === "cover"
      ? Math.max(box.width / image.width, box.height / image.height)
      : Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * ratio;
  const height = image.height * ratio;
  return {
    kind: "image",
    bytes,
    image,
    mime: png ? "image/png" : "image/jpeg",
    clipBox: box,
    box: {
      x: box.x + (align === "start" ? 0 : (box.width - width) / 2),
      y: box.y + (align === "start" ? 0 : (box.height - height) / 2),
      width,
      height,
    },
  };
}

async function prepare(
  input: VoucherRenderInput,
): Promise<{ context: Context; layout: VoucherLayout }> {
  const design = normalizeVoucherDesign(input.design);
  const giftMessage = normalizeVoucherGiftMessage(input.giftMessage);
  const meta = metadataText(input);
  const preset = FONT_PRESETS[design.typography.font];
  const fonts = {} as Context["fonts"];
  await Promise.all(
    (Object.keys(preset) as FontRole[]).map(async (role) => {
      const [regular, bold, semibold] = await Promise.all([
        loadFont(preset[role], "regular"),
        loadFont(preset[role], "bold"),
        loadFont(
          preset[role],
          preset[role] === "manrope" ? "semibold" : "bold",
        ),
      ]);
      fonts[role] = { regular, bold, semibold };
    }),
  );
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const context: Context = {
    pdf,
    fonts,
    embedded: new Map(),
  };
  const elements: Element[] = [];
  const makeText = (
    id: string,
    text: string,
    box: Box,
    preferredSize: number,
    minimumSize: number,
    weight: Weight = "regular",
    color = design.colors.text,
    lineSpacing?: number,
    fitContent = false,
  ) => {
    const role: FontRole = ["brandName", "title", "subtitle"].includes(id)
      ? "display"
      : id.endsWith("Label") || id === "sample"
        ? "label"
        : "body";
    // The reference uses Manrope 600 for display copy, with regular body copy.
    const faceWeight =
      weight === "bold" &&
      preset[role] === "manrope" &&
      ["brandName", "title", "subtitle", "footer"].includes(id)
        ? "semibold"
        : weight;
    const item = textElement({
      id,
      text,
      box,
      preferredSize,
      minimumSize,
      fonts: context.fonts[role][faceWeight],
      color,
      lineSpacing,
      fitContent,
    });
    return item;
  };
  const addText = (...args: Parameters<typeof makeText>) => {
    const item = makeText(...args);
    if (item) elements.push(item);
  };
  elements.push({
    kind: "rect",
    color: design.colors.background,
    box: { x: 0, y: 0, ...VOUCHER_PAGE },
  });
  // Both halves are exact and shared by print/preview. Artwork never competes
  // with redemption facts or the optional purchase-specific personal message.
  const left = 32;
  const leftWidth = 356;
  const imageBox = { x: 420, y: 0, width: 420, height: 400 };
  if (input.assets?.image) {
    elements.push(
      await imageElement(pdf, input.assets.image, imageBox, design.imageFit),
    );
  } else {
    // The tenant accent supplies a deliberate, quiet fallback without fake
    // photography, instructional placeholder copy or a platform watermark.
    elements.push({ kind: "rect", color: design.colors.accent, box: imageBox });
  }
  if (input.assets?.logo) {
    elements.push(
      await imageElement(
        pdf,
        input.assets.logo,
        { x: left, y: 28, width: 120, height: 42 },
        "contain",
        "start",
      ),
    );
    addText(
      "brandName",
      design.content.brandName,
      { x: 168, y: 30, width: 220, height: 42 },
      21,
      9,
      "bold",
    );
  } else {
    addText(
      "brandName",
      design.content.brandName,
      { x: left, y: 28, width: leftWidth, height: 44 },
      30,
      10,
      "bold",
    );
  }

  // Size the complete text stack together: short copy stays generous, while
  // long translations/personal messages use the available left-hand space.
  // No editable copy is truncated, and the fixed code/expiry area cannot move.
  const blocks: {
    id: string;
    text: string;
    preferred: number;
    minimum: number;
    compactMinimum?: number;
    weight?: Weight;
    color?: string;
    spacing?: number;
  }[] = [
    {
      id: "title",
      text: design.content.title,
      preferred: 46,
      minimum: 17,
      compactMinimum: 12,
      weight: design.typography.titleWeight,
      color: design.colors.title ?? design.colors.text,
      spacing: 1.04,
    },
    {
      id: "subtitle",
      text: design.content.subtitle,
      preferred: 22,
      minimum: 10,
      compactMinimum: 8,
      weight: "bold",
      spacing: 1.12,
    },
    {
      id: "message",
      text: design.content.message,
      preferred: 13,
      minimum: 7.5,
      spacing: 1.2,
    },
    ...(giftMessage
      ? [
          {
            id: "giftMessageLabel",
            text: meta.giftMessageLabel,
            preferred: 8,
            minimum: 7.5,
            weight: "bold" as const,
          },
          {
            id: "giftMessage",
            text: giftMessage,
            preferred: 12,
            minimum: 9,
            spacing: 1.16,
          },
        ]
      : []),
  ];
  let content: TextElement[] | undefined;
  // Some already-purchased designs combine maximum-length display copy with
  // a personal message. Only after normal fitting is exhausted, reduce the
  // display copy further; body/personal-message readability floors stay fixed.
  for (let step = 0; step <= 60; step += 1) {
    const density = Math.min(1, step / 40);
    const compact = Math.max(0, (step - 40) / 20);
    let y = 100 - density * 20;
    const candidate: TextElement[] = [];
    for (const block of blocks) {
      const size =
        block.preferred -
        (block.preferred - block.minimum) * density -
        (block.minimum - (block.compactMinimum ?? block.minimum)) * compact;
      const item = makeText(
        block.id,
        block.text,
        { x: left, y, width: leftWidth, height: Number.MAX_SAFE_INTEGER },
        size,
        size,
        block.weight,
        block.color,
        block.spacing,
        true,
      );
      if (!item) continue;
      candidate.push(item);
      const gap = block.id === "giftMessageLabel" ? 5 : 14 - density * 10;
      y += item.box.height + gap;
    }
    const last = candidate.at(-1);
    if (last && last.box.y + last.box.height <= 292) {
      content = candidate;
      break;
    }
  }
  if (!content)
    return fail(
      "VOUCHER_DESIGN_TEXT_OVERFLOW",
      "The voucher copy is too long for this layout. Please shorten it or remove extra line breaks.",
    );
  elements.push(...content);

  elements.push({
    kind: "rect",
    color: design.colors.text,
    box: { x: left, y: 297, width: leftWidth, height: 0.65 },
  });
  addText(
    "codeLabel",
    meta.codeLabel,
    { x: left, y: 309, width: 232, height: 10 },
    8,
    8,
  );
  addText(
    "code",
    meta.code,
    { x: left, y: 324, width: 232, height: 25 },
    15,
    8,
    "bold",
    design.colors.text,
    1.08,
  );
  addText(
    "expiryLabel",
    meta.expiryLabel,
    { x: 286, y: 309, width: 102, height: 10 },
    8,
    8,
  );
  addText(
    "expiry",
    meta.expiry,
    { x: 286, y: 324, width: 102, height: 25 },
    12,
    9,
  );
  addText(
    "footer",
    design.content.footer,
    { x: left, y: 354, width: leftWidth, height: 34 },
    11,
    7.5,
    "bold",
    design.colors.text,
    1.12,
  );
  if (input.sample) {
    addText(
      "sample",
      meta.sampleLabel,
      { x: left, y: 389, width: leftWidth, height: 9 },
      7.5,
      7.5,
    );
  }
  return { context, layout: { ...VOUCHER_PAGE, elements } };
}

/** Exposed for deterministic layout checks; all units are PDF points measured from the top left. */
export async function buildVoucherLayout(
  input: VoucherRenderInput,
): Promise<VoucherLayout> {
  return (await prepare(input)).layout;
}

export async function renderVoucherPdf(
  input: VoucherRenderInput,
): Promise<Buffer> {
  const { context, layout } = await prepare(input);
  const { pdf } = context;
  const page = pdf.addPage([layout.width, layout.height]);
  pdf.setTitle(
    input.sample ? "Sample voucher - not redeemable" : "Gift voucher",
  );
  pdf.setProducer("shario.io voucher renderer v1");
  for (const item of layout.elements) {
    if (item.kind === "rect") {
      const [r, g, b] = hexRgb(item.color);
      page.drawRectangle({
        ...item.box,
        y: layout.height - item.box.y - item.box.height,
        color: rgb(r, g, b),
      });
    } else if (item.kind === "image") {
      const bounds = item.clipBox;
      page.pushOperators(
        pushGraphicsState(),
        rectangle(
          bounds.x,
          layout.height - bounds.y - bounds.height,
          bounds.width,
          bounds.height,
        ),
        clip(),
        endPath(),
      );
      page.drawImage(item.image, {
        ...item.box,
        y: layout.height - item.box.y - item.box.height,
      });
      page.pushOperators(popGraphicsState());
    } else {
      const [r, g, b] = hexRgb(item.color);
      for (const letter of item.glyphs) {
        if (letter.source.outlineOnly) {
          const path = letter.outline.path.toSVG();
          if (path) {
            // drawSvgPath flips SVG's Y axis; cancel it so font outlines retain
            // their native upward baseline, matching the preview exactly.
            const fontScale = letter.size / letter.source.face.unitsPerEm;
            page.pushOperators(
              pushGraphicsState(),
              translate(letter.x, layout.height - letter.baseline),
              scale(fontScale, -fontScale),
            );
            page.drawSvgPath(path, { color: rgb(r, g, b) });
            page.pushOperators(popGraphicsState());
          }
          continue;
        }
        if (!context.embedded.has(letter.source.id)) {
          context.embedded.set(
            letter.source.id,
            await pdf.embedFont(letter.source.bytes, { subset: false }),
          );
        }
        page.drawText(letter.character, {
          x: letter.x,
          y: layout.height - letter.baseline,
          size: letter.size,
          font: context.embedded.get(letter.source.id)!,
          color: rgb(r, g, b),
        });
      }
    }
  }
  return Buffer.from(await pdf.save());
}

const escapeXml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
const coordinate = (value: number) => Number(value.toFixed(5));

export async function renderVoucherSvg(
  input: VoucherRenderInput,
): Promise<string> {
  const { layout } = await prepare(input);
  const output = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${input.sample ? "Sample voucher - not redeemable" : "Gift voucher"}">`,
  ];
  for (let index = 0; index < layout.elements.length; index += 1) {
    const item = layout.elements[index];
    if (item.kind === "rect") {
      output.push(
        `<rect x="${item.box.x}" y="${item.box.y}" width="${item.box.width}" height="${item.box.height}" fill="${item.color}"/>`,
      );
    } else if (item.kind === "image") {
      const box = item.clipBox;
      output.push(
        `<defs><clipPath id="image-${index}"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"/></clipPath></defs>`,
      );
      output.push(
        `<image x="${coordinate(item.box.x)}" y="${coordinate(item.box.y)}" width="${coordinate(item.box.width)}" height="${coordinate(item.box.height)}" preserveAspectRatio="none" clip-path="url(#image-${index})" href="data:${item.mime};base64,${item.bytes.toString("base64")}"/>`,
      );
    } else {
      output.push(
        `<g aria-label="${escapeXml(item.text)}" fill="${item.color}"><title>${escapeXml(item.text)}</title>`,
      );
      for (const letter of item.glyphs) {
        const path = letter.outline.path.toSVG();
        if (!path) continue;
        const scale = letter.size / letter.source.face.unitsPerEm;
        output.push(
          `<path d="${path}" transform="translate(${coordinate(letter.x)} ${coordinate(letter.baseline)}) scale(${coordinate(scale)} ${coordinate(-scale)})"/>`,
        );
      }
      output.push("</g>");
    }
  }
  output.push("</svg>");
  return output.join("");
}
