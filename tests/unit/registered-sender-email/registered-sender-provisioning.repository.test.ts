import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  select: vi.fn(),
  updateOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock(
  "@/modules/registered-sender-email/registered-sender-email.model.js",
  () => ({
    RegisteredSenderEmailModel: {
      updateOne: mocks.updateOne,
      findOneAndUpdate: mocks.findOneAndUpdate,
    },
  }),
);

import { registeredSenderEmailRepository } from "@/modules/registered-sender-email/registered-sender-email.repository.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const SENDER_ID = "507f191e810c19729de860ea";

describe("managed sender provisioning persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateOne.mockReturnValue({ exec: mocks.exec });
    mocks.select.mockReturnValue({ exec: mocks.exec });
    mocks.findOneAndUpdate.mockReturnValue({ select: mocks.select });
    mocks.exec.mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
  });

  it("guards a provisioning failure with the current attempt ID", async () => {
    await registeredSenderEmailRepository.markProvisioningFailure(
      TENANT_ID,
      SENDER_ID,
      "attempt-current",
      {
        message: "private provider detail",
        code: "POSTMARK_1364",
        attemptedAt: new Date("2026-08-10T12:00:00.000Z"),
      },
    );

    const [filter, update] = mocks.updateOne.mock.calls[0];
    expect(String(filter.tenant)).toBe(TENANT_ID);
    expect(String(filter._id)).toBe(SENDER_ID);
    expect(filter).toMatchObject({
      provider: "postmark_managed",
      providerProvisioningStatus: "pending",
      providerProvisioningAttemptId: "attempt-current",
    });
    expect(update.$set).toMatchObject({
      providerProvisioningStatus: "error",
      providerProvisioningAttemptId: "",
      providerProvisioningErrorCode: "POSTMARK_1364",
    });
  });

  it("guards pending Server binding with the current attempt ID", async () => {
    const document = {
      _id: new mongoose.Types.ObjectId(SENDER_ID),
      tenant: new mongoose.Types.ObjectId(TENANT_ID),
    };

    await registeredSenderEmailRepository.bindPostmarkServerPending(
      document as any,
      "attempt-current",
      {
        providerServerId: 42,
        encryptedPostmarkServerToken: "encrypted-token",
      },
    );

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: document._id,
      tenant: document.tenant,
      provider: "postmark_managed",
      providerProvisioningStatus: "pending",
      providerProvisioningAttemptId: "attempt-current",
    });
    expect(update.$set).toMatchObject({
      providerServerId: 42,
      encryptedPostmarkServerToken: "encrypted-token",
      providerProvisionedAt: null,
    });
  });

  it("guards the ready transition with the current attempt ID", async () => {
    const document = {
      _id: new mongoose.Types.ObjectId(SENDER_ID),
      tenant: new mongoose.Types.ObjectId(TENANT_ID),
    };
    const readyAt = new Date("2026-08-10T12:01:00.000Z");

    await registeredSenderEmailRepository.markPostmarkServerReady(
      document as any,
      "attempt-current",
      readyAt,
    );

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: document._id,
      tenant: document.tenant,
      provider: "postmark_managed",
      providerProvisioningStatus: "pending",
      providerProvisioningAttemptId: "attempt-current",
    });
    expect(update.$set).toMatchObject({
      providerProvisioningStatus: "ready",
      providerProvisioningAttemptId: "",
      providerProvisionedAt: readyAt,
    });
  });

  it("uses valid ObjectIds in the compare-and-set filter", async () => {
    await registeredSenderEmailRepository.markProvisioningFailure(
      TENANT_ID,
      SENDER_ID,
      "attempt-current",
      {
        message: "failure",
        code: "MANAGED_EMAIL_PROVISIONING_FAILED",
        attemptedAt: new Date(),
      },
    );

    const [filter] = mocks.updateOne.mock.calls[0];
    expect(filter.tenant).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(filter._id).toBeInstanceOf(mongoose.Types.ObjectId);
  });
});
