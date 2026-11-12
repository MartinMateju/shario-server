import Booking from "@/modules/booking/booking.model.js";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";
import LocationModel from "@/modules/location/location.model.js";
import ProductModel from "@/modules/product/product.model.js";
import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { notFound } from "@/shared/http/httpErrors.js";

import type { AssistantProviderOutput } from "../ai.validators.js";

export type AssistantWorkspacePageInput = {
  surface: "workspace";
  route: string;
  entity: {
    kind: "booking";
    id: string;
  };
};

export type AssistantBookingPageFacts = {
  generatedAt: string;
  source: "page.booking";
  entity: {
    kind: "booking";
    id: string;
  };
  booking: {
    start: Date;
    end: Date;
    status: string;
    paymentStatus: string;
    tag: string;
    bookingType: string;
    participantCount: number;
    location: {
      id: string;
      name: string;
      timezone: string | null;
    };
    product: {
      id: string;
      name: string;
      type: string;
    };
  };
};

const bookingNotFound = (): never => notFound("Booking not found.");

const validIanaTimezone = (value: unknown): string | null => {
  const timezone = String(value || "").trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    return timezone.slice(0, 100);
  } catch {
    return null;
  }
};

const moduleEnabled = (
  modules: unknown,
  module: (typeof TENANT_MODULE)[keyof typeof TENANT_MODULE],
): boolean => {
  const value =
    modules && typeof (modules as any).toObject === "function"
      ? (modules as any).toObject()
      : modules;
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>)[module] === true,
  );
};

const assertAuthorizedActor = ({
  tenantId,
  userId,
  access,
  modules,
}: {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  modules: unknown;
}) => {
  if (
    access.status !== "active" ||
    access.tenantId !== tenantId ||
    access.userId !== userId ||
    !moduleEnabled(modules, TENANT_MODULE.BOOKINGS) ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.BOOKINGS_VIEW)
  ) {
    bookingNotFound();
  }
};

const locationQuery = ({
  access,
  pinnedLocationId,
}: {
  access: ResolvedWorkspaceAccess;
  pinnedLocationId?: string | null;
}) => {
  if (pinnedLocationId) {
    if (!canAccessWorkspaceLocation(access, pinnedLocationId)) {
      bookingNotFound();
    }
    return pinnedLocationId;
  }
  return access.locationAccess.mode === "all"
    ? { $exists: true }
    : { $in: access.locationAccess.locationIds };
};

/**
 * Resolve a per-turn page reference into a compact server-owned fact block.
 * The client supplies only a canonical identifier. Names, status and other
 * display fields are always re-fetched inside the active tenant and location
 * boundary.
 */
export const resolveAssistantWorkspacePage = async ({
  tenantId,
  userId,
  access,
  modules,
  pinnedLocationId,
  page,
}: {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  modules: unknown;
  pinnedLocationId?: string | null;
  page?: AssistantWorkspacePageInput | null;
}): Promise<AssistantBookingPageFacts | null> => {
  if (!page) return null;
  assertAuthorizedActor({ tenantId, userId, access, modules });

  // Validation binds booking references to /app/bookings. Keep this check here
  // too so direct service callers cannot turn an unrelated route into authority.
  if (
    page.surface !== "workspace" ||
    page.entity.kind !== "booking" ||
    page.route !== "/app/bookings"
  ) {
    bookingNotFound();
  }

  const booking = await Booking.findOne({
    _id: page.entity.id,
    tenant: tenantId,
    location: locationQuery({ access, pinnedLocationId }),
  })
    .select(
      "_id location start end status paymentStatus tag bookingType participants numberOfGuests bookingProduct",
    )
    .lean();
  if (!booking) bookingNotFound();

  const [location, product] = await Promise.all([
    LocationModel.findOne({
      _id: (booking as any).location,
      tenant: tenantId,
    })
      .select("_id name booking.timezone")
      .lean(),
    ProductModel.findOne({
      _id: (booking as any).bookingProduct,
      tenant: tenantId,
    })
      .select("_id name type")
      .lean(),
  ]);
  if (!location || !product) bookingNotFound();

  return {
    generatedAt: new Date().toISOString(),
    source: "page.booking",
    entity: {
      kind: "booking",
      id: String((booking as any)._id),
    },
    booking: {
      start: new Date((booking as any).start),
      end: new Date((booking as any).end),
      status: String((booking as any).status || ""),
      paymentStatus: String((booking as any).paymentStatus || ""),
      tag: String((booking as any).tag || ""),
      bookingType: String((booking as any).bookingType || ""),
      participantCount: Math.max(
        activeBookingParticipants(booking).length,
        Math.max(Number((booking as any).numberOfGuests || 0), 0),
      ),
      location: {
        id: String((location as any)._id),
        name: String((location as any).name || "").trim().slice(0, 160),
        timezone: validIanaTimezone((location as any).booking?.timezone),
      },
      product: {
        id: String((product as any)._id),
        name: String((product as any).name || "").trim().slice(0, 160),
        type: String((product as any).type || "").trim().slice(0, 80),
      },
    },
  };
};

const localizedDateTime = (
  value: Date,
  locale: string,
  timezone: string | null,
): string => {
  if (!timezone) return value.toISOString();
  return new Intl.DateTimeFormat(
    locale.startsWith("cs") ? "cs-CZ" : "en-GB",
    {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    },
  ).format(value);
};

const BOOKING_PAGE_FIELD_FOLLOW_UP_PATTERNS = [
  /^(?:is|was) (?:it|this booking|this reservation) (?:paid|confirmed|cancelled|canceled|processed|pending)$/,
  /^(?:what is|what s|what about) (?:its|this booking s|this reservation s|the current booking s) (?:payment|payment status|booking status|status|start|start time|end|end time|date|time|location|venue|participant count)$/,
  /^when (?:does|did|will) (?:it|this booking|this reservation) (?:start|begin|end|finish)$/,
  /^where (?:is|was|will) (?:it|this booking|this reservation) (?:held|located|taking place)$/,
  /^how many (?:people|participants|guests|attendees) (?:are|will be|were) (?:coming|attending|booked)(?: (?:to|for) (?:it|this booking|this reservation))?$/,
  /^how many (?:people|participants|guests|attendees) (?:does|did) (?:it|this booking|this reservation) have$/,
  /^(?:je|byla) (?:tato rezervace |ta rezervace |ona )?(?:zaplacena|potvrzena|zrusena|stornovana|dokoncena)$/,
  /^(?:jaky je|co je) (?:jeji |teto rezervace |aktualni rezervace )?(?:stav|stav platby|platebni stav)$/,
  /^kdy (?:tato rezervace )?(?:zacina|zacne|konci|skonci)$/,
  /^kde se (?:tato rezervace )?(?:kona|bude konat)$/,
  /^kolik (?:lidi|ucastniku|hostu) (?:prijde|dorazi|se ucastni|je prihlaseno)$/,
] as const;

export const isBookingPageReferenceQuestion = (question: string): boolean => {
  const normalized = question
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return (
    /\b(this|current|selected) (booking|reservation)\b/.test(normalized) ||
    /^(summarize|describe|explain|review|check) (this|it|the current one)$/.test(
      normalized,
    ) ||
    /^(what|when|where|who|how) (is|are|was|were|about) (this|it|the current one)( booking| reservation)?$/.test(
      normalized,
    ) ||
    /\b(tato|aktualni|vybrana) rezervace\b/.test(normalized) ||
    /^(shrn|popis|vysvetli|zkontroluj) (ji|tuto|aktualni rezervaci)$/.test(
      normalized,
    ) ||
    BOOKING_PAGE_FIELD_FOLLOW_UP_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
  );
};

export const getBookingPageFallback = ({
  question,
  locale,
  pageFacts,
}: {
  question: string;
  locale: string;
  pageFacts: AssistantBookingPageFacts | null;
}): AssistantProviderOutput | null => {
  if (!pageFacts) return null;
  if (!isBookingPageReferenceQuestion(question)) return null;

  const booking = pageFacts.booking;
  const start = localizedDateTime(
    booking.start,
    locale,
    booking.location.timezone,
  );
  const end = localizedDateTime(
    booking.end,
    locale,
    booking.location.timezone,
  );
  const people = booking.participantCount;
  const czech = locale.startsWith("cs");
  return {
    answer: czech
      ? `Tato rezervace je na „${booking.product.name}“ v provozovně ${booking.location.name}, od ${start} do ${end}. Stav rezervace je ${booking.status}, stav platby ${booking.paymentStatus} a evidovaný počet účastníků je ${people}.`
      : `This booking is for “${booking.product.name}” at ${booking.location.name}, from ${start} to ${end}. Its booking status is ${booking.status}, payment status is ${booking.paymentStatus}, and the recorded participant count is ${people}.`,
    grounding: {
      basis: "workspace_facts",
      insufficientEvidence: false,
    },
    citations: [],
    actions: [],
    suggestedReplies: [],
    navigation: [],
  };
};
