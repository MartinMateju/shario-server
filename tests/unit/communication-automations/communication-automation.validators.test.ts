import { describe, expect, it } from "vitest";

import {
  createCommunicationAutomationSchema,
  updateCommunicationAutomationSchema,
} from "@/modules/communication-automations/communication-automation.validators.js";
import { CommunicationAutomation } from "@/modules/communication-automations/communication-automation.model.js";
import {
  buildActivationPatch,
  isCommunicationAutomationLocationScopeValid,
} from "@/modules/communication-automations/communication-automation.utils.js";

const base = {
  name: "Automation",
  senderEmail: "507f191e810c19729de860ea",
  subject: "Hello {{firstName}}",
  htmlContent: "<p>Hello {{firstName}}</p>",
  connectedProductType: "all",
  appliesToAllLocations: true,
};

describe("communication automation payload validation", () => {
  it("preserves stored delivery settings when only the name changes", () => {
    const current = {
      name: "Original",
      isActive: true,
      automationStatus: "active",
      minutesOffset: 60,
      connectedProductType: "booking",
      subject: "Your reservation",
      htmlContent: "<p>Thank you.</p>",
      contentVariants: { en: { subject: "Reserved", body: "Thank you." } },
      recipients: [{ email: "customer@example.com" }],
      appliesToAllLocations: false,
      location: "507f191e810c19729de860eb",
    };
    const patch = updateCommunicationAutomationSchema.parse({
      id: "507f191e810c19729de860ec",
      name: "Renamed",
    });

    expect(patch).toEqual({
      id: "507f191e810c19729de860ec",
      name: "Renamed",
      locationId: undefined,
    });
    expect({ ...current, ...patch }).toMatchObject({ ...current, name: "Renamed" });
  });

  it.each([true, false])(
    "changes activation to %s without replacing content, audience, or schedule",
    (isActive) => {
      expect(
        updateCommunicationAutomationSchema.parse({
          id: "507f191e810c19729de860ec",
          isActive,
        }),
      ).toEqual({
        id: "507f191e810c19729de860ec",
        isActive,
        locationId: undefined,
      });
    },
  );

  it("preserves explicit clearing in a partial update", () => {
    const input = {
      id: "507f191e810c19729de860ec",
      subject: "",
      htmlContent: "",
      body: "",
      contentVariants: {},
      recipients: [],
      templateId: null,
      appliesToAllLocations: true,
      location: null,
    };

    expect(updateCommunicationAutomationSchema.parse(input)).toEqual({
      ...input,
      locationId: undefined,
    });
  });

  it("updates recipients without broadening location scope", () => {
    const patch = updateCommunicationAutomationSchema.parse({
      id: "507f191e810c19729de860ec",
      recipients: [{ email: " CUSTOMER@example.com " }],
    });

    expect(patch.recipients).toEqual([
      {
        user: null,
        email: "customer@example.com",
        customId: "",
        name: "",
        locale: "cs",
      },
    ]);
    expect(patch).not.toHaveProperty("location");
    expect(patch).not.toHaveProperty("appliesToAllLocations");
    expect(patch).not.toHaveProperty("sendToAllRecipients");
  });

  it("normalizes a supplied location alias without changing recipients", () => {
    expect(
      updateCommunicationAutomationSchema.parse({
        id: "507f191e810c19729de860ec",
        appliesToAllLocations: false,
        locationId: "507f191e810c19729de860eb",
      }),
    ).toEqual({
      id: "507f191e810c19729de860ec",
      appliesToAllLocations: false,
      location: "507f191e810c19729de860eb",
      locationId: undefined,
    });
  });

  it("accepts a booking-created trigger for both create and partial update", () => {
    expect(
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "afterBookingCreated",
        connectedProductType: "booking",
        minutesOffset: 0,
      }),
    ).toMatchObject({
      scheduleType: "afterBookingCreated",
      minutesOffset: 0,
      isActive: false,
    });
    expect(
      updateCommunicationAutomationSchema.parse({
        id: "507f191e810c19729de860ec",
        scheduleType: "afterBookingCreated",
      }),
    ).toEqual({
      id: "507f191e810c19729de860ec",
      scheduleType: "afterBookingCreated",
      locationId: undefined,
    });
  });

  it("derives event recipients and preserves the content format", () => {
    const parsed = createCommunicationAutomationSchema.parse({
      ...base,
      scheduleType: "afterRegistration",
      format: "plain",
      body: "Hello {{firstName}}",
      htmlContent: "Hello {{firstName}}",
      recipients: [],
      contentVariants: {
        en: {
          subject: "Hello",
          body: "Plain body",
          htmlContent: "Plain body",
          format: "plain",
        },
      },
    });

    expect(parsed.recipients).toEqual([]);
    expect(parsed.format).toBe("plain");
    expect(parsed.contentVariants.en?.format).toBe("plain");
  });

  it("requires an explicit audience for recurring broadcasts", () => {
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "daily",
        recipients: [],
      }),
    ).toThrow(/Recipients are required/);
  });

  it("persists template-backed automations without duplicate inline content", async () => {
    const parsed = createCommunicationAutomationSchema.parse({
      name: "Template automation",
      senderEmail: "507f191e810c19729de860ea",
      templateId: "507f191e810c19729de860eb",
      scheduleType: "afterRegistration",
      connectedProductType: "all",
      appliesToAllLocations: true,
    });
    const document = new CommunicationAutomation({
      ...parsed,
      tenant: "507f191e810c19729de860ec",
      createdBy: "507f191e810c19729de860ed",
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.subject).toBe("");
    expect(document.htmlContent).toBe("");
  });

  it("rejects unsupported trigger/product combinations and password reset", () => {
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "beforeBooking",
        connectedProductType: "gift-card",
      }),
    ).toThrow(/not supported by booking automations/);
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "afterBisqueFiring",
        connectedProductType: "booking",
      }),
    ).toThrow(/Invalid option/);
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "passwordReset",
      }),
    ).toThrow(/managed by authentication/);
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "afterFinalFiring",
        connectedProductType: "pottery-item",
      }),
    ).toThrow(/Invalid option/);
  });

  it("rejects location-scoped broadcasts and registration automations", () => {
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "afterRegistration",
        appliesToAllLocations: false,
        location: "507f191e810c19729de860eb",
      }),
    ).toThrow(/must apply to all locations/);
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "daily",
        appliesToAllLocations: false,
        location: "507f191e810c19729de860eb",
        sendToAllRecipients: true,
      }),
    ).toThrow(/must apply to all locations/);
    expect(() =>
      updateCommunicationAutomationSchema.parse({
        id: "507f191e810c19729de860ec",
        scheduleType: "oneTimeEmail",
        appliesToAllLocations: false,
        location: "507f191e810c19729de860eb",
      }),
    ).toThrow(/must apply to all locations/);
  });

  it("keeps creates inactive and rejects marketing until unsubscribe is available", () => {
    const parsed = createCommunicationAutomationSchema.parse({
      ...base,
      scheduleType: "afterRegistration",
      isActive: true,
      automationStatus: "active",
    });
    expect(parsed).toMatchObject({
      isActive: false,
      automationStatus: "waiting_to_activate",
    });
    expect(() =>
      createCommunicationAutomationSchema.parse({
        ...base,
        scheduleType: "afterRegistration",
        purpose: "marketing",
      }),
    ).toThrow(/unsubscribe management/);
    expect(() =>
      updateCommunicationAutomationSchema.parse({
        id: "507f191e810c19729de860ec",
        purpose: "marketing",
      }),
    ).toThrow(/unsubscribe management/);
  });

  it("does not reset activation metadata on an idempotent active PATCH", () => {
    expect(buildActivationPatch({ isActive: true } as never, true)).toEqual({});
    expect(buildActivationPatch({ isActive: true } as never, false)).toEqual(
      expect.objectContaining({
        isActive: true,
        automationStatus: "active",
      }),
    );
  });

  it("fails closed when a merged scoped automation has no valid location", () => {
    expect(
      isCommunicationAutomationLocationScopeValid({
        appliesToAllLocations: false,
        location: null,
      }),
    ).toBe(false);
    expect(
      isCommunicationAutomationLocationScopeValid({
        appliesToAllLocations: false,
        location: "507f191e810c19729de860eb",
      }),
    ).toBe(true);
  });
});
