import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const mocks = vi.hoisted(() => ({
  deliveryFindById: vi.fn(),
  deliveryFindOne: vi.fn(),
  deliveryFindOneAndUpdate: vi.fn(),
  deliveryUpdateMany: vi.fn(),
  deliveryFind: vi.fn(),
  messageFindById: vi.fn(),
  messageFindOne: vi.fn(),
  conversationFindById: vi.fn(),
  conversationFindOne: vi.fn(),
  settingsFindOne: vi.fn(),
  consentFindOne: vi.fn(),
  suppressionExists: vi.fn(),
  sendProvider: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationDeliveryModel: {
    findById: mocks.deliveryFindById,
    findOne: mocks.deliveryFindOne,
    findOneAndUpdate: mocks.deliveryFindOneAndUpdate,
    updateMany: mocks.deliveryUpdateMany,
    find: mocks.deliveryFind,
  },
  CommunicationMessageModel: {
    findById: mocks.messageFindById,
    findOne: mocks.messageFindOne,
  },
  CommunicationConversationModel: {
    findById: mocks.conversationFindById,
    findOne: mocks.conversationFindOne,
  },
  CommunicationSettingsModel: {
    findOne: mocks.settingsFindOne,
  },
  CommunicationConsentModel: {
    findOne: mocks.consentFindOne,
  },
  CommunicationSuppressionModel: {
    exists: mocks.suppressionExists,
  },
}));

vi.mock("@/modules/communications/services/provider.service.js", () => ({
  sendThroughCommunicationProvider: mocks.sendProvider,
}));

vi.mock("@/modules/communications/services/audit.service.js", () => ({
  recordCommunicationAudit: mocks.recordAudit,
}));

import {
  fallbackCommunicationDelivery,
  processCommunicationDelivery,
  recoverStaleCommunicationDeliveries,
  retryCommunicationDelivery,
} from "@/modules/communications/services/delivery-processing.service.js";
import { getDeliveryRetryDecision } from "@/modules/communications/services/delivery.service.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

const leanQuery = <T>(value: T) => ({
  lean: vi.fn().mockResolvedValue(value),
});

const selectedLeanQuery = <T>(value: T) => ({
  select: vi.fn(() => leanQuery(value)),
});

const staleDeliveryQuery = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["sort", "limit", "select"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
};

const buildDelivery = (overrides: Record<string, unknown> = {}) => {
  const delivery: Record<string, any> = {
    _id: "delivery-1",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    channel: "email",
    purpose: "support",
    idempotencyKey: "comm_delivery_1",
    status: "queued",
    attempts: 0,
    maxAttempts: 4,
    nextAttemptAt: NOW,
    failure: { code: "", message: "", permanent: false },
    eventHistory: [],
    ...overrides,
  };
  delivery.save = vi.fn(async () => delivery);
  return delivery;
};

const message = {
  _id: "message-1",
  direction: "outgoing",
  recipients: [{ name: "Anna", email: "anna@example.com" }],
  subject: "Your pieces are ready",
  text: "You can collect your bowls tomorrow.",
  html: "",
  attachments: [],
};

const conversation = {
  _id: "conversation-1",
  tenantId: "tenant-1",
  customerId: "customer-1",
  contact: { email: "anna@example.com" },
  priority: "normal",
};

const settings = {
  quietHours: { enabled: false, start: "21:00", end: "08:00" },
  businessHours: { timezone: "UTC" },
  delivery: {
    maxAttempts: 4,
    retryBaseSeconds: 60,
    fallbackOrder: ["whatsapp", "email", "in_app"],
  },
  inbox: {
    senderName: "Studio Grohova",
    senderEmail: "studio@example.com",
    replyToEmail: "reply@example.com",
  },
  channels: { whatsapp: { phoneNumberId: "phone-number-1" } },
};

describe("communications delivery processing and automation safeguards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.messageFindById.mockReturnValue(leanQuery(message));
    mocks.conversationFindById.mockReturnValue(leanQuery(conversation));
    mocks.messageFindOne.mockImplementation((filter) =>
      filter?._id
        ? leanQuery(message)
        : selectedLeanQuery({ _id: "incoming-1" }),
    );
    mocks.conversationFindOne.mockReturnValue(leanQuery(conversation));
    mocks.settingsFindOne.mockReturnValue(leanQuery(settings));
    mocks.consentFindOne.mockReturnValue(leanQuery(null));
    mocks.suppressionExists.mockResolvedValue(null);
    mocks.sendProvider.mockResolvedValue({
      provider: "local",
      providerMessageId: "provider-message-1",
      status: "sent",
    });
    mocks.recordAudit.mockResolvedValue(undefined);
    mocks.deliveryUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: async (callback: () => Promise<unknown>) => callback(),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it.each(["sent", "ambiguous"])(
    "never retries the terminal %s status through the shared retry policy",
    (status) => {
      expect(
        getDeliveryRetryDecision({
          status,
          attempts: 1,
          maxAttempts: 4,
          now: NOW,
        }),
      ).toEqual({
        retry: false,
        nextAttemptAt: null,
        reason: "terminal_status",
      });
    },
  );

  it("does not redeliver a terminal or already-sent delivery", async () => {
    const delivery = buildDelivery({ status: "sent" });
    mocks.deliveryFindById.mockResolvedValue(delivery);

    await expect(processCommunicationDelivery(delivery._id)).resolves.toBe(
      delivery,
    );
    expect(mocks.messageFindOne).not.toHaveBeenCalled();
    expect(mocks.sendProvider).not.toHaveBeenCalled();
  });

  it("does not deliver before the scheduled retry time", async () => {
    const delivery = buildDelivery({
      status: "failed",
      nextAttemptAt: new Date("2026-07-22T12:05:00.000Z"),
    });
    mocks.deliveryFindById.mockResolvedValue(delivery);

    await expect(processCommunicationDelivery(delivery._id)).resolves.toBe(
      delivery,
    );
    expect(mocks.sendProvider).not.toHaveBeenCalled();
  });

  it("cancels a stale delivery when its message or conversation was deleted", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.messageFindOne.mockReturnValue(leanQuery(null));

    await expect(processCommunicationDelivery(delivery._id)).resolves.toBe(
      delivery,
    );
    expect(delivery.status).toBe("cancelled");
    expect(delivery.failure).toMatchObject({
      code: "SOURCE_MISSING",
      permanent: true,
    });
    expect(delivery.save).toHaveBeenCalledTimes(2);
    expect(mocks.sendProvider).not.toHaveBeenCalled();
  });

  it("rechecks quiet hours immediately before sending", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.settingsFindOne.mockReturnValue(
      leanQuery({
        ...settings,
        quietHours: {
          enabled: true,
          start: "11:00",
          end: "13:00",
          allowUrgent: true,
        },
      }),
    );

    await processCommunicationDelivery(delivery._id);

    expect(delivery.status).toBe("queued");
    expect(delivery.nextAttemptAt).toEqual(
      new Date("2026-07-22T13:00:00.000Z"),
    );
    expect(mocks.sendProvider).not.toHaveBeenCalled();
  });

  it("allows an explicitly urgent message through configured quiet hours", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.conversationFindOne.mockReturnValue(
      leanQuery({ ...conversation, priority: "urgent" }),
    );
    mocks.settingsFindOne.mockReturnValue(
      leanQuery({
        ...settings,
        quietHours: {
          enabled: true,
          start: "11:00",
          end: "13:00",
          allowUrgent: true,
        },
      }),
    );

    await processCommunicationDelivery(delivery._id);

    expect(mocks.sendProvider).toHaveBeenCalledTimes(1);
    expect(delivery.status).toBe("sent");
  });

  it("rechecks suppression and consent immediately before provider delivery", async () => {
    const suppressed = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(suppressed);
    mocks.suppressionExists.mockResolvedValue({ _id: "suppression-1" });

    await processCommunicationDelivery(suppressed._id);

    expect(suppressed.status).toBe("rejected");
    expect(suppressed.failure).toMatchObject({
      code: "CONSENT_OR_SUPPRESSION",
      message: "recipient_suppressed",
      permanent: true,
    });
    expect(mocks.sendProvider).not.toHaveBeenCalled();

    const revoked = buildDelivery({ _id: "delivery-2" });
    mocks.deliveryFindById.mockResolvedValue(revoked);
    mocks.suppressionExists.mockResolvedValue(null);
    mocks.consentFindOne.mockReturnValue(
      leanQuery({ status: "revoked", expiresAt: null }),
    );

    await processCommunicationDelivery(revoked._id);

    expect(revoked.status).toBe("rejected");
    expect(revoked.failure.message).toBe("consent_revoked");
    expect(mocks.sendProvider).not.toHaveBeenCalled();
  });

  it("allows a support reply after a customer-initiated inbound email", async () => {
    const delivery = buildDelivery({ channel: "email", purpose: "support" });
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.consentFindOne.mockReturnValue(leanQuery(null));
    mocks.messageFindOne.mockImplementation((filter) => {
      if (filter?._id) return leanQuery(message);
      return selectedLeanQuery(
        filter?.channel === "email" ? { _id: "incoming-email-1" } : null,
      );
    });

    await processCommunicationDelivery(delivery._id);

    expect(mocks.sendProvider).toHaveBeenCalledTimes(1);
    expect(delivery.status).toBe("sent");
  });

  it.each(["whatsapp", "instagram"])(
    "rejects the retired %s channel before provider contact",
    async (channel) => {
      const delivery = buildDelivery({ channel, purpose: "support" });
      mocks.deliveryFindById.mockResolvedValue(delivery);

      await processCommunicationDelivery(delivery._id, { force: true });

      expect(delivery.status).toBe("rejected");
      expect(delivery.failure).toMatchObject({
        code: "CHANNEL_RETIRED",
        permanent: true,
      });
      expect(mocks.sendProvider).not.toHaveBeenCalled();
    },
  );

  it("records one durable attempt and provider result on success", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);

    await processCommunicationDelivery(delivery._id);

    expect(delivery.attempts).toBe(1);
    expect(delivery.lastAttemptAt).toEqual(NOW);
    expect(delivery.status).toBe("sent");
    expect(delivery.providerMessageId).toBe("provider-message-1");
    expect(delivery.nextAttemptAt).toBeNull();
    expect(delivery.eventHistory).toHaveLength(1);
    expect(delivery.save).toHaveBeenCalledTimes(3);
    expect(mocks.sendProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        channel: "email",
        idempotencyKey: "comm_delivery_1",
        deliveryId: "delivery-1",
        messageId: "message-1",
      }),
    );
  });

  it("does not send twice when the same worker job is delivered again after success", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);

    await processCommunicationDelivery(delivery._id);
    await processCommunicationDelivery(delivery._id);

    expect(delivery.status).toBe("sent");
    expect(delivery.attempts).toBe(1);
    expect(mocks.sendProvider).toHaveBeenCalledTimes(1);
  });

  it("backs off transient provider failures and records a redacted audit event", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.sendProvider.mockRejectedValue(
      Object.assign(new Error("Provider temporarily unavailable"), {
        code: "HTTP_503",
        permanent: false,
        safeToRetry: true,
      }),
    );

    await processCommunicationDelivery(delivery._id);

    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextAttemptAt).toEqual(
      new Date("2026-07-22T12:01:00.000Z"),
    );
    expect(delivery.failure).toMatchObject({
      code: "HTTP_503",
      permanent: false,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "delivery_failed",
        metadata: {
          code: "HTTP_503",
          retry: true,
          manualReview: false,
        },
      }),
    );
  });

  it("never schedules automatic retries for permanent provider failures", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.sendProvider.mockRejectedValue(
      Object.assign(new Error("Invalid recipient"), {
        code: "INVALID_RECIPIENT",
        permanent: true,
        deliveryOutcome: "not_sent",
      }),
    );

    await processCommunicationDelivery(delivery._id);

    expect(delivery.status).toBe("failed");
    expect(delivery.nextAttemptAt).toBeNull();
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          code: "INVALID_RECIPIENT",
          retry: false,
          manualReview: false,
        },
      }),
    );
  });

  it("fails closed to manual review when a provider attempt has an unknown outcome", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.sendProvider.mockRejectedValue(
      Object.assign(new Error("Connection closed after submission"), {
        code: "CONNECTION_LOST",
      }),
    );

    await processCommunicationDelivery(delivery._id);

    expect(delivery.status).toBe("ambiguous");
    expect(delivery.nextAttemptAt).toBeNull();
    expect(delivery.manualReviewRequiredAt).toEqual(NOW);
    expect(delivery.failure).toMatchObject({
      code: "PROVIDER_OUTCOME_UNKNOWN",
      permanent: true,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          retry: false,
          manualReview: true,
        }),
      }),
    );
  });

  it("does not call the provider when another worker owns the delivery claim", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.deliveryFindOneAndUpdate.mockResolvedValueOnce(null);
    mocks.deliveryFindOne.mockResolvedValue(delivery);

    await expect(processCommunicationDelivery(delivery._id)).resolves.toBe(
      delivery,
    );
    expect(mocks.sendProvider).not.toHaveBeenCalled();
    expect(delivery.save).not.toHaveBeenCalled();
  });

  it("does not start the provider when validation outlives the claim lease", async () => {
    const delivery = buildDelivery();
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.deliveryFindOneAndUpdate
      .mockImplementationOnce(() => {
        vi.setSystemTime(new Date(NOW.getTime() + 6 * 60_000));
        return Promise.resolve(undefined);
      })
      .mockResolvedValueOnce(null);
    mocks.deliveryFindOne.mockResolvedValue(delivery);

    await processCommunicationDelivery(delivery._id);

    const [providerFilter] = mocks.deliveryFindOneAndUpdate.mock.calls[1];
    expect(providerFilter.leaseExpiresAt).toEqual({
      $gt: new Date(NOW.getTime() + 6 * 60_000),
    });
    expect(mocks.sendProvider).not.toHaveBeenCalled();
  });

  it("requeues only stale pre-provider claims and marks post-provider claims ambiguous", async () => {
    const expired = new Date(NOW.getTime() - 1);
    mocks.deliveryFind.mockReturnValue(
      staleDeliveryQuery([
        {
          _id: "safe-before-provider",
          claimToken: "claim-safe",
          leaseExpiresAt: expired,
          providerAttemptStartedAt: null,
          lastAttemptAt: expired,
        },
        {
          _id: "unknown-after-provider",
          claimToken: "claim-unknown",
          leaseExpiresAt: expired,
          providerAttemptStartedAt: expired,
          lastAttemptAt: expired,
        },
      ]),
    );
    mocks.deliveryUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 1 });

    await expect(
      recoverStaleCommunicationDeliveries({ now: NOW }),
    ).resolves.toEqual({ requeued: 1, ambiguous: 1 });

    const [safeFilter, safeUpdate] = mocks.deliveryUpdateMany.mock.calls[0];
    expect(safeFilter).toMatchObject({
      _id: { $in: ["safe-before-provider"] },
      status: "sending",
      providerAttemptStartedAt: null,
    });
    expect(safeUpdate.$set.status).toBe("queued");
    const [unknownFilter, unknownUpdate] =
      mocks.deliveryUpdateMany.mock.calls[1];
    expect(unknownFilter._id).toEqual({ $in: ["unknown-after-provider"] });
    expect(unknownUpdate.$set).toMatchObject({
      status: "ambiguous",
      manualReviewRequiredAt: NOW,
    });
  });

  it("does not recover a delivery while its lease is live", async () => {
    mocks.deliveryFind.mockReturnValue(staleDeliveryQuery([]));

    await expect(
      recoverStaleCommunicationDeliveries({ now: NOW }),
    ).resolves.toEqual({ requeued: 0, ambiguous: 0 });
    expect(mocks.deliveryUpdateMany).not.toHaveBeenCalled();
  });

  it("tenant-scopes manual retry lookup", async () => {
    mocks.deliveryFindOne.mockResolvedValue(null);

    await expect(
      retryCommunicationDelivery("tenant-1", "delivery-other-tenant"),
    ).resolves.toBeNull();
    expect(mocks.deliveryFindOne).toHaveBeenCalledWith({
      _id: "delivery-other-tenant",
      tenantId: "tenant-1",
    });
  });

  it("atomically retries an existing failed delivery", async () => {
    const delivery = buildDelivery({
      status: "failed",
      attempts: 1,
      nextAttemptAt: NOW,
      failure: { code: "HTTP_503", message: "Try again", permanent: false },
    });
    const leanValue = { ...delivery, save: undefined };
    const query = {
      lean: vi.fn().mockResolvedValue(leanValue),
      then: (
        resolve: (value: typeof delivery) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(delivery).then(resolve, reject),
    };
    mocks.deliveryFindOne.mockReturnValue(query);
    mocks.deliveryFindById.mockResolvedValue(delivery);
    mocks.deliveryFindOneAndUpdate.mockImplementationOnce((_filter, update) => {
      Object.assign(delivery, update.$set);
      return Promise.resolve(delivery);
    });

    const result = await retryCommunicationDelivery(
      "tenant-1",
      String(delivery._id),
    );

    expect(query.lean).not.toHaveBeenCalled();
    expect(result?.delivery.status).toBe("sent");
  });

  it("atomically reserves the failed source and creates one tenant-scoped fallback", async () => {
    const original = buildDelivery({
      _id: "delivery-whatsapp",
      channel: "whatsapp",
      status: "failed",
      attempts: 2,
      nextAttemptAt: null,
    });
    const fallback = buildDelivery({
      _id: "delivery-email-fallback",
      channel: "email",
      status: "queued",
      idempotencyKey: "fallback-key",
      fallbackFromDeliveryId: original._id,
    });
    mocks.deliveryFindOne.mockReturnValue(leanQuery(original));
    mocks.conversationFindOne.mockReturnValue(leanQuery(conversation));
    mocks.messageFindOne.mockImplementation((filter) =>
      filter?._id
        ? leanQuery(message)
        : selectedLeanQuery({ _id: "incoming-1" }),
    );
    mocks.deliveryFindOneAndUpdate.mockImplementation((_filter, update) => {
      if (update?.$setOnInsert) return Promise.resolve(fallback);
      if (update?.$set?.status === "cancelled")
        return Promise.resolve(original);
      if (update?.$set?.status === "sending") {
        Object.assign(fallback, update.$set);
        fallback.attempts += 1;
      } else if (update?.$set?.providerAttemptStartedAt) {
        Object.assign(fallback, update.$set);
      } else if (update?.$set?.providerMessageId) {
        Object.assign(fallback, update.$set);
        fallback.eventHistory.push(update.$push.eventHistory);
      }
      return Promise.resolve(fallback);
    });
    mocks.deliveryFindById.mockResolvedValue(fallback);

    await fallbackCommunicationDelivery({
      tenantId: "tenant-1",
      deliveryId: original._id,
      requestedChannel: "email",
    });
    const fallbackUpserts = mocks.deliveryFindOneAndUpdate.mock.calls.filter(
      ([filter, update]) => filter?.idempotencyKey && update?.$setOnInsert,
    );
    expect(fallbackUpserts).toHaveLength(1);
    const [firstFilter, firstUpdate, firstOptions] = fallbackUpserts[0];
    expect(firstFilter).toMatchObject({
      tenantId: "tenant-1",
      idempotencyKey: expect.stringMatching(/^comm_[a-f0-9]{64}$/),
    });
    expect(firstUpdate).toMatchObject({
      $setOnInsert: {
        tenantId: "tenant-1",
        channel: "email",
        fallbackFromDeliveryId: original._id,
      },
    });
    expect(firstOptions).toEqual({
      session: expect.anything(),
      upsert: true,
      returnDocument: "after",
    });
    expect(mocks.sendProvider).toHaveBeenCalledTimes(1);
  });
});
