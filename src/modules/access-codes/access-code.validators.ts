import mongoose from "mongoose";
import { z } from "zod";

import {
  ACCESS_CODE_AUDIT_ACTION,
  ACCESS_CODE_BULK_LIMIT,
  ACCESS_CODE_SOURCE,
  ACCESS_CODE_STATUS,
  ACCESS_CODE_TYPE,
  DEFAULT_ACCESS_CODE_LIMIT,
  DEFAULT_ACCESS_CODE_PAGE,
  DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD,
  MAX_ACCESS_CODE_LIMIT,
} from "./access-code.constants.js";

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

const optionalBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean().optional());

const nullableDate = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.coerce.date().nullable(),
);

const accessCodeValueSchema = z
  .string()
  .trim()
  .min(1, "Access code is required.")
  .max(80);

const codeValidityShape = {
  validFrom: nullableDate.default(null),
  validUntil: nullableDate.default(null),
};

const validateDateRange = (
  value: { validFrom?: Date | null; validUntil?: Date | null },
  context: z.RefinementCtx,
) => {
  if (
    value.validFrom &&
    value.validUntil &&
    value.validUntil.getTime() <= value.validFrom.getTime()
  ) {
    context.addIssue({
      code: "custom",
      path: ["validUntil"],
      message: "Valid until must be later than valid from.",
    });
  }
};

export const createAccessCodePoolSchema = z
  .object({
    locationId: objectIdSchema("location id"),
    name: z.string().trim().min(1).max(120),
    lowStockThreshold: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD),
  })
  .strict();

export const updateAccessCodePoolSchema = z
  .object({
    id: objectIdSchema("pool id"),
    name: z.string().trim().min(1).max(120).optional(),
    lowStockThreshold: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.lowStockThreshold !== undefined,
    { message: "At least one pool field is required." },
  );

export const listAccessCodePoolsSchema = z
  .object({
    locationId: objectIdSchema("location id").optional(),
    includeArchived: optionalBoolean.default(false),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict();

export const accessCodePoolIdParamsSchema = z.object({
  poolId: objectIdSchema("pool id"),
});

const accessCodeCreateShape = {
  code: accessCodeValueSchema.optional(),
  entryCode: accessCodeValueSchema.optional(),
  label: z.string().trim().max(120).default(""),
  notes: z.string().trim().max(500).default(""),
  type: z
    .enum(Object.values(ACCESS_CODE_TYPE))
    .default(ACCESS_CODE_TYPE.SINGLE_BOOKING),
  status: z
    .enum(Object.values(ACCESS_CODE_STATUS))
    .default(ACCESS_CODE_STATUS.DRAFT),
  ...codeValidityShape,
  programmedAndTested: z.boolean().optional(),
  verified: z.boolean().optional(),
};

const validateCodeInput = (
  value: {
    code?: string;
    entryCode?: string;
    validFrom?: Date | null;
    validUntil?: Date | null;
  },
  context: z.RefinementCtx,
) => {
  validateDateRange(value, context);
  if (!value.code && !value.entryCode) {
    context.addIssue({
      code: "custom",
      path: ["code"],
      message: "Access code is required.",
    });
  }
};

const normalizeCodeInput = <T extends Record<string, any>>(value: T) => {
  const { entryCode, verified, ...rest } = value;
  return {
    ...rest,
    code: value.code || entryCode,
    programmedAndTested:
      value.programmedAndTested ?? verified ?? false,
  };
};

export const createAccessCodeSchema = z
  .object({
    poolId: objectIdSchema("pool id"),
    ...accessCodeCreateShape,
  })
  .strict()
  .superRefine(validateCodeInput)
  .transform(normalizeCodeInput);

export const updateAccessCodeSchema = z
  .object({
    id: objectIdSchema("access code id"),
    poolId: objectIdSchema("pool id").optional(),
    label: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(500).optional(),
    type: z.enum(Object.values(ACCESS_CODE_TYPE)).optional(),
    status: z
      .enum([
        ACCESS_CODE_STATUS.DRAFT,
        ACCESS_CODE_STATUS.AVAILABLE,
        ACCESS_CODE_STATUS.DISABLED,
      ])
      .optional(),
    validFrom: nullableDate.optional(),
    validUntil: nullableDate.optional(),
    programmedAndTested: z.boolean().optional(),
    verified: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "id"),
    { message: "At least one access-code field is required." },
  )
  .superRefine(validateDateRange)
  .transform((value) => {
    const { verified, ...rest } = value;
    return {
      ...rest,
      ...(value.programmedAndTested !== undefined || verified !== undefined
        ? {
            programmedAndTested:
              value.programmedAndTested ?? verified,
          }
        : {}),
    };
  });

export const bulkCreateAccessCodesSchema = z
  .object({
    poolId: objectIdSchema("pool id"),
    codes: z.array(z.unknown()).min(1).max(ACCESS_CODE_BULK_LIMIT),
  })
  .strict();

export const bulkAccessCodeRowSchema = z
  .object(accessCodeCreateShape)
  .strict()
  .superRefine(validateCodeInput)
  .transform(normalizeCodeInput);

export const accessCodeIdParamsSchema = z.object({
  id: objectIdSchema("access code id"),
});

export const listAccessCodesSchema = z
  .object({
    poolId: objectIdSchema("pool id").optional(),
    locationId: objectIdSchema("location id").optional(),
    type: z.enum(Object.values(ACCESS_CODE_TYPE)).optional(),
    status: z
      .enum([...Object.values(ACCESS_CODE_STATUS), "expired"])
      .optional(),
    source: z.enum(Object.values(ACCESS_CODE_SOURCE)).optional(),
    search: z.string().trim().max(120).default(""),
    // Legacy filters remain accepted until every deployment has run the
    // inventory migration and the compatibility repository can be removed.
    isUsed: optionalBoolean,
    canBeRepeated: optionalBoolean,
    page: z.coerce.number().int().positive().default(DEFAULT_ACCESS_CODE_PAGE),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_ACCESS_CODE_LIMIT)
      .default(DEFAULT_ACCESS_CODE_LIMIT),
  })
  .strict();

export const listAccessCodeAlertsSchema = z
  .object({ locationId: objectIdSchema("location id").optional() })
  .strict();

export const listAccessCodeAuditSchema = z
  .object({
    poolId: objectIdSchema("pool id").optional(),
    accessCodeId: objectIdSchema("access code id").optional(),
    locationId: objectIdSchema("location id").optional(),
    action: z.enum(Object.values(ACCESS_CODE_AUDIT_ACTION)).optional(),
    page: z.coerce.number().int().positive().default(DEFAULT_ACCESS_CODE_PAGE),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_ACCESS_CODE_LIMIT)
      .default(DEFAULT_ACCESS_CODE_LIMIT),
  })
  .strict();

export type CreateAccessCodePoolDto = z.infer<
  typeof createAccessCodePoolSchema
>;
export type UpdateAccessCodePoolDto = z.infer<
  typeof updateAccessCodePoolSchema
>;
export type ListAccessCodePoolsDto = z.infer<
  typeof listAccessCodePoolsSchema
>;
export type CreateAccessCodeDto = z.infer<typeof createAccessCodeSchema>;
export type UpdateAccessCodeDto = z.infer<typeof updateAccessCodeSchema>;
export type ListAccessCodesDto = z.infer<typeof listAccessCodesSchema>;
export type BulkAccessCodeRowDto = z.infer<typeof bulkAccessCodeRowSchema>;
export type ListAccessCodeAuditDto = z.infer<
  typeof listAccessCodeAuditSchema
>;
