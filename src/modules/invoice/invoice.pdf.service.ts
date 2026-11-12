import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";

import {
  getCurrencyExponent,
  normalizeStudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  resolveCommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

import { INVOICE_DOCUMENT_TYPE } from "./invoice.constants.js";
import { resolveInvoiceIssuanceSnapshot } from "./invoice-issuance-snapshot.js";

const require = createRequire(import.meta.url);
const regularFontPath = require.resolve(
  "@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff",
);
const boldFontPath = require.resolve(
  "@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff",
);

let fontBytesPromise: Promise<[Buffer, Buffer]> | null = null;

const loadFonts = (): Promise<[Buffer, Buffer]> => {
  fontBytesPromise ??= Promise.all([
    readFile(regularFontPath),
    readFile(boldFontPath),
  ]);
  return fontBytesPromise;
};

const text = (value: unknown): string =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const formatMoney = (amountMinor: number, currencyValue: unknown, locale: string) => {
  const currency = normalizeStudioCommerceCurrency(currencyValue);
  const exponent = getCurrencyExponent(currency);
  return new Intl.NumberFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(Number(amountMinor || 0) / 10 ** exponent);
};

const formatDate = (
  value: unknown,
  locale: string,
  timezone: string,
): string => {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
      timeZone: timezone || "UTC",
    }).format(new Date(value as string | Date));
  } catch {
    return new Intl.DateTimeFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
      timeZone: "UTC",
    }).format(new Date(value as string | Date));
  }
};

const partyName = (party: any): string =>
  party?.legalName ||
  party?.tradingName ||
  [party?.firstname, party?.lastname].filter(Boolean).join(" ") ||
  "-";

const addressLines = (party: any): string[] => {
  const address = party?.address ?? {};
  return [
    address.line1,
    address.line2,
    [address.postalCode, address.city].filter(Boolean).join(" "),
    address.country,
  ].filter(Boolean);
};

export const renderInvoicePdf = async (source: any): Promise<Buffer> => {
  const invoice = resolveInvoiceIssuanceSnapshot(source);
  const locale = resolveCommunicationContentLocale(
    invoice.locale,
    COMMUNICATION_CONTENT_LOCALE.CS,
  );
  const labels =
    locale === COMMUNICATION_CONTENT_LOCALE.CS
      ? {
          invoice: "Faktura",
          credit: "Opravný daňový doklad",
          seller: "Dodavatel",
          customer: "Odběratel",
          issueDate: "Datum vystavení",
          dueDate: "Datum splatnosti",
          taxableDate: "Datum zdanitelného plnění",
          item: "Položka",
          qty: "Počet",
          vat: "DPH",
          total: "Celkem",
          net: "Základ",
          tax: "Daň",
          original: "Původní doklad",
          reason: "Důvod opravy",
          paymentDetails: "Platební údaje",
          accountName: "Název účtu",
          accountNumber: "Číslo účtu",
        }
      : {
          invoice: "Invoice",
          credit: "Credit note",
          seller: "Seller",
          customer: "Customer",
          issueDate: "Issue date",
          dueDate: "Due date",
          taxableDate: "Taxable supply date",
          item: "Item",
          qty: "Qty",
          vat: "Tax",
          total: "Total",
          net: "Net",
          tax: "Tax",
          original: "Original invoice",
          reason: "Credit reason",
          paymentDetails: "Payment details",
          accountName: "Account name",
          accountNumber: "Account number",
        };

  const pdf = await PDFDocument.create();
  const issueDate = new Date(
    invoice.issueDate ?? 0,
  );
  const immutableMetadataDate = Number.isNaN(
    issueDate.getTime(),
  )
    ? new Date(0)
    : issueDate;

  /*
   * pdf-lib otherwise writes the render time into both fields. Invoice PDFs
   * are legal snapshots, so their bytes and metadata must derive only from
   * immutable issuance data.
   */
  pdf.setCreationDate(immutableMetadataDate);
  pdf.setModificationDate(
    immutableMetadataDate,
  );
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await loadFonts();
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  let page = pdf.addPage([595.28, 841.89]);
  const margin = 48;
  let y = 790;

  const draw = (
    value: unknown,
    x: number,
    options: { size?: number; isBold?: boolean; color?: ReturnType<typeof rgb> } = {},
  ) => {
    page.drawText(text(value), {
      x,
      y,
      size: options.size ?? 9,
      font: options.isBold ? bold : regular,
      color: options.color ?? rgb(0.12, 0.12, 0.12),
    });
  };

  const wrap = (
    value: unknown,
    maxWidth: number,
    size = 9,
    maxLines = 4,
  ): string[] => {
    const words = text(value).split(" ").filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (regular.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
    return lines.length ? lines : ["-"];
  };

  const title =
    invoice.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE
      ? labels.credit
      : labels.invoice;
  draw(title, margin, { size: 22, isBold: true });
  draw(invoice.number || "DRAFT", 400, { size: 12, isBold: true });
  y -= 40;

  if (invoice.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE) {
    draw(`${labels.original}: ${text(invoice.originalInvoiceNumber) || "-"}`, margin, {
      isBold: true,
    });
    y -= 16;
    const reasonLines = wrap(
      `${labels.reason}: ${text(invoice.creditReason) || "-"}`,
      499,
      9,
      3,
    );
    for (const line of reasonLines) {
      draw(line, margin);
      y -= 13;
    }
    y -= 11;
  }

  const seller: any = invoice.sellerSnapshot ?? {};
  const customer: any = invoice.customerSnapshot ?? {};
  draw(labels.seller, margin, { isBold: true });
  draw(labels.customer, 315, { isBold: true });
  y -= 16;
  const sellerLines = [
    partyName(seller),
    ...addressLines(seller),
    seller.registrationNumber ? `ID: ${seller.registrationNumber}` : "",
    seller.vatId ? `VAT: ${seller.vatId}` : "",
    seller.email,
    seller.phone,
  ].filter(Boolean);
  const customerLines = [
    partyName(customer),
    ...addressLines(customer),
    customer.registrationNumber ? `ID: ${customer.registrationNumber}` : "",
    customer.vatId ? `VAT: ${customer.vatId}` : "",
    customer.email,
  ].filter(Boolean);
  const partyRows = Math.max(sellerLines.length, customerLines.length);
  for (let index = 0; index < partyRows; index += 1) {
    if (sellerLines[index]) draw(sellerLines[index], margin);
    if (customerLines[index]) draw(customerLines[index], 315);
    y -= 14;
  }
  y -= 12;

  const timezone = text(invoice.timezone) || "UTC";
  draw(`${labels.issueDate}: ${formatDate(invoice.issueDate, locale, timezone)}`, margin);
  draw(`${labels.dueDate}: ${formatDate(invoice.dueDate, locale, timezone)}`, 230);
  draw(
    `${labels.taxableDate}: ${formatDate(invoice.taxableSupplyDate, locale, timezone)}`,
    395,
  );
  y -= 28;

  const drawTableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 4, width: 499, height: 20, color: rgb(0.94, 0.94, 0.94) });
    draw(labels.item, margin + 5, { isBold: true });
    draw(labels.qty, 350, { isBold: true });
    draw(labels.vat, 400, { isBold: true });
    draw(labels.total, 470, { isBold: true });
    y -= 24;
  };

  drawTableHeader();
  for (const line of invoice.lineItems ?? []) {
    if (y < 110) {
      page = pdf.addPage([595.28, 841.89]);
      y = 790;
      drawTableHeader();
    }
    const descriptions = wrap(line.description, 285, 9, 2);
    draw(descriptions[0], margin + 5);
    draw(line.quantity, 355);
    draw(`${Number(line.taxRateBps || 0) / 100}%`, 400);
    const amount = formatMoney(
      line.grossAmountMinor,
      invoice.currency,
      locale,
    );
    draw(amount, Math.max(455, 548 - regular.widthOfTextAtSize(amount, 9)));
    if (descriptions[1]) {
      y -= 13;
      draw(descriptions[1], margin + 5);
    }
    y -= 18;
  }

  y -= 12;
  const totals = [
    [labels.net, invoice.netAmountMinor],
    [labels.tax, invoice.taxAmountMinor],
    [labels.total, invoice.totalAmountMinor],
  ] as const;
  for (const [label, value] of totals) {
    const amount = formatMoney(value, invoice.currency, locale);
    draw(label, 390, { isBold: label === labels.total });
    draw(amount, Math.max(455, 548 - regular.widthOfTextAtSize(amount, 9)), {
      isBold: label === labels.total,
    });
    y -= 16;
  }

  const bank = seller.bank ?? {};
  const bankLines = [
    bank.accountName ? `${labels.accountName}: ${text(bank.accountName)}` : "",
    bank.accountNumber
      ? `${labels.accountNumber}: ${text(bank.accountNumber)}`
      : "",
    bank.iban ? `IBAN: ${text(bank.iban)}` : "",
    bank.bic ? `BIC/SWIFT: ${text(bank.bic)}` : "",
  ].filter(Boolean);
  if (bankLines.length) {
    if (y < 100) {
      page = pdf.addPage([595.28, 841.89]);
      y = 790;
    }
    y -= 10;
    draw(labels.paymentDetails, margin, { isBold: true });
    y -= 16;
    for (const line of bankLines) {
      for (const wrapped of wrap(line, 499, 9, 2)) {
        draw(wrapped, margin);
        y -= 14;
      }
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
};
