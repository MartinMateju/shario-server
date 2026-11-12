import type {
  ImportIssue,
  MembershipPlanImportColumnMapping,
  NormalizedMembershipPlanImportRow,
} from "../data-import.types.js";
import {
  importToken,
  importValueAt,
  parseImportAmount,
  parseImportInteger,
  parseJsonArray,
} from "./import-adapter.utils.js";

const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });

export const normalizeMembershipPlanImportRow = (
  raw: Record<string, string>,
  mapping: MembershipPlanImportColumnMapping,
): NormalizedMembershipPlanImportRow => {
  const value = (field: keyof MembershipPlanImportColumnMapping) =>
    importValueAt(raw, mapping, field);
  const providedFields = (
    Object.keys(mapping) as Array<keyof MembershipPlanImportColumnMapping>
  ).filter((field) => Boolean(mapping[field] && value(field)));
  const priceRaw = value("price");
  const intervalRaw = value("intervalCount");
  const durationRaw = value("durationDays");
  const creditsRaw = value("creditAllowance");
  const discountRaw = value("discountPercent");
  const benefitsRaw = value("benefits");
  const sortRaw = value("sortOrder");
  const billingToken = importToken(value("billingType"));
  const billingType = ["fixed", "jednorazove", "one-time"].includes(
    billingToken,
  )
    ? "fixed"
    : ["recurring", "subscription", "opakujici"].includes(billingToken)
      ? "recurring"
      : "";
  const intervalToken = importToken(value("billingInterval"));
  const billingInterval = ["month", "monthly", "mesic"].includes(intervalToken)
    ? "month"
    : ["year", "yearly", "rok"].includes(intervalToken)
      ? "year"
      : "";
  const scopeToken = importToken(value("locationScope"));
  const locationScope =
    !scopeToken || ["all", "all-locations", "vsechny"].includes(scopeToken)
      ? "all"
      : ["selected", "specific", "vybrane"].includes(scopeToken)
        ? "selected"
        : "";
  const statusToken = importToken(value("status"));
  const status =
    !statusToken || ["published", "active", "publikovano"].includes(statusToken)
      ? "published"
      : ["archived", "inactive", "archivovano"].includes(statusToken)
        ? "archived"
        : "";
  const rawBenefits = benefitsRaw ? parseJsonArray(benefitsRaw) : null;
  const creditAllowance = creditsRaw ? parseImportInteger(creditsRaw) : null;
  const discountPercent = discountRaw ? parseImportAmount(discountRaw) : null;
  const commonBenefits = [
    ...(creditAllowance !== null
      ? [
          {
            key: "credits",
            label: "Credits",
            type: "allowance",
            unit: "credit",
            quantity: creditAllowance,
            adjustable: true,
          },
        ]
      : []),
    ...(discountPercent !== null
      ? [
          {
            key: "product_discount",
            label: "Product discount",
            type: "percentage",
            percentageBps: Math.round(discountPercent * 100),
            appliesTo: "products",
          },
        ]
      : []),
    ...(value("customPerk")
      ? [
          {
            key: "custom_perk",
            label: value("customPerk"),
            type: "boolean",
            enabled: true,
          },
        ]
      : []),
  ];
  const parseErrors: NormalizedMembershipPlanImportRow["parseErrors"] = [];
  const parsedPairs: Array<
    [keyof MembershipPlanImportColumnMapping, string, unknown]
  > = [
    ["price", priceRaw, priceRaw ? parseImportAmount(priceRaw) : null],
    [
      "intervalCount",
      intervalRaw,
      intervalRaw ? parseImportInteger(intervalRaw) : null,
    ],
    [
      "durationDays",
      durationRaw,
      durationRaw ? parseImportInteger(durationRaw) : null,
    ],
    ["creditAllowance", creditsRaw, creditAllowance],
    ["discountPercent", discountRaw, discountPercent],
    ["benefits", benefitsRaw, rawBenefits],
    ["sortOrder", sortRaw, sortRaw ? parseImportInteger(sortRaw) : null],
  ];
  for (const [field, source, parsed] of parsedPairs)
    if (source && parsed === null) parseErrors.push(field);
  return {
    ...(value("externalId") ? { externalId: value("externalId") } : {}),
    name: value("name"),
    description: value("description"),
    terms: value("terms"),
    price: priceRaw ? parseImportAmount(priceRaw) : null,
    currency: value("currency").toUpperCase(),
    billingType,
    billingInterval,
    intervalCount: intervalRaw
      ? parseImportInteger(intervalRaw)
      : billingType === "recurring"
        ? 1
        : null,
    durationDays: durationRaw ? parseImportInteger(durationRaw) : null,
    locationScope,
    locationCodes: value("locationCodes")
      .split(/[;,|]/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
    creditAllowance,
    discountPercent,
    customPerk: value("customPerk"),
    benefits: rawBenefits || commonBenefits,
    sortOrder: sortRaw ? parseImportInteger(sortRaw) : 0,
    status,
    providedFields,
    parseErrors,
  };
};

export const validateMembershipPlanImportRow = (
  value: NormalizedMembershipPlanImportRow,
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!value.name)
    issues.push(
      error("MEMBERSHIP_PLAN_NAME_REQUIRED", "Plan name is required.", "name"),
    );
  if (value.name.length > 160)
    issues.push(
      error("MEMBERSHIP_PLAN_NAME_TOO_LONG", "Plan name is too long.", "name"),
    );
  if ((value.externalId?.length || 0) > 120)
    issues.push(
      error(
        "MEMBERSHIP_PLAN_EXTERNAL_ID_TOO_LONG",
        "External ID is too long.",
        "externalId",
      ),
    );
  if (value.description.length > 2_000)
    issues.push(
      error(
        "MEMBERSHIP_PLAN_DESCRIPTION_TOO_LONG",
        "Description is too long.",
        "description",
      ),
    );
  if (value.terms.length > 10_000)
    issues.push(
      error("MEMBERSHIP_PLAN_TERMS_TOO_LONG", "Terms are too long.", "terms"),
    );
  if (value.price === null || value.price <= 0)
    issues.push(
      error(
        "MEMBERSHIP_PLAN_PRICE_INVALID",
        "Price must be greater than zero.",
        "price",
      ),
    );
  if (
    !value.billingType ||
    (value.billingType === "recurring" && !value.billingInterval) ||
    (value.billingType === "fixed" && !value.durationDays)
  )
    issues.push(
      error(
        "MEMBERSHIP_PLAN_BILLING_INVALID",
        "Recurring plans need an interval; fixed plans need duration days.",
      ),
    );
  if (
    value.locationScope === "selected" &&
    !value.locationCodes.length &&
    !value.locationIds?.length
  )
    issues.push(
      error(
        "MEMBERSHIP_PLAN_LOCATION_REQUIRED",
        "Selected location scope needs at least one location code.",
        "locationCodes",
      ),
    );
  if (!value.status)
    issues.push(
      error(
        "MEMBERSHIP_PLAN_STATUS_INVALID",
        "Status must be Published or Archived.",
        "status",
      ),
    );
  if (
    value.providedFields.includes("benefits") &&
    (value.providedFields.includes("creditAllowance") ||
      value.providedFields.includes("discountPercent") ||
      value.providedFields.includes("customPerk"))
  )
    issues.push(
      error(
        "MEMBERSHIP_PLAN_BENEFITS_MIXED",
        "Use Benefits JSON or convenience benefit columns, not both.",
        "benefits",
      ),
    );
  if (value.creditAllowance !== null && value.creditAllowance < 0)
    issues.push(
      error(
        "MEMBERSHIP_PLAN_BENEFITS_INVALID",
        "Credit allowance must be a non-negative whole number.",
        "creditAllowance",
      ),
    );
  if (
    value.discountPercent !== null &&
    (value.discountPercent < 0.01 ||
      value.discountPercent > 99 ||
      Math.round(value.discountPercent * 100) !== value.discountPercent * 100)
  )
    issues.push(
      error(
        "MEMBERSHIP_PLAN_BENEFITS_INVALID",
        "Discount must be 0.01-99 with at most two decimals.",
        "discountPercent",
      ),
    );
  for (const field of value.parseErrors)
    issues.push(
      error(
        "MEMBERSHIP_PLAN_BENEFITS_INVALID",
        `Invalid ${field} value.`,
        field,
      ),
    );
  return issues;
};

export const membershipPlanFileIdentityKeys = (
  value: NormalizedMembershipPlanImportRow,
) => [
  ...(value.externalId
    ? [{ kind: "externalId", value: value.externalId }]
    : []),
  ...(value.name
    ? [{ kind: "name", value: value.name.toLocaleLowerCase() }]
    : []),
];
