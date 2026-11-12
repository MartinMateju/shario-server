import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFindOne: vi.fn(),
  conversationFind: vi.fn(),
  conversationUpdateMany: vi.fn(),
  messageFind: vi.fn(),
  messageUpdateMany: vi.fn(),
  deliveryUpdateMany: vi.fn(),
  deleteObjectFromR2: vi.fn(),
  recordAudit: vi.fn(),
  enforceEmailLogRetention: vi.fn(),
  listEmailLogTenantIds: vi.fn(),
}));

vi.mock(
  "@/modules/communication-email-logs/communication-email-log-retention.service.js",
  () => ({
    enforceCommunicationEmailLogRetention: mocks.enforceEmailLogRetention,
    listCommunicationEmailLogTenantIds: mocks.listEmailLogTenantIds,
    mergeCommunicationRetentionTenantIds: (...groups: unknown[][]) => [
      ...new Set(groups.flat().map(String).filter(Boolean)),
    ],
  }),
);

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: {
    findOne: mocks.settingsFindOne,
  },
  CommunicationConversationModel: {
    find: mocks.conversationFind,
    updateMany: mocks.conversationUpdateMany,
  },
  CommunicationMessageModel: {
    find: mocks.messageFind,
    updateMany: mocks.messageUpdateMany,
  },
  CommunicationDeliveryModel: {
    updateMany: mocks.deliveryUpdateMany,
  },
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  deleteObjectFromR2: mocks.deleteObjectFromR2,
}));

vi.mock("@/modules/communications/services/audit.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("@/modules/communications/services/audit.service.js")
  >("@/modules/communications/services/audit.service.js");
  return {
    ...actual,
    recordCommunicationAudit: mocks.recordAudit,
  };
});

import { enforceCommunicationRetentionForTenant } from "@/modules/communications/services/retention.service.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const TENANT_ID = "tenant-1";

const settingsQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    lean: vi.fn().mockResolvedValue(value),
  })),
});

const conversationsQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    limit: vi.fn(() => ({
      lean: vi.fn().mockResolvedValue(value),
    })),
  })),
});

const mediaQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    lean: vi.fn().mockResolvedValue(value),
  })),
});

describe("communications retention enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsFindOne.mockReturnValue(
      settingsQuery({
        retention: {
          days: 90,
          redactInsteadOfDelete: true,
          retainAuditDays: 365,
        },
      }),
    );
    mocks.conversationFind.mockReturnValue(conversationsQuery([]));
    mocks.messageFind.mockReturnValue(mediaQuery([]));
    mocks.conversationUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mocks.messageUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mocks.deliveryUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mocks.deleteObjectFromR2.mockResolvedValue(undefined);
    mocks.recordAudit.mockResolvedValue(undefined);
    mocks.enforceEmailLogRetention.mockResolvedValue(0);
    mocks.listEmailLogTenantIds.mockResolvedValue([]);
  });

  it("selects only closed, resolved, inactive conversations older than the tenant cutoff", async () => {
    const result = await enforceCommunicationRetentionForTenant(TENANT_ID, NOW);
    const cutoff = new Date("2026-04-23T12:00:00.000Z");

    expect(mocks.settingsFindOne).toHaveBeenCalledWith({ tenantId: TENANT_ID });
    expect(mocks.conversationFind).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      status: "closed",
      resolvedAt: { $ne: null, $lt: cutoff },
      lastMessageAt: { $lt: cutoff },
      deletedAt: null,
    });
    expect(mocks.messageUpdateMany).not.toHaveBeenCalled();
    expect(mocks.conversationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(result).toEqual({
      conversations: 0,
      messages: 0,
      automationEmailLogs: 0,
      mode: "redact",
    });
  });

  it("redacts expired message and customer content while preserving tenant-scoped records", async () => {
    mocks.conversationFind.mockReturnValue(
      conversationsQuery([
        { _id: "conversation-1", locationId: "location-1" },
        { _id: "conversation-2", locationId: null },
      ]),
    );
    mocks.messageUpdateMany.mockResolvedValue({ modifiedCount: 4 });

    const result = await enforceCommunicationRetentionForTenant(TENANT_ID, NOW);
    const cutoff = new Date("2026-04-23T12:00:00.000Z");

    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
      {
        tenantId: TENANT_ID,
        conversationId: { $in: ["conversation-1", "conversation-2"] },
        createdAt: { $lt: cutoff },
        deletedAt: null,
      },
      {
        $set: expect.objectContaining({
          text: "[redacted by retention policy]",
          html: "",
          transcript: "",
          attachments: [],
          translations: {},
          headers: {},
          sender: {},
          recipients: [],
          editedAt: NOW,
        }),
      },
    );
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith(
      {
        tenantId: TENANT_ID,
        _id: { $in: ["conversation-1", "conversation-2"] },
      },
      {
        $set: expect.objectContaining({
          subject: "Expired conversation",
          contact: {},
          customerId: null,
          lastMessagePreview: "[redacted by retention policy]",
          "ai.summary": "",
          "ai.suggestedReply": "",
        }),
      },
    );
    expect(result).toEqual({
      conversations: 2,
      messages: 4,
      automationEmailLogs: 0,
      mode: "redact",
    });
  });

  it("soft-deletes eligible tenant records when configured instead of redacting", async () => {
    mocks.settingsFindOne.mockReturnValue(
      settingsQuery({
        retention: {
          days: 90,
          redactInsteadOfDelete: false,
          retainAuditDays: 365,
        },
      }),
    );
    mocks.conversationFind.mockReturnValue(
      conversationsQuery([{ _id: "conversation-1", locationId: null }]),
    );
    mocks.messageUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    const result = await enforceCommunicationRetentionForTenant(TENANT_ID, NOW);

    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        conversationId: { $in: ["conversation-1"] },
      }),
      { $set: { deletedAt: NOW } },
    );
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, _id: { $in: ["conversation-1"] } },
      { $set: { deletedAt: NOW } },
    );
    expect(result).toEqual({
      conversations: 1,
      messages: 2,
      automationEmailLogs: 0,
      mode: "soft_delete",
    });
  });

  it("deletes only tenant-owned private communication media before redaction", async () => {
    mocks.conversationFind.mockReturnValue(
      conversationsQuery([{ _id: "conversation-1", locationId: null }]),
    );
    mocks.messageFind.mockReturnValue(
      mediaQuery([
        {
          attachments: [
            {
              url: "r2://tenants/tenant-1/communications/conversation-1/voice/a.ogg",
            },
            {
              url: "r2://tenants/other-tenant/communications/conversation-1/voice/b.ogg",
            },
            { url: "https://example.com/not-owned.ogg" },
          ],
        },
      ]),
    );
    mocks.messageUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    await enforceCommunicationRetentionForTenant(TENANT_ID, NOW);

    expect(mocks.deleteObjectFromR2).toHaveBeenCalledTimes(1);
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({
      key: "tenants/tenant-1/communications/conversation-1/voice/a.ogg",
    });
    expect(mocks.messageUpdateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.deleteObjectFromR2.mock.invocationCallOrder[0],
    );
  });

  it("records a tenant-scoped audit event with configured audit retention", async () => {
    mocks.conversationFind.mockReturnValue(
      conversationsQuery([{ _id: "conversation-1", locationId: null }]),
    );
    mocks.messageUpdateMany.mockResolvedValue({ modifiedCount: 3 });

    await enforceCommunicationRetentionForTenant(TENANT_ID, NOW);

    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorType: "system",
        action: "retention_purged",
        resourceType: "conversation_batch",
        metadata: expect.objectContaining({
          mode: "redact",
          conversationCount: 1,
          messageCount: 3,
          cutoff: new Date("2026-04-23T12:00:00.000Z"),
        }),
        retentionDays: 365,
      }),
    );
  });
});
