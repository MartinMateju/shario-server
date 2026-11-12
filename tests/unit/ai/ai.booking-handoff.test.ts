import { describe, expect, it } from "vitest";

import type { AiCommandContext } from "@/modules/ai/ai-action.types.js";
import { assistantProviderOutputSchema } from "@/modules/ai/ai.validators.js";
import {
  resolveDeterministicBookingHandoff,
} from "@/modules/ai/services/assistant-booking-handoff.service.js";

const PRODUCT_ID = "507f1f77bcf86cd799439101";
const LOCATION_ID = "507f1f77bcf86cd799439102";

const commandContext = (
  overrides: Partial<AiCommandContext> = {},
): AiCommandContext => ({
  generatedAt: "2026-08-13T08:00:00.000Z",
  capabilities: [],
  assistantCapabilities: {
    readableDomains: ["bookings", "products"],
    preparableActions: [],
    bookingComposer: {
      enabled: true,
      prefillEnabled: true,
      directMutation: false,
    },
  },
  locations: [
    {
      id: LOCATION_ID,
      name: "Main Studio",
      booking: {
        enabled: true,
        timezone: "Europe/Prague",
        slotStepMinutes: 30,
        minBookingMinutes: 60,
        maxBookingMinutes: 360,
      },
      openingHours: Object.fromEntries(
        [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ].map((day) => [
          day,
          { isOpen: true, openTime: "08:00", closeTime: "20:00" },
        ]),
      ),
    },
  ],
  bookingProducts: [
    {
      id: PRODUCT_ID,
      name: "Wheel Session",
      kind: "class",
    },
    {
      id: "507f1f77bcf86cd799439103",
      name: "Internal Studio Block",
      kind: "private-studio",
    },
  ],
  openTasks: [],
  lowStockItems: [],
  ...overrides,
});

describe("assistant booking composer handoff", () => {
  it("opens only an unprefilled form for a generic authorized request", () => {
    const result = resolveDeterministicBookingHandoff({
      message: "Create a booking",
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(result?.response.answer).toContain("haven’t created or prefilled");
    expect(result?.navigation).toEqual([
      {
        kind: "booking_composer",
        label: "Open unprefilled New booking form",
        href: "/app/bookings/new?returnTo=%2Fapp%2Fai",
      },
    ]);
  });

  it.each([
    [
      "en",
      "Open unprefilled New booking form",
      "Review prefilled booking",
    ],
    [
      "cs",
      "Otevřít prázdný formulář Nová rezervace",
      "Zkontrolovat předvyplněnou rezervaci",
    ],
    [
      "de",
      "Leeres Formular „Neue Buchung“ öffnen",
      "Vorausgefüllte Buchung prüfen",
    ],
    [
      "pl",
      "Otwórz pusty formularz nowej rezerwacji",
      "Sprawdź wstępnie wypełnioną rezerwację",
    ],
    [
      "sk",
      "Otvoriť prázdny formulár novej rezervácie",
      "Skontrolovať predvyplnenú rezerváciu",
    ],
    [
      "da",
      "Åbn tom formular til ny booking",
      "Gennemgå forudfyldt booking",
    ],
  ] as const)(
    "returns native server-owned booking CTAs for %s",
    (locale, unprefilledLabel, prefilledLabel) => {
      const unprefilled = resolveDeterministicBookingHandoff({
        message: "Create a booking",
        locale,
        commandContext: commandContext(),
        now: new Date("2026-08-13T08:00:00.000Z"),
      });
      const prefilled = resolveDeterministicBookingHandoff({
        message:
          'Create a booking for "Wheel Session" at Main Studio tomorrow at 9am for 1 hour',
        locale,
        commandContext: commandContext(),
        now: new Date("2026-08-13T08:00:00.000Z"),
      });

      expect(unprefilled?.navigation[0]?.label).toBe(unprefilledLabel);
      expect(prefilled?.navigation[0]?.label).toBe(prefilledLabel);
    },
  );

  it("builds all-four canonical prefill fields from exact authorized resources and a valid wall time", () => {
    const result = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Main Studio tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(result?.response.answer).toContain("I prepared the New booking form");
    expect(result?.response.answer).toContain("I haven’t created a booking");
    expect(result?.navigation).toHaveLength(1);
    const navigation = result!.navigation[0]!;
    expect(navigation.kind).toBe("booking_composer");
    const url = new URL(navigation.href, "https://studio.test");
    expect(url.pathname).toBe("/app/bookings/new");
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      productId: PRODUCT_ID,
      locationId: LOCATION_ID,
      start: "2026-08-14T07:00:00.000Z",
      end: "2026-08-14T08:00:00.000Z",
      returnTo: "/app/ai",
    });
  });

  it("never treats quoted free text as an arbitrary title", () => {
    const result = resolveDeterministicBookingHandoff({
      message:
        'Create a private booking "Zavrena dilna" at Main Studio tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(result?.response.answer).toContain(
      "does not match exactly one active booking product",
    );
    expect(result?.response.answer).toContain(
      "cannot carry a custom title or note",
    );
    expect(result?.navigation).toEqual([]);
  });

  it("asks about ambiguous private-booking semantics instead of selecting an internal product", () => {
    const result = resolveDeterministicBookingHandoff({
      message:
        "Create a private booking at Main Studio tomorrow at 9am for 1 hour",
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(result?.response.answer).toContain(
      "can mean a customer reservation or an internal studio block",
    );
    expect(result?.navigation).toEqual([]);
  });

  it("never infers the sole accessible location for detailed prefills", () => {
    const unknown = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Secret Studio tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });
    expect(unknown?.navigation).toEqual([]);
    expect(unknown?.response.answer).toContain(
      "exactly one accessible booking-enabled location",
    );
    expect(unknown?.response.answer).toContain("won’t guess");
    expect(unknown?.response.answer).toContain("haven’t created");
    expect(unknown?.response.answer).not.toContain("I prepared");

    const omitted = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });
    expect(omitted?.navigation).toEqual([]);
    expect(omitted?.response.answer).toContain(
      "exactly one accessible booking-enabled location",
    );
    expect(omitted?.response.answer).toContain("won’t guess");
    expect(omitted?.response.answer).toContain("haven’t created");
    expect(omitted?.response.answer).not.toContain("Main Studio");
  });

  it("requires one explicit positive location clause outside quoted product text", () => {
    const context = commandContext();
    const quotedProductId = "507f1f77bcf86cd799439104";
    context.bookingProducts!.push({
      id: quotedProductId,
      name: "Main Studio Wheel Session",
      kind: "class",
    });

    const quotedProductAtHiddenLocation =
      resolveDeterministicBookingHandoff({
        message:
          'Create a booking for "Main Studio Wheel Session" at Secret Studio tomorrow at 9am for 1 hour',
        locale: "en",
        commandContext: context,
        now: new Date("2026-08-13T08:00:00.000Z"),
      });
    expect(quotedProductAtHiddenLocation?.navigation).toEqual([]);
    expect(quotedProductAtHiddenLocation?.response.answer).not.toContain(
      "I prepared",
    );

    const contradictory = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Secret Studio, not Main Studio tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: context,
      now: new Date("2026-08-13T08:00:00.000Z"),
    });
    expect(contradictory?.navigation).toEqual([]);

    const exact = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Main Studio Wheel Session" at Main Studio tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: context,
      now: new Date("2026-08-13T08:00:00.000Z"),
    });
    expect(exact?.navigation).toHaveLength(1);
    const exactUrl = new URL(
      exact!.navigation[0]!.href,
      "https://studio.test",
    );
    expect(exactUrl.searchParams.get("productId")).toBe(quotedProductId);
    expect(exactUrl.searchParams.get("locationId")).toBe(LOCATION_ID);
  });

  it("emits no handoff when booking creation is unauthorized or disabled", () => {
    const context = commandContext();
    context.assistantCapabilities.bookingComposer.enabled = false;
    context.assistantCapabilities.bookingComposer.prefillEnabled = false;

    const result = resolveDeterministicBookingHandoff({
      message: "Create a booking",
      locale: "en",
      commandContext: context,
    });

    expect(result?.response.answer).toContain(
      "can’t open the New booking form",
    );
    expect(result?.navigation).toEqual([]);
  });

  it("fails closed for misaligned, closed, past, and DST-shifted requests", () => {
    const misaligned = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Main Studio tomorrow at 9:15am for 1 hour',
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });
    expect(misaligned?.navigation).toEqual([]);
    expect(misaligned?.response.answer).toContain("do not align");

    const closedContext = commandContext();
    closedContext.locations[0]!.openingHours.friday = {
      isOpen: false,
      openTime: "08:00",
      closeTime: "20:00",
    };
    const closed = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Main Studio tomorrow at 9am for 1 hour',
      locale: "en",
      commandContext: closedContext,
      now: new Date("2026-08-13T08:00:00.000Z"),
    });
    expect(closed?.navigation).toEqual([]);
    expect(closed?.response.answer).toContain("outside");

    const past = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Main Studio today at 9am for 1 hour',
      locale: "en",
      commandContext: commandContext(),
      now: new Date("2026-08-13T10:00:00.000Z"),
    });
    expect(past?.navigation).toEqual([]);
    expect(past?.response.answer).toContain("must be in the future");

    const dstContext = commandContext();
    dstContext.locations[0]!.openingHours.sunday = {
      isOpen: true,
      openTime: "00:00",
      closeTime: "24:00",
    };
    const dst = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Main Studio 2026-03-29 from 02:00 to 03:00',
      locale: "en",
      commandContext: dstContext,
      now: new Date("2026-03-20T08:00:00.000Z"),
    });
    expect(dst?.navigation).toEqual([]);
    expect(dst?.response.answer).toContain("daylight-saving");

    const fold = resolveDeterministicBookingHandoff({
      message:
        'Create a booking for "Wheel Session" at Main Studio 2026-10-25 from 02:00 to 03:00',
      locale: "en",
      commandContext: dstContext,
      now: new Date("2026-10-20T08:00:00.000Z"),
    });
    expect(fold?.navigation).toEqual([]);
    expect(fold?.response.answer).toContain("daylight-saving");
  });

  it("keeps booking-composer navigation inexpressible to the provider schema", () => {
    const parsed = assistantProviderOutputSchema.safeParse({
      answer: "Open this raw URL.",
      grounding: {
        basis: "workspace_facts",
        insufficientEvidence: false,
      },
      citations: [],
      actions: [],
      suggestedReplies: [],
      navigation: [
        {
          kind: "booking_composer",
          label: "Open",
          href: "/app/bookings/new?returnTo=%2Fapp%2Fai",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("localizes Czech handoff safety language", () => {
    const result = resolveDeterministicBookingHandoff({
      message:
        'Vytvoř rezervaci pro "Wheel Session" v Main Studio zítra v 9am na 1 hodinu',
      locale: "cs",
      commandContext: commandContext(),
      now: new Date("2026-08-13T08:00:00.000Z"),
    });

    expect(result?.response.answer).toContain("Rezervaci jsem nevytvořil");
    expect(result?.navigation[0]?.kind).toBe("booking_composer");
  });
});
