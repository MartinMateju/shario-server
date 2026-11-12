import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { SETUP_LAUNCH_EVENT } from "@/modules/setup-center/setup-center.constants.js";
import { SetupLaunchEventModel } from "@/modules/setup-center/setup-center.model.js";

const buildEvent = () =>
  new SetupLaunchEventModel({
    tenant: new mongoose.Types.ObjectId(),
    actor: new mongoose.Types.ObjectId(),
    eventId: "123e4567-e89b-42d3-a456-426614174000",
    sessionId: "launch_session_01",
    event: SETUP_LAUNCH_EVENT.STEP_OPENED,
    stepId: "location",
    source: "launch_center",
  });

describe("Setup Center launch event persistence", () => {
  it("persists only registered low-cardinality launch events with expiry", async () => {
    const event = buildEvent();

    await expect(event.validate()).resolves.toBeUndefined();
    expect(event.expiresAt).toBeInstanceOf(Date);
    expect(event.expiresAt.getTime()).toBeGreaterThan(Date.now());

    event.event =
      "contextual_guide_test_customer_journey_confirmation_email_viewed";
    event.stepId = undefined;
    event.source = "contextual_guide";
    await expect(event.validate()).resolves.toBeUndefined();

    event.event = "arbitrary_event";
    await expect(event.validate()).rejects.toMatchObject({
      errors: { event: expect.any(Object) },
    });
  });

  it("deduplicates both requests and per-session step observations", () => {
    const indexes = SetupLaunchEventModel.schema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ tenant: 1, eventId: 1 }, expect.objectContaining({ unique: true })],
        [
          { tenant: 1, sessionId: 1, event: 1, stepId: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]),
    );
  });
});
