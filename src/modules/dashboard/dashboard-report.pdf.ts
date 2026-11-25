import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { DashboardReport, DashboardReportSection } from "./dashboard-report.types.js";

const require = createRequire(import.meta.url);
let fontBytes: Promise<[Buffer, Buffer, Buffer, Buffer]> | undefined;
const loadFonts = () => fontBytes ??= Promise.all([
  readFile(require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff")),
  readFile(require.resolve("@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff")),
  readFile(require.resolve("@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff")),
  readFile(require.resolve("@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff")),
]);

const INK = rgb(0.16, 0.20, 0.17);
const MUTED = rgb(0.39, 0.43, 0.39);
const RULE = rgb(0.86, 0.86, 0.81);
const ACCENT = rgb(0.71, 0.32, 0.21);
const PAPER = rgb(0.97, 0.96, 0.93);
const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 46;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;
const BOTTOM = 66;

export const dashboardReportGeneratedLabel = (generatedAt: string, locale: "cs" | "en", timezone: string): string =>
  `${new Intl.DateTimeFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
    timeZone: timezone, dateStyle: "medium", timeStyle: "short",
  }).format(new Date(generatedAt))} | ${timezone}`;

const cleanText = (value: unknown) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
  .replace(/[\u2010-\u2015\u2212]/g, "-")
  .replace(/\s+/g, " ")
  .trim();

/** Split even an unbroken identifier; never truncate data or let it escape a cell. */
export const wrapDashboardReportText = (
  value: unknown, width: number, font: Pick<PDFFont, "widthOfTextAtSize">, size: number,
): string[] => {
  const words = cleanText(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const character of word) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["-"];
};

/** The PDF is derived exclusively from the stored snapshot, never current database reads. */
export const renderDashboardReportPdf = async (report: DashboardReport): Promise<Buffer> => {
  const cs = report.sourceLocale === "cs";
  const copy = (czech: string, english: string) => cs ? czech : english;
  const pdf = await PDFDocument.create();
  const generated = new Date(report.generatedAt);
  const metadataDate = Number.isFinite(generated.valueOf()) ? generated : new Date(0);
  pdf.setCreationDate(metadataDate);
  pdf.setModificationDate(metadataDate);
  pdf.setTitle(copy("Report studia", "Studio report"));
  pdf.setAuthor("shario.io");
  pdf.setCreator("shario.io studio reporting");
  pdf.setProducer("shario.io studio reporting");
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes, extendedBytes, extendedBoldBytes] = await loadFonts();
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const extended = await pdf.embedFont(extendedBytes, { subset: true });
  const extendedBold = await pdf.embedFont(extendedBoldBytes, { subset: true });
  let page: PDFPage;
  let y = 0;

  // Fontsource separates Latin and Latin Extended into disjoint subsets. Embed
  // both and measure/draw identical font runs so ASCII and Czech render together.
  // Customer-supplied glyphs outside that font are replaced explicitly, avoiding
  // broken PDF encodings. Full original strings remain in the saved JSON report.
  const latin = new Set(regular.getCharacterSet());
  const supported = new Set([...latin, ...extended.getCharacterSet()]);
  const printable = (value: unknown) => [...cleanText(value)]
    .map(character => supported.has(character.codePointAt(0)!) ? character : "?").join("");
  const runs = (value: unknown, strong = false) => {
    const result: Array<{ font: PDFFont; text: string }> = [];
    for (const character of printable(value)) {
      const font = latin.has(character.codePointAt(0)!) ? (strong ? bold : regular) : (strong ? extendedBold : extended);
      const last = result.at(-1);
      if (last?.font === font) last.text += character;
      else result.push({ font, text: character });
    }
    return result;
  };
  const textWidth = (value: unknown, size: number, strong = false) => runs(value, strong)
    .reduce((total, run) => total + run.font.widthOfTextAtSize(run.text, size), 0);
  const wrap = (value: unknown, width: number, size = 9, strong = false) =>
    wrapDashboardReportText(printable(value), width, { widthOfTextAtSize: (text, fontSize) => textWidth(text, fontSize, strong) }, size);
  const drawOn = (target: PDFPage, value: string, x: number, baseline: number, options: { size?: number; strong?: boolean; muted?: boolean } = {}) => {
    const size = options.size ?? 9;
    for (const run of runs(value, options.strong)) {
      target.drawText(run.text, { x, y: baseline, size, font: run.font, color: options.muted ? MUTED : INK });
      x += run.font.widthOfTextAtSize(run.text, size);
    }
  };
  const draw = (value: string, x: number, baseline: number, options: { size?: number; strong?: boolean; muted?: boolean } = {}) => drawOn(page, value, x, baseline, options);
  const newPage = () => {
    page = pdf.addPage([WIDTH, HEIGHT]);
    page.drawText("shario.io", { x: MARGIN, y: HEIGHT - 39, font: bold, size: 14, color: INK });
    const label = wrap(report.locationLabel, CONTENT_WIDTH - 100, 8)[0];
    draw(label, WIDTH - MARGIN - textWidth(label, 8), HEIGHT - 36, { size: 8, muted: true });
    page.drawLine({ start: { x: MARGIN, y: HEIGHT - 51 }, end: { x: WIDTH - MARGIN, y: HEIGHT - 51 }, thickness: 0.6, color: RULE });
    y = HEIGHT - 77;
  };
  const ensure = (height: number) => { if (y - height < BOTTOM) newPage(); };
  const paragraph = (value: unknown, options: { size?: number; strong?: boolean; muted?: boolean; indent?: number } = {}) => {
    const size = options.size ?? 9;
    const indent = options.indent ?? 0;
    for (const line of wrap(value, CONTENT_WIDTH - indent, size, options.strong)) {
      ensure(size * 1.55);
      draw(line, MARGIN + indent, y, options);
      y -= size * 1.55;
    }
  };
  const heading = (value: string, size = 13) => {
    const lines = wrap(value, CONTENT_WIDTH, size, true);
    ensure(lines.length * (size + 4) + 37);
    y -= 7;
    for (const line of lines) {
      draw(line, MARGIN, y, { size, strong: true });
      y -= size + 4;
    }
    y -= 6;
  };
  const bullets = (title: string, values: string[]) => {
    if (!values.length) return;
    heading(title, 11);
    for (const value of values) {
      const lines = wrap(value, CONTENT_WIDTH - 12, 9);
      ensure(Math.min(lines.length, 3) * 14 + 5);
      draw("-", MARGIN, y);
      paragraph(value, { indent: 12 });
      y -= 5;
    }
  };

  newPage();
  page.drawText(copy("REPORT STUDIA", "STUDIO REPORT"), { x: MARGIN, y, font: bold, size: 9, color: ACCENT });
  y -= 26;
  paragraph(report.narrative.headline, { size: 22, strong: true });
  y -= 9;
  paragraph(report.locationLabel, { size: 10, strong: true });
  const { period, comparisonPeriod } = report.snapshot.metadata;
  paragraph(`${period.from} - ${period.to}  |  ${copy("Srovnání", "Comparison")}: ${comparisonPeriod.from} - ${comparisonPeriod.to}`, { size: 8.5, muted: true });
  paragraph(`${copy("Vygenerováno", "Generated")}: ${dashboardReportGeneratedLabel(report.generatedAt, report.sourceLocale, report.snapshot.metadata.timezone)}`, { size: 8, muted: true });
  paragraph(report.narrative.mode === "ai"
    ? copy("AI shrnutí ověřených záznamů", "AI summary of verified records")
    : copy("Automatické shrnutí bez AI", "Automatic summary without AI"), { size: 8, muted: true });
  y -= 16;
  paragraph(report.narrative.summary, { size: 10 });
  bullets(copy("Hlavní zjištění", "Highlights"), report.narrative.highlights);
  bullets(copy("Vyžaduje pozornost", "Needs attention"), report.narrative.attention);
  bullets(copy("Doporučené další kroky", "Suggested next steps"), report.narrative.recommendations);
  y -= 6;

  const table = (section: DashboardReportSection) => {
    const positions = [MARGIN, MARGIN + 258, MARGIN + 380];
    const widths = [244, 108, CONTENT_WIDTH - 380 - 4];
    const lineHeight = 12.5;
    const headerLines = section.columns.map((column, index) => wrap(column, widths[index], 8, true));
    const headerHeight = Math.max(...headerLines.map(lines => lines.length)) * 11 + 13;
    const tableHeader = () => {
      ensure(headerHeight + 20);
      page.drawRectangle({ x: MARGIN - 5, y: y - headerHeight + 9, width: CONTENT_WIDTH + 10, height: headerHeight, color: PAPER });
      headerLines.forEach((lines, index) => lines.forEach((line, row) => draw(line, positions[index], y - row * 11, { size: 8, strong: true })));
      y -= headerHeight + 3;
    };
    heading(section.title);
    tableHeader();
    for (const row of section.rows) {
      const values = [row.label, row.value, row.previous ?? "-"];
      const lines = values.map((value, index) => wrap(value, widths[index], 8.5));
      const count = Math.max(...lines.map(cell => cell.length));
      // Ordinary rows stay together. An exceptionally long title can span pages
      // with repeated column headings, preserving every line of the record.
      if (count * lineHeight + 10 < HEIGHT - 170 && y - count * lineHeight - 10 < BOTTOM) {
        newPage();
        tableHeader();
      }
      for (let line = 0; line < count; line += 1) {
        if (y - lineHeight < BOTTOM) {
          newPage();
          tableHeader();
        }
        lines.forEach((cell, index) => {
          if (cell[line]) draw(cell[line], positions[index], y, { size: 8.5 });
        });
        y -= lineHeight;
      }
      y -= 5;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: WIDTH - MARGIN, y }, thickness: 0.4, color: RULE });
      y -= 10;
    }
    for (const note of section.notes) {
      y -= 3;
      paragraph(note, { size: 8, muted: true });
    }
    y -= 10;
  };
  report.sections.forEach(table);
  bullets(copy("Dostupnost a omezení dat", "Data coverage and limitations"), report.narrative.dataLimitations);

  const pages = pdf.getPages();
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: MARGIN, y: 48 }, end: { x: WIDTH - MARGIN, y: 48 }, thickness: 0.6, color: RULE });
    drawOn(item, `shario.io  |  ${copy("Uložený report", "Saved report")}: ${report.id}`, MARGIN, 33, { size: 7, muted: true });
    const count = `${index + 1} / ${pages.length}`;
    item.drawText(count, { x: WIDTH - MARGIN - regular.widthOfTextAtSize(count, 8), y: 33, size: 8, font: regular, color: MUTED });
  });
  return Buffer.from(await pdf.save());
};
