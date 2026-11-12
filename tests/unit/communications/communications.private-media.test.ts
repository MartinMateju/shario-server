import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationFindOne: vi.fn(),
  conversationUpdateOne: vi.fn(),
  messageFind: vi.fn(),
  deliveryFind: vi.fn(),
  getPresignedR2Url: vi.fn(),
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationAuditModel: {},
  CommunicationConsentModel: {},
  CommunicationConversationModel: {
    findOne: mocks.conversationFindOne,
    updateOne: mocks.conversationUpdateOne,
  },
  CommunicationDeliveryModel: { find: mocks.deliveryFind },
  CommunicationKnowledgeArticleModel: {},
  CommunicationMessageModel: { find: mocks.messageFind },
  CommunicationRoutingRuleModel: {},
  CommunicationSatisfactionSurveyModel: {},
  CommunicationSettingsModel: {},
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  getObjectBufferFromR2: vi.fn(),
  getPresignedR2Url: mocks.getPresignedR2Url,
}));

vi.mock("@/modules/communications/services/audit.service.js", () => ({
  recordCommunicationAudit: vi.fn(),
}));

vi.mock(
  "@/modules/communications/services/delivery-processing.service.js",
  () => ({
    processCommunicationDelivery: vi.fn(),
    retryCommunicationDelivery: vi.fn(),
    fallbackCommunicationDelivery: vi.fn(),
  }),
);

import { communicationService } from "@/modules/communications/services/communications.service.js";
import { getOwnedCommunicationR2Key } from "@/modules/communications/services/private-media.service.js";
import { WORKSPACE_ROLE } from "@/modules/tenant-access/tenant-access.constants.js";

const leanQuery = <T>(value: T) => ({
  lean: vi.fn().mockResolvedValue(value),
});

const messageQuery = (value: unknown) => ({
  populate: vi.fn(() => ({
    sort: vi.fn(() => ({
      limit: vi.fn(() => leanQuery(value)),
    })),
  })),
});

const deliveryQuery = (value: unknown) => ({
  sort: vi.fn(() => leanQuery(value)),
});

const context = {
  tenantId: "507f1f77bcf86cd799439011",
  userId: "507f1f77bcf86cd799439012",
  role: WORKSPACE_ROLE.OWNER,
  allowedLocationIds: null,
};

describe("communications private voice playback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindOne.mockReturnValue(
      leanQuery({ _id: "507f1f77bcf86cd799439021" }),
    );
    mocks.conversationUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.deliveryFind.mockReturnValue(deliveryQuery([]));
    mocks.getPresignedR2Url.mockResolvedValue(
      "https://signed-r2.example/voice.ogg?expires=300",
    );
  });

  it("validates private keys without URI-decoding malformed stored values", () => {
    expect(
      getOwnedCommunicationR2Key(
        context.tenantId,
        `r2://tenants/${context.tenantId}/communications/conversation-1/voice/%ZZ.ogg`,
      ),
    ).toBe(
      `tenants/${context.tenantId}/communications/conversation-1/voice/%ZZ.ogg`,
    );
    expect(
      getOwnedCommunicationR2Key(
        context.tenantId,
        `r2://tenants/${context.tenantId}/communications/../other/a.ogg`,
      ),
    ).toBeNull();
    expect(
      getOwnedCommunicationR2Key(
        context.tenantId,
        "r2://tenants/other-tenant/communications/a.ogg",
      ),
    ).toBeNull();
  });

  it("replaces an owned internal R2 reference with a short-lived URL", async () => {
    const storageRef =
      "r2://tenants/507f1f77bcf86cd799439011/communications/conversation-1/voice/a.ogg";
    mocks.messageFind.mockReturnValue(
      messageQuery([
        {
          _id: "507f1f77bcf86cd799439031",
          attachments: [
            { name: "voice.ogg", contentType: "audio/ogg", url: storageRef },
          ],
        },
      ]),
    );

    const result = await communicationService.listMessages(
      context,
      "507f1f77bcf86cd799439021",
      { includeInternal: true, limit: 100 },
    );

    expect(mocks.getPresignedR2Url).toHaveBeenCalledWith({
      key: "tenants/507f1f77bcf86cd799439011/communications/conversation-1/voice/a.ogg",
      expiresInSeconds: 300,
    });
    expect(result.items[0].attachments[0]).toMatchObject({
      url: "https://signed-r2.example/voice.ogg?expires=300",
      private: true,
    });
    expect(JSON.stringify(result)).not.toContain("r2://");
  });

  it("never signs a cross-tenant internal reference", async () => {
    mocks.messageFind.mockReturnValue(
      messageQuery([
        {
          _id: "507f1f77bcf86cd799439031",
          attachments: [
            {
              name: "voice.ogg",
              contentType: "audio/ogg",
              url: "r2://tenants/other-tenant/communications/conversation-1/voice/a.ogg",
            },
          ],
        },
      ]),
    );

    const result = await communicationService.listMessages(
      context,
      "507f1f77bcf86cd799439021",
      { includeInternal: true, limit: 100 },
    );

    expect(mocks.getPresignedR2Url).not.toHaveBeenCalled();
    expect(result.items[0].attachments[0]).toMatchObject({
      url: "",
      unavailable: true,
      private: true,
    });
    expect(JSON.stringify(result)).not.toContain("r2://");
  });
});
