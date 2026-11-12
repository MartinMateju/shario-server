import { createHash } from "node:crypto";

import BookingModel from "@/modules/booking/booking.model.js";
import { loadCourseCapacityForBookings } from "@/modules/booking/booking.course-capacity.js";
import { validateOpenStudioAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";
import LocationModel from "@/modules/location/location.model.js";
import ProductModel from "@/modules/product/product.model.js";
import { getStudioProductLocationId, isStudioProduct } from "@/modules/product/product-location.policy.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import UserModel from "@/modules/user/user.model.js";
import {
  parseDateStringInTimezone,
  parseTimeString,
} from "@/shared/time/time.utils.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import type {
  BookingImportColumnMapping,
  ImportIssue,
  NormalizedBookingImportRow,
} from "../data-import.types.js";
import {
  bookingHasCustomerIdentity,
  normalizeBookingImportRow,
  validateBookingImportRow,
} from "../adapters/booking-import.adapter.js";
import {
  isProtectedWorkspaceUser,
  normalizeImportPhone,
} from "../adapters/customer-import.adapter.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import {
  createDataImportSession,
  getTenantImportSession,
  serializeImportSession,
} from "./data-import.service.js";
import { assertValidBookingColumnMapping } from "./import-column-mapping.service.js";
import { assertImportedBookingProductLocation } from "./booking-import-location.policy.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";

export const createBookingImportSession = async (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({ ...args, entityType: DATA_IMPORT_ENTITY.BOOKINGS });

type LookupRecord = {
  _id: any;
  type?: string;
  kind?: string;
  location?: unknown;
  [key: string]: any;
};

const addToMultiMap = <T>(map: Map<string, T[]>, key: string, value: T) => {
  if (!key) return;
  map.set(key, [...(map.get(key) || []), value]);
};

const resolveUniqueLookup = (
  candidates: Array<{ records?: LookupRecord[]; kind: string }>,
) => {
  const matched = new Map<string, { record: LookupRecord; kind: string }>();
  let ambiguous = false;
  for (const candidate of candidates) {
    if (!candidate.records?.length) continue;
    if (candidate.records.length > 1) ambiguous = true;
    for (const record of candidate.records) {
      matched.set(String(record._id), { record, kind: candidate.kind });
    }
  }
  if (ambiguous || matched.size > 1)
    return { record: null, kind: null, ambiguous: true };
  const match = [...matched.values()][0];
  return {
    record: match?.record || null,
    kind: match?.kind || null,
    ambiguous: false,
  };
};

const productKind = (product: LookupRecord): string => {
  if (["open-studio", "class", "private-studio"].includes(product.kind))
    return product.kind;
  if (
    ["workshop", "public-workshop", "private-workshop"].includes(product.type)
  )
    return "open-studio";
  if (["course", "public-course", "private-course"].includes(product.type))
    return "class";
  if (["blocker", "private-studio"].includes(product.type))
    return "private-studio";
  return "";
};

const canonicalBookingTag = (value: unknown): string => {
  const tag = String(value || "");
  if (["open-studio", "workshop"].includes(tag)) return "open-studio";
  if (["class", "course"].includes(tag)) return "class";
  if (["private-studio", "private-session"].includes(tag))
    return "private-studio";
  return tag;
};

const bookingTagAliases = (value: unknown): string[] => {
  const tag = canonicalBookingTag(value);
  if (tag === "open-studio") return ["open-studio", "workshop"];
  if (tag === "class") return ["class", "course"];
  if (tag === "private-studio") return ["private-studio", "private-session"];
  return tag ? [tag] : [];
};

const formatWallTime = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
};

const addCalendarDay = (date: string): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const offsetCache = new Map<string, number[]>();
const MAX_OFFSET_CACHE_ENTRIES = 2_000;

const timezoneOffsetsNearDate = (date: string, timezone: string): number[] => {
  const cacheKey = `${timezone}|${date}`;
  const cached = offsetCache.get(cacheKey);
  if (cached) return cached;
  const [year, month, day] = date.split("-").map(Number);
  const anchor = Date.UTC(year, month - 1, day, 12);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = new Date(anchor + hours * 60 * 60_000);
    const wall = formatWallTime(instant, timezone);
    const wallAsUtc = Date.parse(`${wall.replace(" ", "T")}:00Z`);
    if (Number.isFinite(wallAsUtc)) {
      offsets.add(Math.round((wallAsUtc - instant.getTime()) / 60_000));
    }
  }
  const result = [...offsets];
  if (offsetCache.size >= MAX_OFFSET_CACHE_ENTRIES) {
    offsetCache.delete(offsetCache.keys().next().value as string);
  }
  offsetCache.set(cacheKey, result);
  return result;
};

const wallInstants = ({
  date,
  hour,
  minute,
  timezone,
}: {
  date: string;
  hour: number;
  minute: number;
  timezone: string;
}): Date[] => {
  const [year, month, day] = date.split("-").map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  const target = `${date} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const matches = new Map<number, Date>();
  for (const offset of timezoneOffsetsNearDate(date, timezone)) {
    const candidate = new Date(naiveUtc - offset * 60_000);
    if (formatWallTime(candidate, timezone) === target) {
      matches.set(candidate.getTime(), candidate);
    }
  }
  return [...matches.values()].sort(
    (left, right) => left.getTime() - right.getTime(),
  );
};

export const resolveLocalBookingRange = ({
  date,
  startTime,
  endTime,
  timezone,
}: {
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
}): { range: { start: Date; end: Date } | null; issueCode?: string } => {
  if (
    !parseDateStringInTimezone(date, timezone) ||
    !parseTimeString(startTime) ||
    !parseTimeString(endTime)
  ) {
    return { range: null, issueCode: "BOOKING_LOCAL_TIME_INVALID" };
  }
  const parsedStart = parseTimeString(startTime)!;
  const parsedEnd = parseTimeString(endTime)!;
  const startMinutes = parsedStart.hour * 60 + parsedStart.minute;
  const endMinutes = parsedEnd.hour * 60 + parsedEnd.minute;
  if (startMinutes === endMinutes) {
    return { range: null, issueCode: "BOOKING_RANGE_INVALID" };
  }
  const crossesMidnight = endMinutes < startMinutes;
  const endDate = crossesMidnight ? addCalendarDay(date) : date;
  let starts: Date[];
  let ends: Date[];
  try {
    starts = wallInstants({
      date,
      hour: parsedStart.hour,
      minute: parsedStart.minute,
      timezone,
    });
    ends = wallInstants({
      date: endDate,
      hour: parsedEnd.hour,
      minute: parsedEnd.minute,
      timezone,
    });
  } catch {
    return { range: null, issueCode: "BOOKING_LOCAL_TIME_INVALID" };
  }
  if (starts.length > 1 || ends.length > 1) {
    return { range: null, issueCode: "BOOKING_LOCAL_TIME_AMBIGUOUS" };
  }
  if (!starts.length || !ends.length) {
    return { range: null, issueCode: "BOOKING_LOCAL_TIME_NONEXISTENT" };
  }
  if (ends[0].getTime() <= starts[0].getTime()) {
    return { range: null, issueCode: "BOOKING_RANGE_INVALID" };
  }
  return { range: { start: starts[0], end: ends[0] } };
};

const warning = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "warning" });
const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });

const createFingerprint = ({
  tenantId,
  customerId,
  kind,
  productId,
  locationId,
  start,
}: {
  tenantId: string;
  customerId?: string;
  kind: string;
  productId: string;
  locationId: string;
  start: string;
}) =>
  createHash("sha256")
    .update(
      `v1|${tenantId}|${customerId || `session:${kind}`}|${productId}|${locationId}|${start}`,
    )
    .digest("hex");

const emptySummary = (total: number) => ({
  total,
  valid: 0,
  warnings: 0,
  invalid: 0,
  duplicates: 0,
  toCreate: 0,
  toUpdate: 0,
  toSkip: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
});

const isHistorical = (row: NormalizedBookingImportRow): boolean =>
  ["completed", "cancelled", "delivered"].includes(row.status) ||
  (Boolean(row.end) && new Date(row.end).getTime() <= Date.now());

const hasLocationAccess = (membership: any, locationId: string): boolean =>
  membership?.locationAccess?.mode !== "selected" ||
  (membership.locationAccess.locationIds || []).some(
    (id: any) => String(id) === locationId,
  );

export const validateBookingImportSession = async ({
  tenantId,
  sessionId,
  mapping: mappingInput,
  duplicateStrategy,
  actorId,
  tenantLanguage,
}: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantLanguage: string;
}) => {
  if (
    !Object.values(DATA_IMPORT_DUPLICATE_STRATEGY).includes(duplicateStrategy)
  ) {
    badRequest({
      message: "Duplicate strategy must be skip or update.",
      code: "IMPORT_DUPLICATE_STRATEGY_INVALID",
    });
  }
  const current = await getTenantImportSession({ tenantId, sessionId });
  if (
    current.entityType !== DATA_IMPORT_ENTITY.BOOKINGS ||
    ![
      DATA_IMPORT_STATUS.UPLOADED,
      DATA_IMPORT_STATUS.VALIDATED,
      DATA_IMPORT_STATUS.FAILED,
    ].includes(current.status as never)
  ) {
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
      details: { status: current.status },
    });
  }
  const mapping: BookingImportColumnMapping = assertValidBookingColumnMapping(
    current.headers,
    mappingInput,
  );
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: current._id,
      tenant: tenantId,
      entityType: DATA_IMPORT_ENTITY.BOOKINGS,
      status: {
        $in: [
          DATA_IMPORT_STATUS.UPLOADED,
          DATA_IMPORT_STATUS.VALIDATED,
          DATA_IMPORT_STATUS.FAILED,
        ],
      },
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.VALIDATING,
        lastError: null,
        completedAt: null,
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!session)
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
    });

  try {
    const [rows, users, products, locations, memberships, actorMembership] =
      await Promise.all([
        DataImportRowModel.find({ tenant: tenantId, session: current._id })
          .sort({ rowNumber: 1 })
          .lean(),
        UserModel.find({ tenant: tenantId })
          .select(
            "_id firstname lastname customId email phone importMetadata.externalId +tenantRole +roles",
          )
          .lean(),
        ProductModel.find({ tenant: tenantId })
          .select(
            "_id name sku kind type location bookingMode maxNumberOfParticipants isActive +importMetadata",
          )
          .lean(),
        LocationModel.find({ tenant: tenantId })
          .select("_id name slug code isActive booking")
          .lean(),
        TenantMembershipModel.find({ tenant: tenantId }).select("user").lean(),
        TenantMembershipModel.findOne({
          tenant: tenantId,
          user: actorId,
          status: "active",
        })
          .select("role locationAccess")
          .lean(),
      ]);
    if (!actorMembership)
      throw new Error("Active workspace membership is required.");
    const accessibleLocations = (locations as LookupRecord[]).filter(
      (location) => hasLocationAccess(actorMembership, String(location._id)),
    );
    const protectedUsers = new Set(
      memberships.map((item: any) => String(item.user)),
    );
    const customerExternal = new Map<string, LookupRecord[]>();
    const customerEmail = new Map<string, LookupRecord[]>();
    const customerPhone = new Map<string, LookupRecord[]>();
    for (const user of users as LookupRecord[]) {
      if (
        protectedUsers.has(String(user._id)) ||
        isProtectedWorkspaceUser(
          user as { tenantRole?: string; roles?: string[] },
        )
      )
        continue;
      addToMultiMap(
        customerExternal,
        String(user.importMetadata?.externalId || "").trim(),
        user,
      );
      addToMultiMap(
        customerEmail,
        String(user.email || "")
          .trim()
          .toLocaleLowerCase(),
        user,
      );
      addToMultiMap(
        customerPhone,
        normalizeImportPhone(String(user.phone || "")),
        user,
      );
    }
    const productExternal = new Map<string, LookupRecord[]>();
    const productSku = new Map<string, LookupRecord[]>();
    const productName = new Map<string, LookupRecord[]>();
    for (const product of products as LookupRecord[]) {
      addToMultiMap(
        productExternal,
        String(product.importMetadata?.externalId || "").trim(),
        product,
      );
      addToMultiMap(
        productSku,
        String(product.sku || "")
          .trim()
          .toLocaleLowerCase(),
        product,
      );
      addToMultiMap(
        productName,
        String(product.name || "")
          .trim()
          .toLocaleLowerCase(),
        product,
      );
    }
    const locationCode = new Map<string, LookupRecord[]>();
    const locationSlug = new Map<string, LookupRecord[]>();
    const locationName = new Map<string, LookupRecord[]>();
    for (const location of accessibleLocations) {
      addToMultiMap(
        locationCode,
        String(location.code || "")
          .trim()
          .toUpperCase(),
        location,
      );
      addToMultiMap(
        locationSlug,
        String(location.slug || "")
          .trim()
          .toLocaleLowerCase(),
        location,
      );
      addToMultiMap(
        locationName,
        String(location.name || "")
          .trim()
          .toLocaleLowerCase(),
        location,
      );
    }

    const prepared: Array<{
      row: any;
      normalized: NormalizedBookingImportRow;
      issues: ImportIssue[];
      product?: LookupRecord;
      location?: LookupRecord;
      productResolvedByLocation?: boolean;
    }> = [];
    for (const row of rows) {
      const normalized = normalizeBookingImportRow(
        row.raw as Record<string, string>,
        mapping,
      );
      const issues = validateBookingImportRow(normalized);
      const productCandidates = [
        {
          records: normalized.productExternalId
            ? productExternal.get(normalized.productExternalId)
            : undefined,
          kind: "externalId",
        },
        {
          records: normalized.productSku
            ? productSku.get(normalized.productSku.toLocaleLowerCase())
            : undefined,
          kind: "sku",
        },
        {
          records: normalized.productName
            ? productName.get(normalized.productName.toLocaleLowerCase())
            : undefined,
          kind: "name",
        },
      ];

      let locationMatch = resolveUniqueLookup([
        {
          records: normalized.locationCode
            ? locationCode.get(normalized.locationCode)
            : undefined,
          kind: "code",
        },
        {
          records: normalized.locationSlug
            ? locationSlug.get(normalized.locationSlug)
            : undefined,
          kind: "slug",
        },
        {
          records: normalized.locationName
            ? locationName.get(normalized.locationName.toLocaleLowerCase())
            : undefined,
          kind: "name",
        },
      ]);
      if (
        !normalized.locationCode &&
        !normalized.locationSlug &&
        !normalized.locationName &&
        accessibleLocations.length === 1
      ) {
        locationMatch = {
          record: accessibleLocations[0],
          kind: "default",
          ambiguous: false,
        };
        issues.push(
          warning(
            "BOOKING_LOCATION_DEFAULTED",
            "The workspace member's only accessible location was selected automatically.",
          ),
        );
      } else if (locationMatch.ambiguous) {
        issues.push(
          error(
            "BOOKING_LOCATION_AMBIGUOUS",
            "Location identifiers match different or ambiguous records.",
          ),
        );
      } else if (!locationMatch.record) {
        issues.push(
          error(
            "BOOKING_LOCATION_REQUIRED",
            accessibleLocations.length > 1
              ? "Choose a location for this booking."
              : "No accessible workspace location could be resolved.",
          ),
        );
      }

      if (
        locationMatch.record &&
        !hasLocationAccess(actorMembership, String(locationMatch.record._id))
      ) {
        issues.push(
          error(
            "BOOKING_LOCATION_NOT_FOUND",
            "The location is not available to this workspace member.",
          ),
        );
        locationMatch = { record: null, kind: null, ambiguous: false };
      }
      if (
        !normalized.start &&
        !normalized.end &&
        normalized.date &&
        normalized.startTime &&
        normalized.endTime &&
        locationMatch.record
      ) {
        const timezone = String(
          locationMatch.record.booking?.timezone || "Europe/Prague",
        );
        const local = resolveLocalBookingRange({
          date: normalized.date,
          startTime: normalized.startTime,
          endTime: normalized.endTime,
          timezone,
        });
        if (local.range) {
          normalized.start = local.range.start.toISOString();
          normalized.end = local.range.end.toISOString();
          normalized.resolvedTimezone = timezone;
        } else {
          issues.push(
            error(
              local.issueCode || "BOOKING_LOCAL_TIME_INVALID",
              "The local booking time is invalid or ambiguous. Use timestamps with explicit offsets.",
              "date",
            ),
          );
        }
      }
      if (normalized.start && normalized.end) {
        const durationMinutes =
          (new Date(normalized.end).getTime() -
            new Date(normalized.start).getTime()) /
          60_000;
        if (
          !Number.isFinite(durationMinutes) ||
          durationMinutes <= 0 ||
          durationMinutes > 24 * 60
        ) {
          issues.push(
            error(
              "BOOKING_RANGE_INVALID",
              "Booking duration must be greater than zero and at most 24 hours.",
              "end",
            ),
          );
        } else {
          normalized.durationHours = durationMinutes / 60;
          const min = Number(
            locationMatch.record?.booking?.minBookingMinutes || 0,
          );
          const max = Number(
            locationMatch.record?.booking?.maxBookingMinutes || 0,
          );
          if ((min && durationMinutes < min) || (max && durationMinutes > max))
            issues.push(
              warning(
                "BOOKING_DURATION_OUTSIDE_CURRENT_RULES",
                "The source duration is outside the location's current booking rules.",
              ),
            );
        }
      }

      let productMatch = resolveUniqueLookup(productCandidates);
      let productResolvedByLocation = false;
      let productUnavailableAtLocation = false;
      if (
        productMatch.ambiguous &&
        !normalized.productExternalId &&
        locationMatch.record &&
        new Date(normalized.end).getTime() > Date.now() &&
        !isHistorical(normalized)
      ) {
        const selectedLocationId = String(locationMatch.record._id);
        const scopedCandidates = productCandidates.map((candidate) => {
          // Keep unique identifiers intact: a unique SKU must still conflict
          // with a name that points at a different product. Only repeated
          // studio names/SKUs may use the row's location to disambiguate.
          if (
            !candidate.records ||
            candidate.records.length < 2 ||
            !candidate.records.every(isStudioProduct)
          ) return candidate;
          const records = candidate.records.filter(
            (product) => getStudioProductLocationId(product) === selectedLocationId,
          );
          if (!records.length) productUnavailableAtLocation = true;
          return { ...candidate, records };
        });
        productMatch = productUnavailableAtLocation
          ? { record: null, kind: null, ambiguous: false }
          : resolveUniqueLookup(scopedCandidates);
        productResolvedByLocation = Boolean(productMatch.record);
      }
      if (productUnavailableAtLocation) {
        issues.push(error(
          "PRODUCT_LOCATION_MISMATCH",
          "Products matching these identifiers are not offered at the selected location.",
        ));
      } else if (productMatch.ambiguous) {
        issues.push(error(
          "BOOKING_PRODUCT_AMBIGUOUS",
          "Product identifiers match different or ambiguous records.",
        ));
      } else if (!productMatch.record) {
        issues.push(error(
          "BOOKING_PRODUCT_NOT_FOUND",
          "The product could not be found in this workspace.",
        ));
      }

      const kind = productMatch.record ? productKind(productMatch.record) : "";
      if (!kind)
        issues.push(
          error(
            "BOOKING_PRODUCT_NOT_BOOKABLE",
            "This product kind cannot be imported as a booking.",
          ),
        );
      const hasCustomer = bookingHasCustomerIdentity(normalized);
      let customer: LookupRecord | null = null;
      if (kind === "open-studio") {
        // Booking imports have no public/private selection column. Never
        // silently turn an imported private reservation into a public one.
        if (productMatch.record?.bookingMode === "customer-choice")
          issues.push(
            error(
              "BOOKING_IMPORT_MODE_REQUIRED",
              "This product requires a public or private choice. Create the booking through the booking flow, or import it using a product with a fixed Shared or Exclusive mode.",
            ),
          );
        if (!hasCustomer)
          issues.push(
            error(
              "BOOKING_CUSTOMER_REQUIRED",
              "Open Studio bookings require a customer identifier.",
            ),
          );
        const customerMatch = resolveUniqueLookup([
          {
            records: normalized.customerExternalId
              ? customerExternal.get(normalized.customerExternalId)
              : undefined,
            kind: "externalId",
          },
          {
            records: normalized.customerEmail
              ? customerEmail.get(normalized.customerEmail)
              : undefined,
            kind: "email",
          },
          {
            records: normalized.customerPhone
              ? customerPhone.get(normalized.customerPhone)
              : undefined,
            kind: "phone",
          },
        ]);
        if (customerMatch.ambiguous)
          issues.push(
            error(
              "BOOKING_CUSTOMER_AMBIGUOUS",
              "Customer identifiers match different or ambiguous records.",
            ),
          );
        else if (hasCustomer && !customerMatch.record)
          issues.push(
            error(
              "BOOKING_CUSTOMER_NOT_FOUND",
              "The customer could not be found in this workspace.",
            ),
          );
        customer = customerMatch.record;
        normalized.tag = "open-studio";
        normalized.bookingMode =
          productMatch.record?.bookingMode === "private" ||
          productMatch.record?.type === "private-workshop"
            ? "private"
            : "public";
      } else if (kind === "class") {
        if (hasCustomer)
          issues.push(
            error(
              "BOOKING_CLASS_ENROLLMENT_UNSUPPORTED",
              "Class customer enrolments require Orders and cannot be imported as calendar sessions.",
            ),
          );
        for (
          let issueIndex = issues.length - 1;
          issueIndex >= 0;
          issueIndex -= 1
        ) {
          if (issues[issueIndex].code === "BOOKING_GUESTS_INVALID")
            issues.splice(issueIndex, 1);
        }
        if (normalized.numberOfGuestsProvided)
          issues.push(
            warning(
              "BOOKING_SESSION_GUESTS_IGNORED",
              "Guest count is ignored for a Class calendar session.",
            ),
          );
        normalized.numberOfGuests = 0;
        normalized.tag = "class";
        normalized.bookingMode = null;
      } else if (kind === "private-studio") {
        if (hasCustomer)
          issues.push(
            error(
              "BOOKING_PRIVATE_SESSION_CUSTOMER_UNSUPPORTED",
              "Private Studio calendar sessions cannot be attached to a customer.",
            ),
          );
        for (
          let issueIndex = issues.length - 1;
          issueIndex >= 0;
          issueIndex -= 1
        ) {
          if (issues[issueIndex].code === "BOOKING_GUESTS_INVALID")
            issues.splice(issueIndex, 1);
        }
        if (normalized.numberOfGuestsProvided)
          issues.push(
            warning(
              "BOOKING_SESSION_GUESTS_IGNORED",
              "Guest count is ignored for a Private Studio calendar session.",
            ),
          );
        normalized.numberOfGuests = 0;
        normalized.tag = "private-studio";
        normalized.bookingMode = null;
      }
      if (customer) normalized.customerId = String(customer._id);
      if (productMatch.record) {
        normalized.productId = String(productMatch.record._id);
        normalized.productKind = kind as never;
      }
      if (locationMatch.record)
        normalized.locationId = String(locationMatch.record._id);
      if (!normalized.language)
        normalized.language =
          String(tenantLanguage || "cs").toLocaleLowerCase() === "en"
            ? "en"
            : "cs";
      if (!normalized.status && normalized.end)
        normalized.status =
          new Date(normalized.end).getTime() <= Date.now()
            ? "completed"
            : "processed";
      if (
        ["completed", "delivered"].includes(normalized.status) &&
        normalized.end &&
        new Date(normalized.end).getTime() > Date.now()
      ) {
        issues.push(
          error(
            "BOOKING_STATUS_TIME_INCONSISTENT",
            "Completed or delivered bookings cannot end in the future.",
            "status",
          ),
        );
      }

      if (productMatch.record && productMatch.record.isActive === false) {
        issues.push(
          warning(
            "BOOKING_PRODUCT_INACTIVE",
            "This source booking uses an inactive product and will be preserved.",
          ),
        );
      }
      if (
        kind === "open-studio" &&
        normalized.numberOfGuests !== null &&
        Number(productMatch.record?.maxNumberOfParticipants || 0) > 0 &&
        normalized.numberOfGuests >
          Number(productMatch.record?.maxNumberOfParticipants)
      ) {
        issues.push(
          warning(
            "BOOKING_PRODUCT_CAPACITY_EXCEEDED",
            "The source party exceeds the product's current participant capacity and will be preserved.",
          ),
        );
      }
      if (
        locationMatch.record &&
        (!locationMatch.record.isActive ||
          locationMatch.record.booking?.enabled !== true)
      ) {
        issues.push(
          warning(
            "BOOKING_LOCATION_INACTIVE",
            "This source booking uses an inactive or booking-disabled location and will be preserved.",
          ),
        );
      }
      if (
        normalized.productId &&
        normalized.locationId &&
        normalized.start &&
        kind &&
        (kind !== "open-studio" || normalized.customerId)
      ) {
        normalized.fingerprint = createFingerprint({
          tenantId,
          customerId:
            kind === "open-studio" ? normalized.customerId : undefined,
          kind,
          productId: normalized.productId,
          locationId: normalized.locationId,
          start: normalized.start,
        });
        if (!normalized.externalId)
          issues.push(
            warning(
              "BOOKING_ID_DERIVED",
              "No external ID was provided; a stable booking fingerprint will be used.",
            ),
          );
      }
      prepared.push({
        row,
        normalized,
        issues,
        product: productMatch.record || undefined,
        location: locationMatch.record || undefined,
        productResolvedByLocation,
      });
    }

    const externalIds = prepared
      .map((item) => item.normalized.externalId)
      .filter(Boolean) as string[];
    const fingerprints = prepared
      .map((item) => item.normalized.fingerprint)
      .filter(Boolean) as string[];
    const identityConditions = [
      ...(externalIds.length
        ? [{ "importMetadata.externalId": { $in: externalIds } }]
        : []),
      ...(fingerprints.length
        ? [{ "importMetadata.fingerprint": { $in: fingerprints } }]
        : []),
    ];
    const existingImports = identityConditions.length
      ? await BookingModel.find({ tenant: tenantId, $or: identityConditions })
          .select(
            "_id orders createdBy bookingProduct location start end status tag numberOfGuests language plannedActivity lecturer description note +importMetadata",
          )
          .lean()
      : [];
    const naturalConditions = prepared
      .filter(
        (item) =>
          (item.normalized.productKind !== "open-studio" ||
            item.normalized.customerId) &&
          item.normalized.productId &&
          item.normalized.locationId &&
          item.normalized.start &&
          item.normalized.tag,
      )
      .map((item) => ({
        ...(item.normalized.productKind === "open-studio"
          ? { createdBy: item.normalized.customerId }
          : {}),
        bookingProduct: item.normalized.productId,
        location: item.normalized.locationId,
        start: new Date(item.normalized.start),
        tag: { $in: bookingTagAliases(item.normalized.tag) },
      }));
    const nativeBookings: any[] = [];
    for (let index = 0; index < naturalConditions.length; index += 250) {
      const batch = await BookingModel.find({
        tenant: tenantId,
        $or: naturalConditions.slice(index, index + 250),
      } as any)
        .select(
          "_id createdBy bookingProduct location start end status tag orders numberOfGuests language plannedActivity lecturer description note +importMetadata",
        )
        .lean();
      nativeBookings.push(...(batch as any[]));
    }
    const naturalKey = (value: any) => {
      const tag = canonicalBookingTag(value.tag);
      const owner =
        tag === "open-studio"
          ? String(value.createdBy || value.customerId)
          : `session:${tag}`;
      return `${owner}|${String(value.bookingProduct || value.productId)}|${String(value.location || value.locationId)}|${new Date(value.start).toISOString()}|${tag}`;
    };
    const byNatural = new Map<string, LookupRecord[]>();
    for (const item of nativeBookings) {
      addToMultiMap(byNatural, naturalKey(item), item);
    }
    const byExternal = new Map(
      (existingImports as LookupRecord[])
        .filter((item) => item.importMetadata?.externalId)
        .map((item) => [item.importMetadata.externalId, item]),
    );
    const byFingerprint = new Map(
      (existingImports as LookupRecord[])
        .filter((item) => item.importMetadata?.fingerprint)
        .map((item) => [item.importMetadata.fingerprint, item]),
    );

    const availabilityConditions = prepared
      .filter(
        (item) =>
          item.normalized.tag === "open-studio" &&
          !isHistorical(item.normalized) &&
          item.normalized.start &&
          item.normalized.end &&
          item.normalized.locationId,
      )
      .map((item) => ({
        location: item.normalized.locationId,
        start: { $lt: new Date(item.normalized.end) },
        end: { $gt: new Date(item.normalized.start) },
      }));
    const currentById = new Map<string, any>();
    for (let index = 0; index < availabilityConditions.length; index += 250) {
      const batch = await BookingModel.find({
        tenant: tenantId,
        $or: availabilityConditions.slice(index, index + 250),
      })
        .select(
          "_id bookingProduct location start end status archive paymentStatus paymentExpiresAt tag bookingType bookingMode plannedActivity courseEquipmentRequired numberOfGuests capacityReservations waitlistCapacityHolds",
        )
        .lean();
      for (const booking of batch as any[])
        currentById.set(String(booking._id), booking);
    }
    const currentBookings = [...currentById.values()];
    await loadCourseCapacityForBookings({ bookings: currentBookings, tenantId });
    const locationById = new Map(
      accessibleLocations.map((item) => [String(item._id), item]),
    );
    const acceptedFileBookings: any[] = [];
    const fileExternal = new Map<string, number>();
    const fileFingerprint = new Map<string, number>();
    const summary = emptySummary(prepared.length);
    const operations: any[] = [];

    for (const item of prepared) {
      const { row, normalized, issues } = item;
      const extMatch = normalized.externalId
        ? byExternal.get(normalized.externalId)
        : undefined;
      const fingerprintMatch = normalized.fingerprint
        ? byFingerprint.get(normalized.fingerprint)
        : undefined;
      const naturalIdentityReady =
        normalized.productKind !== "open-studio" || normalized.customerId;
      const naturalMatches =
        naturalIdentityReady &&
        normalized.productId &&
        normalized.locationId &&
        normalized.start &&
        normalized.tag
          ? byNatural.get(naturalKey(normalized)) || []
          : [];
      const naturalMatch =
        naturalMatches.length === 1 ? naturalMatches[0] : undefined;
      let duplicate: any = null;
      const databaseMatches = new Map(
        [extMatch, fingerprintMatch, ...naturalMatches]
          .filter(Boolean)
          .map((record: any) => [String(record._id), record]),
      );
      if (naturalMatches.length > 1) {
        issues.push(
          error(
            "BOOKING_IDENTITY_AMBIGUOUS",
            "Multiple existing bookings share this natural identity.",
          ),
        );
      } else if (databaseMatches.size > 1) {
        issues.push(
          error(
            "BOOKING_IDENTITY_CONFLICT",
            "External ID, fingerprint, and natural identity match different bookings.",
          ),
        );
      } else if (databaseMatches.size === 1) {
        const record = [...databaseMatches.values()][0];
        duplicate = {
          kind: extMatch
            ? "externalId"
            : fingerprintMatch
              ? "fingerprint"
              : "natural",
          existingRecordId: record._id,
          record,
        };
      }
      if (isRolledBackImportRecord(duplicate?.record))
        issues.push({ ...rolledBackImportIssue });
      if (
        duplicate?.record &&
        item.productResolvedByLocation &&
        String(duplicate.record.bookingProduct) !== normalized.productId
      ) {
        issues.push(error(
          "BOOKING_PRODUCT_AMBIGUOUS",
          "Location-based product selection cannot replace an existing booking's product. Supply a stable product identifier.",
        ));
      }
      if (
        duplicate?.record &&
        canonicalBookingTag(duplicate.record.tag) !== normalized.tag
      ) {
        issues.push(
          error(
            "BOOKING_KIND_UPDATE_FORBIDDEN",
            "An import cannot change an existing booking kind.",
          ),
        );
      }
      if (
        duplicate?.record &&
        !hasLocationAccess(actorMembership, String(duplicate.record.location))
      ) {
        issues.push(
          error(
            "BOOKING_LOCATION_NOT_FOUND",
            "The existing booking is not available to this workspace member.",
          ),
        );
      }
      if (
        duplicate?.record &&
        duplicateStrategy === "update" &&
        (!duplicate.record.importMetadata ||
          (duplicate.record.orders || []).length)
      ) {
        issues.push(
          error(
            "BOOKING_EXISTING_RECORD_PROTECTED",
            "Only import-owned bookings without Orders can be updated.",
          ),
        );
      }
      const provided = new Set(normalized.providedFields || []);
      const effective = { ...normalized };
      if (duplicate?.record && duplicateStrategy === "update") {
        if (!provided.has("status"))
          effective.status = String(
            duplicate.record.status || normalized.status,
          );
        if (!provided.has("numberOfGuests"))
          effective.numberOfGuests = Number(
            duplicate.record.numberOfGuests ?? normalized.numberOfGuests,
          );
        if (!provided.has("language"))
          effective.language = String(
            duplicate.record.language || normalized.language,
          );
        if (!provided.has("plannedActivity"))
          effective.plannedActivity = String(
            duplicate.record.plannedActivity || normalized.plannedActivity,
          );
        if (!provided.has("lecturer"))
          effective.lecturer = String(duplicate.record.lecturer || "");
        if (!provided.has("description"))
          effective.description = String(duplicate.record.description || "");
        if (!provided.has("note"))
          effective.note = String(duplicate.record.note || "");
        if (
          !(["locationCode", "locationSlug", "locationName"] as const).some(
            (field) => provided.has(field),
          )
        ) {
          effective.locationId = String(duplicate.record.location);
        }
      }
      if (
        duplicate?.record &&
        duplicateStrategy === "update" &&
        normalized.productKind === "open-studio"
      ) {
        const existingHistorical =
          ["completed", "cancelled", "delivered"].includes(
            String(duplicate.record.status),
          ) || new Date(duplicate.record.end).getTime() <= Date.now();
        const scheduleOrRecipientChanged =
          String(duplicate.record.createdBy) !==
            String(normalized.customerId) ||
          String(duplicate.record.bookingProduct) !==
            String(normalized.productId) ||
          String(duplicate.record.location) !== String(effective.locationId) ||
          new Date(duplicate.record.start).getTime() !==
            new Date(effective.start).getTime() ||
          new Date(duplicate.record.end).getTime() !==
            new Date(effective.end).getTime();
        if (
          (!existingHistorical || !isHistorical(effective)) &&
          scheduleOrRecipientChanged
        ) {
          issues.push(
            error(
              "BOOKING_FUTURE_RESCHEDULE_UNSUPPORTED",
              "Use the normal rescheduling flow to change a future Open Studio reservation's customer, product, location, or time.",
            ),
          );
        }
        if (
          provided.has("status") &&
          String(duplicate.record.status) !== effective.status &&
          (new Date(duplicate.record.end).getTime() > Date.now() ||
            new Date(effective.end).getTime() > Date.now())
        ) {
          issues.push(
            error(
              "BOOKING_FUTURE_STATUS_UPDATE_UNSUPPORTED",
              "Use the normal booking lifecycle to change a future Open Studio reservation's status.",
            ),
          );
        }
      }
      if (
        item.product &&
        effective.productId &&
        effective.locationId &&
        (!duplicate?.record || duplicateStrategy === "update")
      ) {
        try {
          assertImportedBookingProductLocation({
            product: item.product,
            booking: effective,
            existing: duplicate?.record,
          });
        } catch (locationError: any) {
          issues.push(error(String(locationError.code), locationError.message));
        }
      }
      const earlierExt = normalized.externalId
        ? fileExternal.get(normalized.externalId)
        : undefined;
      const earlierFingerprint = normalized.fingerprint
        ? fileFingerprint.get(normalized.fingerprint)
        : undefined;
      if (!issues.some((issue) => issue.severity === "error")) {
        if (
          earlierExt !== undefined &&
          earlierFingerprint !== undefined &&
          earlierExt !== earlierFingerprint
        ) {
          issues.push(
            error(
              "BOOKING_IDENTITY_CONFLICT",
              "External ID and fingerprint match different rows in this file.",
            ),
          );
        } else if (
          earlierExt !== undefined ||
          earlierFingerprint !== undefined
        ) {
          const identityRow = earlierExt ?? earlierFingerprint!;
          duplicate = { kind: "file", rowNumber: identityRow };
          issues.push(
            warning(
              "BOOKING_DUPLICATE_IN_FILE",
              "This booking already appears earlier in the file.",
            ),
          );
          if (normalized.externalId && !fileExternal.has(normalized.externalId))
            fileExternal.set(normalized.externalId, identityRow);
          if (
            normalized.fingerprint &&
            !fileFingerprint.has(normalized.fingerprint)
          )
            fileFingerprint.set(normalized.fingerprint, identityRow);
        } else {
          if (normalized.externalId)
            fileExternal.set(normalized.externalId, row.rowNumber);
          if (normalized.fingerprint)
            fileFingerprint.set(normalized.fingerprint, row.rowNumber);
        }
      }
      const shouldSimulateAvailability =
        !duplicate ||
        (duplicate.record &&
          duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE);
      const availabilityCandidate =
        shouldSimulateAvailability &&
        effective.tag === "open-studio" &&
        !isHistorical(effective) &&
        effective.locationId &&
        effective.start &&
        effective.end
          ? {
              _id: duplicate?.existingRecordId,
              location: effective.locationId,
              start: effective.start,
              end: effective.end,
              status: effective.status,
              paymentStatus: "CONFIRMED",
              tag: effective.tag,
              bookingMode: effective.bookingMode,
              bookingType: effective.bookingMode,
              plannedActivity: effective.plannedActivity,
              numberOfGuests: effective.numberOfGuests,
            }
          : null;
      if (
        availabilityCandidate &&
        !issues.some((issue) => issue.severity === "error")
      ) {
        try {
          validateOpenStudioAvailabilityOrThrow({
            openStudioBookings: [availabilityCandidate],
            currentBookings: [
              ...(currentBookings as any[]).filter(
                (booking) =>
                  String(booking._id) !== String(duplicate?.existingRecordId),
              ),
              ...acceptedFileBookings,
            ],
            locationById,
          });
        } catch (availabilityError) {
          issues.push(
            warning(
              "BOOKING_AVAILABILITY_CONFLICT",
              `The source reservation conflicts with current availability (${String((availabilityError as any)?.code || "capacity")}) and will be preserved.`,
            ),
          );
        }
        acceptedFileBookings.push(availabilityCandidate);
      }

      const invalid = issues.some((issue) => issue.severity === "error");
      summary[invalid ? "invalid" : "valid"] += 1;
      if (issues.some((issue) => issue.severity === "warning"))
        summary.warnings += 1;
      if (duplicate) {
        summary.duplicates += 1;
        if (!invalid)
          summary[
            duplicate.kind === "file" || duplicateStrategy === "skip"
              ? "toSkip"
              : "toUpdate"
          ] += 1;
      } else if (!invalid) summary.toCreate += 1;
      const storedDuplicate = duplicate
        ? {
            kind: duplicate.kind,
            existingRecordId: duplicate.existingRecordId || null,
            rowNumber: duplicate.rowNumber || null,
          }
        : null;
      operations.push({
        updateOne: {
          filter: { _id: row._id, tenant: tenantId, session: current._id },
          update: {
            $set: {
              normalized,
              issues,
              duplicate: storedDuplicate,
              status: invalid
                ? DATA_IMPORT_ROW_STATUS.INVALID
                : DATA_IMPORT_ROW_STATUS.VALID,
              resultRecord: null,
              resultMessage: null,
            },
          },
        },
      });
    }
    if (operations.length)
      await DataImportRowModel.bulkWrite(operations, { ordered: false });
    const validationRevision = createHash("sha256")
      .update(
        JSON.stringify({
          fileHash: session.fileHash,
          mapping,
          duplicateStrategy,
          tenantLanguage,
        }),
      )
      .digest("hex");
    const updated = await DataImportSessionModel.findOneAndUpdate(
      {
        _id: current._id,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.VALIDATED,
          mapping,
          duplicateStrategy,
          validationRevision,
          summary,
        },
      },
      { returnDocument: "after" },
    ).lean();
    if (!updated)
      conflict({
        message: "Import validation state changed unexpectedly.",
        code: "IMPORT_STATE_CONFLICT",
      });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "validated",
      metadata: {
        entityType: DATA_IMPORT_ENTITY.BOOKINGS,
        duplicateStrategy,
        valid: summary.valid,
        invalid: summary.invalid,
        duplicates: summary.duplicates,
      },
    });
    return serializeImportSession(updated);
  } catch (validationError) {
    await DataImportSessionModel.updateOne(
      {
        _id: current._id,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          lastError: {
            code: "IMPORT_VALIDATION_FAILED",
            message: (validationError instanceof Error
              ? validationError.message
              : "Booking import validation failed."
            ).slice(0, 1_000),
          },
        },
      },
    );
    throw validationError;
  }
};
