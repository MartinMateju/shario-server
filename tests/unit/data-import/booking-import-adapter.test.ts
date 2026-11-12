import { describe, expect, it } from "vitest";

import {
  bookingHasCustomerIdentity,
  normalizeBookingImportRow,
  parseExplicitImportTimestamp,
  validateBookingImportRow,
} from "@/modules/data-import/adapters/booking-import.adapter.js";

const issueCodes = (value: ReturnType<typeof normalizeBookingImportRow>) =>
  validateBookingImportRow(value).map((issue) => issue.code);

describe("booking import adapter", () => {
  it("accepts absolute ISO timestamps only when the offset is explicit", () => {
    expect(parseExplicitImportTimestamp("2026-09-15T09:00:00+02:00")).toBe(
      "2026-09-15T07:00:00.000Z",
    );
    expect(parseExplicitImportTimestamp("2026-09-15T07:00:00Z")).toBe(
      "2026-09-15T07:00:00.000Z",
    );
    expect(parseExplicitImportTimestamp("2026-09-15T09:00:00")).toBe("");
  });

  it.each([
    "2026-02-30T09:00:00+01:00",
    "2025-02-29T09:00:00+01:00",
    "2026-13-01T09:00:00+01:00",
  ])("rejects an invalid calendar timestamp %s", (timestamp) => {
    expect(parseExplicitImportTimestamp(timestamp)).toBe("");
  });

  it("normalizes customer references, Czech statuses, language, and activity", () => {
    const booking = normalizeBookingImportRow(
      {
        Email: " ANNA@EXAMPLE.COM ",
        Phone: "+420 777 123 456",
        Service: "Shared studio",
        Start: "2026-09-15T09:00:00+02:00",
        End: "2026-09-15T11:00:00+02:00",
        Status: "Potvrzeno",
        Language: "Čeština",
        Activity: "Točení na kruhu",
      },
      {
        customerEmail: "Email",
        customerPhone: "Phone",
        productName: "Service",
        start: "Start",
        end: "End",
        status: "Status",
        language: "Language",
        plannedActivity: "Activity",
      },
    );

    expect(booking).toMatchObject({
      customerEmail: "anna@example.com",
      customerPhone: "+420777123456",
      productName: "Shared studio",
      start: "2026-09-15T07:00:00.000Z",
      end: "2026-09-15T09:00:00.000Z",
      status: "processed",
      language: "cs",
      plannedActivity: "WORKSTATION",
      numberOfGuests: 1,
    });
    expect(bookingHasCustomerIdentity(booking)).toBe(true);
    expect(validateBookingImportRow(booking)).toEqual([]);
  });

  it("keeps local date/time inputs for timezone-aware validation", () => {
    const booking = normalizeBookingImportRow(
      {
        Service: "Wheel class",
        Date: "2026-10-25",
        From: "02:30",
        To: "03:30",
      },
      {
        productName: "Service",
        date: "Date",
        startTime: "From",
        endTime: "To",
      },
    );

    expect(booking).toMatchObject({
      start: "",
      end: "",
      date: "2026-10-25",
      startTime: "02:30",
      endTime: "03:30",
    });
    expect(issueCodes(booking)).not.toContain("BOOKING_TIME_REQUIRED");
  });

  it("rejects partial local ranges and timestamps without offsets", () => {
    const partial = normalizeBookingImportRow(
      { Service: "Studio", Date: "2026-09-15", From: "09:00" },
      { productName: "Service", date: "Date", startTime: "From" },
    );
    expect(issueCodes(partial)).toContain("BOOKING_LOCAL_TIME_INCOMPLETE");

    const noOffset = normalizeBookingImportRow(
      {
        Service: "Studio",
        Start: "2026-09-15T09:00:00",
        End: "2026-09-15T11:00:00",
      },
      { productName: "Service", start: "Start", end: "End" },
    );
    expect(issueCodes(noOffset)).toEqual(
      expect.arrayContaining(["BOOKING_START_INVALID", "BOOKING_END_INVALID"]),
    );
  });

  it("treats blank optional cells as omitted update fields", () => {
    const booking = normalizeBookingImportRow(
      {
        Service: "Wheel Class",
        Start: "2026-09-15T09:00:00+02:00",
        End: "2026-09-15T11:00:00+02:00",
        Status: " ",
        Guests: "",
        Language: "",
        Activity: "",
        Lecturer: "",
        Description: "",
        Note: "",
      },
      {
        productName: "Service",
        start: "Start",
        end: "End",
        status: "Status",
        numberOfGuests: "Guests",
        language: "Language",
        plannedActivity: "Activity",
        lecturer: "Lecturer",
        description: "Description",
        note: "Note",
      },
    );

    expect(booking.providedFields).toEqual(
      expect.arrayContaining(["productName", "start", "end"]),
    );
    for (const optionalField of [
      "status",
      "numberOfGuests",
      "language",
      "plannedActivity",
      "lecturer",
      "description",
      "note",
    ]) {
      expect(booking.providedFields).not.toContain(optionalField);
    }
  });
});
