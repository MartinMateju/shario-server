import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationFindOne: vi.fn(),
  conversationFindOneAndUpdate: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdateOne: vi.fn(),
  messageFindOne: vi.fn(),
  messageCreate: vi.fn(),
  deliveryFindOne: vi.fn(),
  deliveryFindOneAndUpdate: vi.fn(),
  settingsFindOne: vi.fn(),
  settingsCreate: vi.fn(),
  satisfactionFindOne: vi.fn(),
  satisfactionExists: vi.fn(),
  satisfactionFindOneAndUpdate: vi.fn(),
  recordAudit: vi.fn(),
  processDelivery: vi.fn(),
  retryDelivery: vi.fn(),
  fallbackDelivery: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  hasWorkspacePermission: vi.fn(),
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationAuditModel: {},
  CommunicationConsentModel: {},
  CommunicationConversationModel: {
    findOne: mocks.conversationFindOne,
    findOneAndUpdate: mocks.conversationFindOneAndUpdate,
    create: mocks.conversationCreate,
    updateOne: mocks.conversationUpdateOne,
  },
  CommunicationDeliveryModel: {
    findOne: mocks.deliveryFindOne,
    findOneAndUpdate: mocks.deliveryFindOneAndUpdate,
  },
  CommunicationKnowledgeArticleModel: {},
  CommunicationMessageModel: {
    findOne: mocks.messageFindOne,
    create: mocks.messageCreate,
  },
  CommunicationRoutingRuleModel: {},
  CommunicationSatisfactionSurveyModel: {
    findOne: mocks.satisfactionFindOne,
    exists: mocks.satisfactionExists,
    findOneAndUpdate: mocks.satisfactionFindOneAndUpdate,
  },
  CommunicationSettingsModel: {
    findOne: mocks.settingsFindOne,
    create: mocks.settingsCreate,
  },
}));

vi.mock("@/modules/communications/services/audit.service.js", () => ({
  recordCommunicationAudit: mocks.recordAudit,
}));

vi.mock(
  "@/modules/communications/services/delivery-processing.service.js",
  () => ({
    processCommunicationDelivery: mocks.processDelivery,
    retryCommunicationDelivery: mocks.retryDelivery,
    fallbackCommunicationDelivery: mocks.fallbackDelivery,
  }),
);

vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccess,
    hasWorkspacePermission: mocks.hasWorkspacePermission,
  };
});

import {
  communicationManagementService,
  communicationService,
} from "@/modules/communications/services/communications.service.js";
import {
  hashSatisfactionToken,
} from "@/modules/communications/services/satisfaction.service.js";
import {
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const thenableQuery = <T>(value: T) => ({
  lean: vi.fn().mockResolvedValue(value),
  then: (
    resolve: (result: T) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject),
});

const leanQuery = <T>(value: T) => ({
  lean: vi.fn().mockResolvedValue(value),
});

const populatedQuery = <T>(value: T) => {
  const query: Record<string, any> = {
    populate: vi.fn(() => query),
    lean: vi.fn().mockResolvedValue(value),
    then: (
      resolve: (result: T) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
};

const selectedQuery = <T>(value: T) => {
  const query = {
    select: vi.fn(() => query),
    then: (
      resolve: (result: T) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
};

const context = {
  tenantId: "507f1f77bcf86cd799439011",
  userId: "507f1f77bcf86cd799439012",
  role: WORKSPACE_ROLE.OWNER,
  allowedLocationIds: null,
};

describe("communications service idempotency safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsFindOne.mockReturnValue(
      selectedQuery({
        inbox: { senderName: "Studio Grohova", senderEmail: "studio@example.com" },
        delivery: { maxAttempts: 4 },
        satisfaction: { enabled: true },
      }),
    );
    mocks.satisfactionFindOne.mockResolvedValue(null);
    mocks.satisfactionExists.mockResolvedValue(null);
    mocks.recordAudit.mockResolvedValue(undefined);
  });

  it("replays a new-compose idempotency key without creating an orphan conversation", async () => {
    const existingConversation = {
      _id: "507f1f77bcf86cd799439021",
      tenantId: context.tenantId,
      subject: "Existing conversation",
    };
    const existingMessage = {
      _id: "507f1f77bcf86cd799439022",
      tenantId: context.tenantId,
      conversationId: existingConversation._id,
      idempotencyKey: "compose-booking-123",
      channel: "email",
      subject: "Booking question",
      text: "Can I move my booking?",
      recipients: [{ name: "Anna", email: "anna@example.com" }],
    };
    const existingDelivery = {
      _id: "507f1f77bcf86cd799439023",
      messageId: existingMessage._id,
    };
    const accidentallyCreatedConversation = {
      _id: "507f1f77bcf86cd799439099",
      channels: ["email"],
      save: vi.fn(),
    };
    mocks.messageFindOne.mockReturnValue(leanQuery(existingMessage));
    mocks.deliveryFindOne.mockResolvedValue(existingDelivery);
    mocks.conversationFindOne.mockReturnValue(
      populatedQuery(existingConversation),
    );
    mocks.conversationCreate.mockResolvedValue(accidentallyCreatedConversation);

    const result = await communicationService.compose(context, {
      idempotencyKey: "compose-booking-123",
      customerId: null,
      channel: "email",
      to: [{ name: "Anna", email: "anna@example.com" }],
      subject: "Booking question",
      text: "Can I move my booking?",
      html: "",
      attachments: [],
      locationId: null,
      category: "booking_change",
      priority: "normal",
      language: "en",
      purpose: "support",
    });

    expect(mocks.conversationCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      conversation: existingConversation,
      message: existingMessage,
      delivery: existingDelivery,
      idempotentReplay: true,
    });
  });

  it("rejects a cold Instagram compose before creating a phantom conversation", async () => {
    await expect(
      communicationService.compose(context, {
        channel: "instagram",
        to: [{ instagramScopedId: "igsid-customer-1" }],
        subject: "",
        text: "Cold outbound message",
        html: "",
        attachments: [],
        purpose: "support",
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_RETIRED" });
    expect(mocks.conversationCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("omits retired social channels and never serializes their secrets", async () => {
    const settingsValue: any = {
      tenantKey: "tenant-webhook-key",
      inbox: { forwardingLocalPart: "studio-grohova" },
      channels: {
        whatsapp: { encryptedAccessToken: "whatsapp-secret" },
        instagram: {
          enabled: true,
          instagramAccountId: "ig-business-1",
          encryptedAccessToken: "instagram-secret",
          oauthStateHash: "oauth-state-hash",
          oauthStateExpiresAt: new Date(Date.now() + 60_000),
          oauthInitiatedBy: context.userId,
          tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      },
      toObject: vi.fn(function toObject() {
        return structuredClone({
          tenantKey: this.tenantKey,
          inbox: this.inbox,
          channels: this.channels,
        });
      }),
    };
    mocks.settingsFindOne.mockReturnValue(selectedQuery(settingsValue));

    const result = await communicationManagementService.getSettings(context);

    expect(result.channels).not.toHaveProperty("instagram");
    expect(result.channels).not.toHaveProperty("whatsapp");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("instagram-secret");
    expect(serialized).not.toContain("oauth-state-hash");
    expect(serialized).not.toContain("whatsapp-secret");
  });

  it("rechecks task permission inside the AI action executor before claiming a suggestion", async () => {
    const action = {
      _id: "507f1f77bcf86cd799439077",
      key: "create_task",
      status: "suggested",
      metadata: {
        payload: { title: "Call the customer", priority: "high" },
      },
    };
    const conversation = {
      _id: "507f1f77bcf86cd799439076",
      tenantId: context.tenantId,
      ai: { actions: { id: vi.fn(() => action) } },
    };
    mocks.conversationFindOne.mockReturnValue(thenableQuery(conversation));
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      tenantId: context.tenantId,
      userId: context.userId,
      permissions: [WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN],
    });
    mocks.hasWorkspacePermission.mockReturnValue(false);

    await expect(
      communicationService.decideAction(
        context,
        conversation._id,
        action._id,
        { decision: "approve" },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_PERMISSION_REQUIRED",
      details: { requiredPermissions: [WORKSPACE_PERMISSION.TASKS_MANAGE] },
    });

    expect(mocks.resolveWorkspaceAccess).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      userId: context.userId,
    });
    expect(mocks.hasWorkspacePermission).toHaveBeenCalledWith(
      expect.any(Object),
      WORKSPACE_PERMISSION.TASKS_MANAGE,
    );
    expect(mocks.conversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("never returns a CSAT URL whose raw token does not match the persisted hash", async () => {
    const conversation = {
      _id: "507f1f77bcf86cd799439031",
      tenantId: context.tenantId,
      customerId: "507f1f77bcf86cd799439032",
      locationId: null,
      status: "open",
      save: vi.fn(async function save() {
        return this;
      }),
    };
    const existingSurvey = {
      _id: "507f1f77bcf86cd799439033",
      tenantId: context.tenantId,
      conversationId: conversation._id,
      status: "pending",
      tokenHash: hashSatisfactionToken("existing-valid-token"),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    mocks.conversationFindOne.mockReturnValue(populatedQuery(conversation));
    mocks.satisfactionFindOne.mockResolvedValue(existingSurvey);
    mocks.satisfactionFindOneAndUpdate.mockResolvedValue(existingSurvey);

    const result = await communicationService.resolve(
      context,
      conversation._id,
      {
        resolutionNote: "",
        sendSatisfactionSurvey: true,
        satisfactionChannel: "email",
      },
    );

    const returnedToken = result.satisfaction?.token;
    expect(
      returnedToken === null ||
        returnedToken === undefined ||
        hashSatisfactionToken(returnedToken) === existingSurvey.tokenHash,
    ).toBe(true);
  });
});
