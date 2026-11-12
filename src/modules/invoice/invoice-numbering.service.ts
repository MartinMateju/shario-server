import type mongoose from "mongoose";

import { conflict } from "@/shared/http/httpErrors.js";

import InvoiceCounterModel from "./invoice-counter.schema.js";
import {
  INVOICE_DOCUMENT_TYPE,
  type InvoiceDocumentType,
} from "./invoice.constants.js";
import InvoiceModel from "./invoice.schema.js";

const NUMBERED_TRANSACTION_MAX_ATTEMPTS = 3;

export class InvoiceCounterUpsertRaceError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Concurrent invoice counter creation detected.");
    this.name = "InvoiceCounterUpsertRaceError";
    this.cause = cause;
  }
}

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 11000,
  );

export const runNumberedInvoiceTransaction = async <T>(
  session: mongoose.ClientSession,
  work: () => Promise<T>,
): Promise<T | null> => {
  for (let attempt = 1; attempt <= NUMBERED_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await session.withTransaction(work);
    } catch (error) {
      // Only the explicitly wrapped canonical-counter upsert race is retried.
      // A duplicate invoice number, source key, or any other E11000 must surface
      // unchanged instead of accidentally replaying unrelated application work.
      if (!(error instanceof InvoiceCounterUpsertRaceError)) throw error;
      if (attempt === NUMBERED_TRANSACTION_MAX_ATTEMPTS) {
        conflict({
          message: "Invoice numbering is busy. Please retry the operation.",
          code: "INVOICE_NUMBER_ALLOCATION_CONFLICT",
        });
      }
    }
  }

  return null;
};

const resolveFiscalYear = (value: Date, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
    }).format(value);
  } catch {
    return String(value.getUTCFullYear());
  }
};

export const buildInvoiceSeries = ({
  prefix,
  issueDate,
  timezone,
}: {
  prefix: string;
  issueDate: Date;
  timezone: string;
}): string =>
  `${prefix}-${resolveFiscalYear(issueDate, timezone)}`.toUpperCase();

export const parseInvoiceSequenceFromNumber = ({
  number,
  series,
}: {
  number: unknown;
  series: string;
}): number | null => {
  const value = String(number ?? "").trim().toUpperCase();
  const prefix = `${series.toUpperCase()}-`;
  if (!value.startsWith(prefix)) return null;

  const suffix = value.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;

  const sequence = Number(suffix);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
};

export const getInvoiceNumberingHighWaterMark = ({
  series,
  documentSequence,
  counterSequences,
  historicalNumbers = [],
}: {
  series?: string;
  documentSequence?: number | null;
  counterSequences: Array<number | null | undefined>;
  historicalNumbers?: unknown[];
}): number => {
  const parsedHistoricalSequences = series
    ? historicalNumbers.map((number) =>
        parseInvoiceSequenceFromNumber({ number, series }),
      )
    : [];
  const candidates = [
    documentSequence,
    ...counterSequences,
    ...parsedHistoricalSequences,
  ]
    .map((value) => Number(value ?? 0))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);

  return Math.max(0, ...candidates);
};

/**
 * Allocates a tenant-global number within a prefix/year series.
 *
 * Older releases kept one counter per document type. That allowed an invoice
 * and a credit note to independently allocate the same visible number, and a
 * prefix changed to another document type's historical prefix could repeatedly
 * hit the unique number index. New allocations deliberately use the invoice
 * counter record as the canonical counter for *both* document types. Keeping
 * the existing discriminator avoids a destructive counter migration, while
 * the high-water repair absorbs every legacy counter and issued document in
 * the series before the atomic increment.
 *
 * This function must be called inside the same MongoDB transaction that saves
 * the issued document. Concurrent transactions serialize on the canonical
 * counter document; MongoDB retries transient write conflicts at the caller's
 * `withTransaction` boundary.
 */
export const allocateInvoiceNumber = async ({
  tenantId,
  documentType: _documentType,
  prefix,
  issueDate,
  timezone,
  session,
}: {
  tenantId: string;
  documentType: InvoiceDocumentType;
  prefix: string;
  issueDate: Date;
  timezone: string;
  session: mongoose.ClientSession;
}) => {
  const series = buildInvoiceSeries({ prefix, issueDate, timezone });

  const latestDocument = await InvoiceModel.findOne({
    tenant: tenantId,
    series,
    sequence: { $gte: 1 },
  })
    .sort({ sequence: -1 })
    .select("sequence")
    .session(session)
    .lean()
    .exec();

  const escapedSeries = series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sequenceLessDocuments = await InvoiceModel.find({
    tenant: tenantId,
    sequence: null,
    number: { $regex: new RegExp(`^${escapedSeries}-\\d+$`, "i") },
  })
    .select("number")
    .session(session)
    .lean()
    .exec();

  // Read all legacy type-specific counters. This is also what makes a prefix
  // change safe when its series was previously used by the other type.
  const legacyCounters = await InvoiceCounterModel.find({
    tenant: tenantId,
    series,
  })
    .select("sequence")
    .session(session)
    .lean()
    .exec();

  const highWaterMark = getInvoiceNumberingHighWaterMark({
    series,
    documentSequence: latestDocument?.sequence,
    counterSequences: legacyCounters.map((counter) => counter.sequence),
    historicalNumbers: sequenceLessDocuments.map((document) => document.number),
  });

  const canonicalFilter = {
    tenant: tenantId,
    documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
    series,
  };

  // Repair the canonical counter first, then increment it. Both writes are in
  // the caller's transaction, so the allocated sequence rolls back if issuing
  // the document fails.
  try {
    await InvoiceCounterModel.updateOne(
      canonicalFilter,
      {
        $setOnInsert: canonicalFilter,
        $max: { sequence: highWaterMark },
      },
      {
        upsert: true,
        session,
        runValidators: true,
        setDefaultsOnInsert: false,
      },
    ).exec();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new InvoiceCounterUpsertRaceError(error);
    }
    throw error;
  }

  let counter = await InvoiceCounterModel.findOneAndUpdate(
    canonicalFilter,
    { $inc: { sequence: 1 } },
    {
      returnDocument: "after",
      includeResultMetadata: false,
      session,
      runValidators: true,
    },
  ).exec();

  if (!counter) {
    conflict({
      message: "Invoice number allocation failed.",
      code: "INVOICE_NUMBER_ALLOCATION_FAILED",
    });
  }

  let sequence = Number(counter.sequence);
  let number = `${series}-${String(sequence).padStart(6, "0")}`;

  // The high-water queries cover normal and migrated data. This final check
  // also heals an unusual legacy document that has a number but no sequence.
  while (
    await InvoiceModel.exists({ tenant: tenantId, number }).session(session)
  ) {
    counter = await InvoiceCounterModel.findOneAndUpdate(
      canonicalFilter,
      { $inc: { sequence: 1 } },
      {
        returnDocument: "after",
        includeResultMetadata: false,
        session,
        runValidators: true,
      },
    ).exec();

    if (!counter) {
      conflict({
        message: "Invoice number allocation failed.",
        code: "INVOICE_NUMBER_ALLOCATION_FAILED",
      });
    }

    sequence = Number(counter.sequence);
    number = `${series}-${String(sequence).padStart(6, "0")}`;
  }

  return { series, sequence, number };
};
