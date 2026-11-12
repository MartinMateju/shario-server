import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFindOne: vi.fn(),
  settingsFindOneAndUpdate: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: {
    findOne: mocks.settingsFindOne,
    findOneAndUpdate: mocks.settingsFindOneAndUpdate,
  },
}));

vi.mock("@/modules/communications/services/audit.service.js", () => ({
  recordCommunicationAudit: mocks.recordAudit,
}));

import {
  beginInstagramOAuth,
  completeInstagramOAuth,
} from "@/modules/communications/services/instagram-oauth.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

const selected = <T>(value: T) => ({
  select: vi.fn().mockResolvedValue(value),
});

const selectedLean = <T>(value: T) => ({
  select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("INSTAGRAM_APP_ID", "instagram-app-id");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "instagram-app-secret");
  vi.stubEnv(
    "INSTAGRAM_OAUTH_REDIRECT_URI",
    "https://api.shario.io/communications/instagram/oauth/callback",
  );
  vi.stubEnv("INSTAGRAM_OAUTH_STATE_SECRET", "s".repeat(48));
  vi.stubEnv("COMMUNICATION_SECRET_KEY", "e".repeat(48));
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe("Instagram OAuth security and lifecycle", () => {
  it("persists only a short-lived state hash tied to tenant and initiating user", async () => {
    const settings: any = {
      channels: { instagram: {} },
      save: vi.fn(),
    };
    const result = await beginInstagramOAuth({
      settings,
      tenantId: TENANT_ID,
      userId: USER_ID,
      now: new Date("2026-07-22T12:00:00.000Z"),
    });
    const state = new URL(result.authorizationUrl).searchParams.get("state");

    expect(state).toBeTruthy();
    expect(settings.channels.instagram.oauthStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(settings.channels.instagram.oauthStateHash).not.toBe(state);
    expect(settings.channels.instagram.oauthInitiatedBy).toBe(USER_ID);
    expect(settings.channels.instagram.oauthStateExpiresAt).toEqual(
      new Date("2026-07-22T12:10:00.000Z"),
    );
    expect(settings.save).toHaveBeenCalledTimes(1);
  });

  it("uses bearer auth for profile/subscription calls and stores only an encrypted long-lived token", async () => {
    const settings: any = {
      channels: { instagram: {} },
      save: vi.fn(),
    };
    const authorization = await beginInstagramOAuth({
      settings,
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
    const state = new URL(authorization.authorizationUrl).searchParams.get(
      "state",
    )!;
    mocks.settingsFindOneAndUpdate
      .mockReturnValueOnce(selected({ tenantId: TENANT_ID }))
      .mockReturnValueOnce(
        selected({
          tenantId: TENANT_ID,
          channels: {
            instagram: {
              instagramAccountId: "ig-business-1",
              username: "studio.grohova",
            },
          },
        }),
      );
    mocks.settingsFindOne.mockReturnValue(selectedLean(null));
    const jsonResponse = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "short-token", user_id: "ig-business-1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "long-lived-token", expires_in: 5_184_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "ig-business-1", username: "studio.grohova" }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              subscribed_fields: ["messages", "messaging_postbacks"],
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeInstagramOAuth({ code: "oauth-code", state }),
    ).resolves.toMatchObject({
      connected: true,
      instagramAccountId: "ig-business-1",
      username: "studio.grohova",
    });

    const profileUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    const profileInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(profileUrl.searchParams.has("access_token")).toBe(false);
    expect((profileInit.headers as Record<string, string>).authorization).toBe(
      "Bearer long-lived-token",
    );
    const subscribeUrl = new URL(String(fetchMock.mock.calls[3]?.[0]));
    expect(subscribeUrl.pathname).toContain(
      "/ig-business-1/subscribed_apps",
    );
    const persistedPatch = mocks.settingsFindOneAndUpdate.mock.calls[1]?.[1];
    const encrypted =
      persistedPatch.$set["channels.instagram.encryptedAccessToken"];
    expect(encrypted).not.toBe("long-lived-token");
    expect(String(encrypted).split(":")).toHaveLength(3);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorId: USER_ID,
        metadata: expect.objectContaining({
          instagramAccountId: "ig-business-1",
        }),
      }),
    );
  });

  it("rejects a replayed or consumed OAuth state before exchanging a code", async () => {
    const settings: any = {
      channels: { instagram: {} },
      save: vi.fn(),
    };
    const authorization = await beginInstagramOAuth({
      settings,
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
    const state = new URL(authorization.authorizationUrl).searchParams.get(
      "state",
    )!;
    mocks.settingsFindOneAndUpdate.mockReturnValueOnce(selected(null));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeInstagramOAuth({ code: "oauth-code", state }),
    ).rejects.toMatchObject({ code: "INSTAGRAM_OAUTH_STATE_REPLAYED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
