import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/modules/reports/reports.service.js", () => ({
  reportService: { overview: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@/modules/dashboard/course-capacity-advisor.service.js", () => ({
  loadCourseCapacityAdvisor: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/modules/dashboard/dashboard.signals.js", () => ({
  loadDashboardSignals: vi.fn().mockResolvedValue(null),
}));

import Booking from "@/modules/booking/booking.model.js";
import Location from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import { buildDashboardOverview } from "@/modules/dashboard/dashboard.service.js";
import { createPlatformBypassAccess } from "@/modules/tenant-access/services/authorization.service.js";

let database: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const tenant = oid(),
  location = oid(),
  otherLocation = oid(),
  otherTenant = oid(),
  product = oid();
const now = new Date("2026-11-12T09:30:00Z");

const createBooking = async (overrides: Record<string, unknown> = {}) => {
  const _id = oid();
  await Booking.collection.insertOne({
    _id,
    tenant,
    location,
    bookingProduct: product,
    tag: "open-studio",
    status: "processed",
    paymentStatus: "CONFIRMED",
    start: new Date("2026-11-12T09:00:00Z"),
    end: new Date("2026-11-12T11:00:00Z"),
    numberOfGuests: 2,
    participants: [{ firstname: "First" }, { firstname: "Second" }],
    ...overrides,
  } as any);
  return String(_id);
};

const snapshot = () => {
  const userId = String(oid());
  return buildDashboardOverview({
    context: {
      tenantId: String(tenant),
      userId,
      access: {
        ...createPlatformBypassAccess({ tenantId: String(tenant), userId }),
        isPlatformBypass: false,
        role: "owner",
        locationAccess: { mode: "selected", locationIds: [String(location)] },
      },
    },
    query: { date: "2026-11-12", locationId: String(location) },
    now,
  });
};
const flow = (result: Awaited<ReturnType<typeof snapshot>>, key: string) =>
  result.flow.find((row) => row.key === key)?.value;

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
  await Promise.all([
    Booking.init(),
    Location.init(),
    Product.init(),
    Tenant.init(),
  ]);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await Promise.all(
    [Booking, Location, Product, Tenant].map((model) =>
      model.collection.deleteMany({}),
    ),
  );
  await Tenant.collection.insertOne({
    _id: tenant,
    name: "Dashboard audit",
    slug: "dashboard-audit",
    modules: { bookings: true, courses: false, firing: false },
    settings: { timezone: "Europe/Prague", currency: "CZK" },
  });
  await Location.collection.insertMany([
    {
      _id: location,
      tenant,
      name: "Grohova",
      slug: "grohova",
      code: "GROHOVA",
    },
    {
      _id: otherLocation,
      tenant,
      name: "Vaclavska",
      slug: "vaclavska",
      code: "VACLAVSKA",
    },
  ]);
  await Product.collection.insertOne({
    _id: product,
    tenant,
    name: "Rezervace atelieru | Vaclavska",
    type: "STUDIO_TIME",
    location: otherLocation,
  } as any);
});

describe("daily dashboard attendance and location data", () => {
  it("uses booking location, confirmed attendance and Prague calendar boundaries", async () => {
    const current = await createBooking();
    await createBooking({
      start: new Date("2026-11-11T23:00:00Z"),
      end: new Date("2026-11-12T01:00:00Z"),
      numberOfGuests: 1,
      participants: [],
    });
    await createBooking({ location: otherLocation, numberOfGuests: 30 });
    await createBooking({ tenant: otherTenant, numberOfGuests: 40 });
    await createBooking({ status: "cancelled", numberOfGuests: 50 });
    await createBooking({
      paymentStatus: "PENDING_PAYMENT",
      numberOfGuests: 60,
    });
    await createBooking({ tag: "guest-increase", numberOfGuests: 70 });
    await createBooking({
      start: new Date("2026-11-12T23:00:00Z"),
      numberOfGuests: 80,
    });
    const result = await snapshot();
    expect(flow(result, "booked")).toBe(2);
    expect(flow(result, "arriving")).toBe(3);
    expect(flow(result, "inStudio")).toBe(2);
    expect(result.today.schedule).toHaveLength(2);
    expect(result.today.nextBooking).toBeNull();
    expect(
      result.today.schedule!.find((row) => row.id === current),
    ).toMatchObject({
      title: "Rezervace atelieru | Vaclavska",
      locationId: String(location),
      locationName: "Grohova",
      participantCount: 2,
    });
  });

  it("does not invent a visitor after the last attendee is removed from an open-studio booking", async () => {
    await createBooking({
      attendanceManaged: true,
      numberOfGuests: 0,
      participants: [{ firstname: "Removed", attendanceStatus: "removed" }],
    });
    const result = await snapshot();
    expect(flow(result, "arriving")).toBe(0);
    expect(flow(result, "inStudio")).toBe(0);
    expect(result.today.schedule![0]!.participantCount).toBe(0);
  });

  it("finds the next upcoming booking beyond twelve past rows without selecting an ongoing or foreign booking", async () => {
    for (let minute = 0; minute < 12; minute += 1) {
      await createBooking({
        start: new Date(Date.UTC(2026, 10, 12, 0, minute)),
        end: new Date(Date.UTC(2026, 10, 12, 1, minute)),
      });
    }
    await createBooking(); // Ongoing at now, not the next start.
    await createBooking({
      location: otherLocation,
      start: new Date("2026-11-12T09:45:00Z"),
    });
    await createBooking({
      status: "cancelled",
      start: new Date("2026-11-12T09:50:00Z"),
    });
    await createBooking({
      paymentStatus: "PENDING_PAYMENT",
      start: new Date("2026-11-12T09:55:00Z"),
    });
    const upcoming = await createBooking({
      start: new Date("2026-11-12T10:30:00Z"),
    });
    const result = await snapshot();
    expect(result.today.schedule).toHaveLength(12);
    expect(result.today.schedule!.some((row) => row.id === upcoming)).toBe(
      false,
    );
    expect(result.today.nextBooking).toMatchObject({
      id: upcoming,
      start: "2026-11-12T10:30:00.000Z",
      locationId: String(location),
    });
  });
});
