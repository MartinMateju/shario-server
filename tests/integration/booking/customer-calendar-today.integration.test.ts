import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { listCustomerBookingAvailability } from "@/modules/booking/booking.public.service.js";
import { LocationModel } from "@/modules/location/location.model.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenantId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const locationId = new mongoose.Types.ObjectId();
const otherLocationId = new mongoose.Types.ObjectId();
const now = new Date("2026-10-19T09:15:00.000Z");
const tenant = { _id: tenantId, settings: { timezone: "UTC" } } as TenantDocument;

const booking = (overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant: tenantId,
  location: locationId,
  start: new Date("2026-10-19T06:00:00.000Z"),
  end: new Date("2026-10-19T08:00:00.000Z"),
  tag: "open-studio",
  status: "processed",
  paymentStatus: "CONFIRMED",
  ...overrides,
});

const list = (input: Partial<Parameters<typeof listCustomerBookingAvailability>[0]> = {}) =>
  listCustomerBookingAvailability({
    tenant,
    locationId: String(locationId),
    now,
    ...input,
  });

describe("customer calendar keeps earlier bookings from today", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);

  beforeEach(async () => {
    await clearTestDatabase();
    await LocationModel.collection.insertMany([
      {
        _id: locationId,
        tenant: tenantId,
        name: "Grohova",
        slug: "grohova",
        code: "GRO",
        isActive: true,
        booking: { enabled: true, timezone: "Europe/Prague" },
      },
      {
        _id: otherLocationId,
        tenant: tenantId,
        name: "Other studio",
        slug: "other-studio",
        code: "OTHER",
        isActive: true,
        booking: { enabled: true, timezone: "Europe/Prague" },
      },
    ]);
  });

  it("returns paid morning studio/class sessions and private blocks after they end", async () => {
    const morning = ["open-studio", "workshop", "class", "course", "private-studio", "private-session"].map(
      (tag) => booking({ tag, status: tag === "course" ? "delivered" : "completed" }),
    );
    const future = booking({
      start: new Date("2026-10-20T06:00:00.000Z"),
      end: new Date("2026-10-20T08:00:00.000Z"),
    });
    const yesterday = booking({
      start: new Date("2026-10-18T18:00:00.000Z"),
      end: new Date("2026-10-18T20:00:00.000Z"),
    });
    await Booking.collection.insertMany([...morning, future, yesterday]);

    const result = await list();
    expect(result.bookings.map((row) => row.id).sort()).toEqual(
      [...morning, future].map((row) => String(row._id)).sort(),
    );
    expect(result.bookings.filter((row) => row.tag.startsWith("private-"))).toHaveLength(2);
  });

  it("does not revive expired payment holds or cancelled bookings from today", async () => {
    const visible = booking({
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: new Date("2026-10-19T09:30:00.000Z"),
    });
    await Booking.collection.insertMany([
      visible,
      ...["open-studio", "class", "private-studio"].map((tag) => booking({
        tag,
        paymentStatus: "PENDING_PAYMENT",
        // After midnight but before the real current time: still expired.
        paymentExpiresAt: new Date("2026-10-19T09:00:00.000Z"),
      })),
      booking({ status: "cancelled" }),
      booking({ status: "canceled" }),
      booking({ paymentStatus: "FAILED" }),
    ]);

    expect((await list()).bookings.map((row) => row.id)).toEqual([String(visible._id)]);
  });

  it("uses the selected studio timezone at the exact local midnight boundary", async () => {
    const beforeMidnight = booking({
      start: new Date("2026-10-18T20:00:00.000Z"),
      end: new Date("2026-10-18T22:00:00.000Z"),
    });
    const today = booking({
      start: new Date("2026-10-18T22:00:00.000Z"),
      end: new Date("2026-10-18T22:15:00.000Z"),
      tag: "course",
    });
    await Booking.collection.insertMany([beforeMidnight, today]);
    const result = await list({ now: new Date("2026-10-18T22:30:00.000Z") });
    expect(result.bookings.map((row) => row.id)).toEqual([String(today._id)]);
  });

  it("keeps the whole daylight-saving transition day, including already-ended classes", async () => {
    const firstHour = booking({
      start: new Date("2026-10-24T22:00:00.000Z"),
      end: new Date("2026-10-24T23:00:00.000Z"),
      tag: "class",
    });
    const lastHour = booking({
      start: new Date("2026-10-25T22:00:00.000Z"),
      end: new Date("2026-10-25T23:00:00.000Z"),
    });
    await Booking.collection.insertMany([firstHour, lastHour]);
    expect((await list({ now: new Date("2026-10-25T22:30:00.000Z") })).bookings.map((row) => row.id)).toEqual([
      String(firstHour._id),
      String(lastHour._id),
    ]);
  });

  it("uses the tenant timezone when no studio location is selected", async () => {
    const earlierInTenantDay = booking({
      start: new Date("2026-10-18T06:00:00.000Z"),
      end: new Date("2026-10-18T08:00:00.000Z"),
    });
    await Booking.collection.insertOne(earlierInTenantDay);
    const localMidnight = new Date("2026-10-18T22:30:00.000Z");
    expect((await list({ now: localMidnight })).bookings).toEqual([]);
    expect((await list({ now: localMidnight, locationId: undefined })).bookings.map((row) => row.id)).toEqual([
      String(earlierInTenantDay._id),
    ]);
  });

  it("preserves tenant, selected location and bookable location isolation", async () => {
    const allowed = booking();
    await Booking.collection.insertMany([
      allowed,
      booking({ tenant: otherTenantId }),
      booking({ location: otherLocationId }),
    ]);
    expect((await list()).bookings.map((row) => row.id)).toEqual([String(allowed._id)]);
    expect((await list({ tenant: { _id: otherTenantId } as TenantDocument })).bookings).toEqual([]);
    await LocationModel.collection.updateOne({ _id: locationId }, { $set: { "booking.enabled": false } });
    expect((await list()).bookings).toEqual([]);
  });

  it("clamps requested history to today and allows an explicit earlier-today range", async () => {
    const morning = booking();
    const yesterday = booking({
      start: new Date("2026-10-18T06:00:00.000Z"),
      end: new Date("2026-10-18T08:00:00.000Z"),
    });
    await Booking.collection.insertMany([morning, yesterday]);
    const result = await list({
      from: new Date("2026-10-18T00:00:00.000Z"),
      to: new Date("2026-10-19T08:30:00.000Z"),
    });
    expect(result.bookings.map((row) => row.id)).toEqual([String(morning._id)]);
    expect((await list({ to: new Date("2026-10-19T08:30:00.000Z") })).bookings.map((row) => row.id)).toEqual([String(morning._id)]);
    await expect(list({ to: new Date("2026-10-18T22:00:00.000Z") })).rejects.toMatchObject({
      code: "CUSTOMER_AVAILABILITY_RANGE_INVALID",
    });
  });
});
