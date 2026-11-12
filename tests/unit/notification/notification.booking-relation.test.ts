import { afterEach, describe, expect, it, vi } from "vitest";
import BookingModel from "@/modules/booking/booking.model.js";
import { EmailNotification } from "@/modules/notification/notification.model.js";
import { emailNotificationSchema } from "@/modules/notification/notification.schema.js";
import { notificationRepository } from "@/modules/notification/notification.repository.js";

const tenantId = "507f1f77bcf86cd799439011";
const notificationId = "507f1f77bcf86cd799439012";
afterEach(() => vi.restoreAllMocks());

describe("generic email notification booking relation", () => {
  it("registers a Booking reference without the retired firing relation", () => {
    expect(emailNotificationSchema.path("relatedBooking")?.options.ref).toBe("Booking");
    expect(emailNotificationSchema.path("relatedFiring")).toBeUndefined();
  });

  it("populates only a booking in the notification workspace", async () => {
    const chain = { populate: vi.fn(), lean: vi.fn(), exec: vi.fn().mockResolvedValue(null) };
    chain.populate.mockReturnValue(chain);
    chain.lean.mockReturnValue(chain);
    vi.spyOn(EmailNotification, "findOne").mockReturnValue(chain as never);
    await notificationRepository.findEmailNotificationByIdForTenant(tenantId, notificationId);
    const population = chain.populate.mock.calls[1][0];
    expect(population).toMatchObject({ path: "relatedBooking", model: BookingModel, select: "start end status" });
    expect(String(population.match.tenant)).toBe(tenantId);
  });
});
