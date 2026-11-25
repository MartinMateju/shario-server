import type { PipelineStage } from "mongoose";
import { badRequest } from "@/shared/http/httpErrors.js";
import {
  getCurrencyExponent,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import type { DirectoryFilters } from "./user.directory-query.js";
import type { CustomerDirectoryMetrics } from "./services/user.directory-metrics.service.js";

export const hasSpendingBounds = (input: DirectoryFilters) =>
  input.spendMin !== undefined || input.spendMax !== undefined;
export const hasCreditBounds = (input: DirectoryFilters) =>
  input.creditMin !== undefined || input.creditMax !== undefined;
export const directorySpendingPeriod = (input: DirectoryFilters) =>
  input.spendFrom || input.spendTo
    ? {
        spendFrom: input.spendFrom,
        spendTo: input.spendTo,
        timeZone: input.timeZone,
      }
    : undefined;

export const directoryAmountBounds = (
  input: DirectoryFilters,
  currency: StudioCommerceCurrency | null,
) => {
  const result: Partial<
    Record<"spendMin" | "spendMax" | "creditMin" | "creditMax", number>
  > = {};
  for (const key of [
    "spendMin",
    "spendMax",
    "creditMin",
    "creditMax",
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!currency)
      badRequest(
        "A supported workspace currency is required for financial filters.",
      );
    try {
      result[key] =
        Math.sign(value) * toCurrencyMinorUnits(Math.abs(value), currency!);
    } catch {
      badRequest(
        "Financial filter amount has unsupported precision or exceeds the safe range.",
      );
    }
  }
  return result;
};

/** Canonical wallet snapshot, with the same valid-minor/legacy precedence as
 * resolveCreditBalanceMinor. Unlike mutation defaults, absent or malformed
 * evidence stays null here so a zero-balance filter cannot disclose a guess. */
export const directoryCreditStages = (
  currency: StudioCommerceCurrency | null,
): PipelineStage[] => {
  if (!currency)
    return [{ $set: { _directoryCreditMinor: null, _directoryCredits: null } }];
  const factor = 10 ** getCurrencyExponent(currency);
  const rawLegacy = {
    $ifNull: [
      "$moneyCredits",
      "$creditBalance",
      "$creditsBalance",
      "$credits.balance",
      "$credits",
      "$balance",
      null,
    ],
  };
  const numeric = (value: any) => ({
    $cond: [
      {
        $in: [{ $type: value }, ["int", "long", "double", "decimal", "string"]],
      },
      { $convert: { input: value, to: "double", onNull: null, onError: null } },
      null,
    ],
  });
  const safe = (value: any) => ({
    $and: [
      { $ne: [value, null] },
      { $gte: [value, 0] },
      { $lte: [value, Number.MAX_SAFE_INTEGER] },
    ],
  });
  return [
    {
      $set: {
        _directoryMinorSnapshot: numeric("$moneyCreditsMinor"),
        _directoryLegacyCredit: numeric(rawLegacy),
      },
    },
    {
      $set: {
        _directoryLegacyMinor: {
          $multiply: ["$_directoryLegacyCredit", factor],
        },
      },
    },
    {
      $set: {
        _directoryCreditMinor: {
          $cond: [
            {
              $and: [
                safe("$_directoryMinorSnapshot"),
                {
                  $eq: [
                    "$_directoryMinorSnapshot",
                    { $trunc: "$_directoryMinorSnapshot" },
                  ],
                },
              ],
            },
            "$_directoryMinorSnapshot",
            {
              $cond: [
                {
                  $and: [
                    safe("$_directoryLegacyMinor"),
                    {
                      $lte: [
                        {
                          $abs: {
                            $subtract: [
                              "$_directoryLegacyMinor",
                              { $round: ["$_directoryLegacyMinor", 0] },
                            ],
                          },
                        },
                        0.000001,
                      ],
                    },
                  ],
                },
                { $round: ["$_directoryLegacyMinor", 0] },
                null,
              ],
            },
          ],
        },
      },
    },
    {
      $set: {
        _directoryCredits: {
          $cond: [
            { $ne: ["$_directoryCreditMinor", null] },
            { $divide: ["$_directoryCreditMinor", factor] },
            null,
          ],
        },
      },
    },
  ];
};

export const directoryCreditFilter = (
  bounds: ReturnType<typeof directoryAmountBounds>,
): PipelineStage[] => {
  if (bounds.creditMin === undefined && bounds.creditMax === undefined)
    return [];
  return [
    {
      $match: {
        _directoryCreditMinor: {
          $ne: null,
          ...(bounds.creditMin === undefined ? {} : { $gte: bounds.creditMin }),
          ...(bounds.creditMax === undefined ? {} : { $lte: bounds.creditMax }),
        },
      },
    },
  ];
};

export const matchesDirectorySpending = (
  row: CustomerDirectoryMetrics,
  input: DirectoryFilters,
  bounds: ReturnType<typeof directoryAmountBounds>,
  currency: StudioCommerceCurrency | null,
) => {
  if (!hasSpendingBounds(input)) return true;
  const amounts = directorySpendingPeriod(input)
    ? row.periodSpentByCurrency
    : row.totalSpentByCurrency;
  if (
    !currency ||
    !amounts ||
    amounts.length > 1 ||
    (amounts.length === 1 && amounts[0].currency !== currency)
  )
    return false;
  const minor = amounts[0]?.amountMinor ?? 0;
  return (
    (bounds.spendMin === undefined || minor >= bounds.spendMin) &&
    (bounds.spendMax === undefined || minor <= bounds.spendMax)
  );
};
