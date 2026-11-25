import mongoose, { type PipelineStage } from "mongoose";
import { z } from "zod";
import { PLATFORM_ROLE, TENANT_ROLE } from "./user.constants.js";
import { escapeRegex } from "./user.utils.js";

const timeZone = z
  .string()
  .max(100)
  .default("Europe/Prague")
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid time zone");
// Do not coerce empty strings, booleans or null into a meaningful zero bound.
const amountBound = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^-?\d+(?:\.\d+)?$/)
      .transform(Number),
  ])
  .pipe(
    z
      .number()
      .finite()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER),
  )
  .optional();
const filters = {
  search: z.string().trim().max(160).default(""),
  status: z.enum(["", "active", "invited", "inactive"]).default(""),
  membership: z.string().trim().max(200).default(""),
  spendMin: amountBound,
  spendMax: amountBound,
  spendFrom: z.iso.date().optional(),
  spendTo: z.iso.date().optional(),
  creditMin: amountBound,
  creditMax: amountBound,
  timeZone,
};
const validRanges = (value: {
  spendMin?: number;
  spendMax?: number;
  creditMin?: number;
  creditMax?: number;
  spendFrom?: string;
  spendTo?: string;
}) =>
  (value.spendMin === undefined ||
    value.spendMax === undefined ||
    value.spendMin <= value.spendMax) &&
  (value.creditMin === undefined ||
    value.creditMax === undefined ||
    value.creditMin <= value.creditMax) &&
  (!value.spendFrom || !value.spendTo || value.spendFrom <= value.spendTo);
export const customerDirectoryQuery = z
  .object({
    ...filters,
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict()
  .refine(validRanges, { message: "Minimum must not exceed maximum." });
export const customerDirectoryExportInput = z
  .object({
    ...filters,
    ids: z
      .array(z.string().regex(/^[a-fA-F0-9]{24}$/))
      .min(1)
      .max(10_000)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.ids ||
      (!value.search &&
        !value.status &&
        !value.membership &&
        value.spendMin === undefined &&
        value.spendMax === undefined &&
        value.creditMin === undefined &&
        value.creditMax === undefined),
    {
      message: "Choose selected customers or directory filters, not both.",
    },
  )
  .refine(validRanges, { message: "Minimum must not exceed maximum." });
export const customerDirectorySummaryQuery = z.object({ timeZone }).strict();
export type DirectoryFilters = Pick<
  z.infer<typeof customerDirectoryQuery>,
  keyof typeof filters
>;

export const customerDirectoryScope = (tenantId: string) => ({
  tenant: new mongoose.Types.ObjectId(tenantId),
  tenantRole: TENANT_ROLE.CUSTOMER,
  platformRole: { $in: [PLATFORM_ROLE.NONE, null] },
});

export const normalizeDirectoryText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
export const normalizeDirectoryKey = (value: unknown) =>
  normalizeDirectoryText(value).replace(/[\s-]+/g, "_");

// One native lookup per character, rather than a chain of replacements or
// database-side JavaScript. Only mappings relevant to this bounded search are
// sent to MongoDB. No-search directory reads do not run normalization at all.
let foldedCharacters: Array<[string, string]> | undefined;
const relevantFoldMap = (query: string) => {
  if (!foldedCharacters) {
    foldedCharacters = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const character = String.fromCodePoint(point);
      const folded = character
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      if (character !== folded) foldedCharacters.push([character, folded]);
    }
  }
  const characters = new Set(query);
  return Object.fromEntries(
    foldedCharacters.filter(
      ([, value]) =>
        !value || [...value].some((character) => characters.has(character)),
    ),
  );
};
const string = (value: any): any => ({
  $convert: { input: value, to: "string", onError: "", onNull: "" },
});
const trim = (value: any): any => ({ $trim: { input: string(value) } });
const truthy = (value: any): any => ({
  $and: [
    { $ne: [{ $ifNull: [value, null] }, null] },
    { $ne: [value, ""] },
    { $ne: [value, false] },
    { $ne: [value, 0] },
  ],
});
const first = (...values: any[]): any =>
  values.length === 1
    ? values[0]
    : { $cond: [truthy(values[0]), values[0], first(...values.slice(1))] };
const join = (values: any[]): any => ({
  $reduce: {
    input: {
      $filter: { input: values, as: "part", cond: { $ne: ["$$part", ""] } },
    },
    initialValue: "",
    in: {
      $concat: [
        "$$value",
        { $cond: [{ $eq: ["$$value", ""] }, "", " "] },
        "$$this",
      ],
    },
  },
});
const fold = (value: any, query: string): any => {
  const mapping = relevantFoldMap(query);
  const nonAscii = Object.keys(mapping)
    .filter((character) => character.codePointAt(0)! > 127)
    .join("");
  return {
    $let: {
      vars: { text: trim(value) },
      in: {
        $cond: [
          // Most identities need only ASCII case conversion for this query. Skip
          // character traversal unless a relevant accent/compatibility mark occurs.
          { $regexMatch: { input: "$$text", regex: `[${nonAscii}]` } },
          {
            $reduce: {
              input: { $range: [0, { $strLenCP: "$$text" }] },
              initialValue: "",
              in: {
                $let: {
                  vars: { character: { $substrCP: ["$$text", "$$this", 1] } },
                  in: {
                    $concat: [
                      "$$value",
                      {
                        $ifNull: [
                          {
                            $getField: {
                              field: "$$character",
                              input: { $literal: mapping },
                            },
                          },
                          "$$character",
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
          { $toLower: "$$text" },
        ],
      },
    },
  };
};
const key = (value: any, query: string): any => ({
  $reduce: {
    input: {
      $regexFindAll: { input: fold(value, query), regex: "[^\\s-]+|[\\s-]+" },
    },
    initialValue: "",
    in: {
      $concat: [
        "$$value",
        {
          $cond: [
            { $regexMatch: { input: "$$this.match", regex: "^[\\s-]+$" } },
            "_",
            "$$this.match",
          ],
        },
      ],
    },
  },
});

const membership = first(
  "$activeMembership",
  "$currentMembership",
  "$membership",
  "$membershipPlan",
  null,
);
const membershipLabel = {
  $cond: [
    { $eq: [{ $type: "$_directoryMembership" }, "string"] },
    "$_directoryMembership",
    string(
      first(
        "$_directoryMembership.name",
        "$_directoryMembership.title",
        "$_directoryMembership.planName",
        "$_directoryMembership.plan",
        "$_directoryMembership.type",
        "",
      ),
    ),
  ],
};
const number = (value: any): any => ({
  $convert: { input: value, to: "double", onError: 0, onNull: 0 },
});
const status = {
  $toLower: {
    $replaceAll: {
      input: {
        $replaceAll: {
          input: trim(
            first("$customerStatus", "$accountStatus", "$status", ""),
          ),
          find: "-",
          replacement: "_",
        },
      },
      find: " ",
      replacement: "_",
    },
  },
};

// Positive projection: credentials, guest storage and new private user fields
// cannot leak merely because the schema gains another field.
export const directoryProjection = {
  activeMembership: 1,
  membershipAvailable: 1,
  _id: 1,
  firstname: 1,
  firstName: 1,
  lastname: 1,
  lastName: 1,
  name: 1,
  displayName: 1,
  customId: 1,
  memberNumber: 1,
  phone: 1,
  phoneNumber: 1,
  createdAt: 1,
  registeredAt: 1,
  updatedAt: 1,
  isAccessGranted: 1,
  isEmailVerified: 1,
  lastLoginAt: 1,
  avatarUrl: 1,
  avatar: 1,
  image: 1,
  photo: 1,
  email: "$_directoryEmail",
  moneyCredits: "$_directoryCredits",
  customerStatus: "$_directoryStatus",
  membership: {
    key: "$_directoryMembershipKey",
    name: "$_directoryMembershipLabel",
  },
};

export const directoryDerivedStages = (): PipelineStage[] => [
  {
    $set: {
      _directoryMembership: membership,
      _directoryEmail: trim(
        first(
          "$email",
          {
            $cond: [
              {
                $and: [
                  { $eq: ["$isAccessGranted", false] },
                  {
                    $regexMatch: {
                      input: string("$customId"),
                      regex: "^G-[a-f0-9]{20}$",
                      options: "i",
                    },
                  },
                ],
              },
              "$guestContact.email",
              "",
            ],
          },
          "",
        ),
      ),
      _directoryCredits: number({
        $ifNull: [
          "$moneyCredits",
          "$creditBalance",
          "$creditsBalance",
          "$credits.balance",
          "$credits",
          "$balance",
          0,
        ],
      }),
      _directoryStatus: {
        $switch: {
          branches: [
            {
              case: {
                $in: [status, ["invited", "pending", "pending_invitation"]],
              },
              then: "invited",
            },
            {
              case: {
                $or: [
                  {
                    $in: [
                      status,
                      ["inactive", "disabled", "archived", "blocked"],
                    ],
                  },
                  { $eq: ["$isAccessGranted", false] },
                  { $eq: ["$isActive", false] },
                  { $eq: ["$active", false] },
                ],
              },
              then: "inactive",
            },
            {
              case: {
                $and: [
                  truthy("$invitedAt"),
                  { $not: [truthy("$lastLoginAt")] },
                  { $not: [truthy("$activatedAt")] },
                ],
              },
              then: "invited",
            },
          ],
          default: "active",
        },
      },
    },
  },
  {
    $set: {
      _directoryMembershipLabel: membershipLabel,
      _directoryCredits: {
        $cond: [
          {
            $and: [
              { $gte: ["$_directoryCredits", -Number.MAX_VALUE] },
              { $lte: ["$_directoryCredits", Number.MAX_VALUE] },
            ],
          },
          "$_directoryCredits",
          0,
        ],
      },
    },
  },
  {
    $set: {
      _directoryMembershipKey: string({
        $cond: [
          { $eq: [{ $type: "$_directoryMembership" }, "string"] },
          "$_directoryMembership",
          first(
            "$_directoryMembership.slug",
            "$_directoryMembership.key",
            "$_directoryMembershipLabel",
            "none",
          ),
        ],
      }),
    },
  },
];

export const directoryFilterStages = (
  input: DirectoryFilters,
): PipelineStage[] => {
  const expressions: any[] = [];
  const search = normalizeDirectoryText(input.search);
  if (search) {
    const fullName = first(
      join([
        string(first("$firstname", "$firstName", "")),
        string(first("$lastname", "$lastName", "")),
      ]),
      "$name",
      "$displayName",
      "",
    );
    const member = {
      $cond: [
        {
          $and: [
            {
              $regexMatch: {
                input: trim("$memberNumber"),
                regex: "^[1-9][0-9]*$",
              },
            },
            { $lte: [number("$memberNumber"), Number.MAX_SAFE_INTEGER] },
          ],
        },
        trim("$memberNumber"),
        "",
      ],
    };
    const haystack = join(
      [
        fullName,
        "$_directoryEmail",
        "$customId",
        "$phone",
        "$phoneNumber",
        member,
        { $cond: [{ $ne: [member, ""] }, { $concat: ["#", member] }, ""] },
      ].map(trim),
    );
    expressions.push({
      $regexMatch: {
        input: fold(haystack, search),
        regex: escapeRegex(search),
        options: "i",
      },
    });
  }
  if (input.status)
    expressions.push({ $eq: ["$_directoryStatus", input.status] });
  if (input.membership) {
    const normalized = normalizeDirectoryKey(input.membership);
    // getCustomerMembership replaces literal spaces before filter normalization.
    const rawKey = {
      $replaceAll: {
        input: "$_directoryMembershipKey",
        find: " ",
        replacement: "_",
      },
    };
    expressions.push({
      $regexMatch: {
        input: key(rawKey, normalized),
        regex: `^${escapeRegex(normalized)}$`,
        options: "i",
      },
    });
  }
  return expressions.length
    ? [{ $match: { $expr: { $and: expressions } } }]
    : [];
};

export const directoryRow = (row: any) => ({
  ...row,
  id: String(row._id),
  membership: {
    key: String(row.membership?.key || "none")
      .toLowerCase()
      .replaceAll(" ", "_"),
    name: row.membership?.name || "",
  },
  moneyCredits: Number.isFinite(row.moneyCredits) ? row.moneyCredits : null,
});
