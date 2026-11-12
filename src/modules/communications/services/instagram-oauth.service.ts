import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { badRequest, conflict } from "@/shared/http/httpErrors.js";
import { decryptSecret, encryptSecret } from "@/shared/security/encryption.js";

import { CommunicationSettingsModel } from "../communications.models.js";
import { AUDIT_ACTION, COMMUNICATION_CHANNEL } from "../communications.constants.js";
import { recordCommunicationAudit } from "./audit.service.js";

const STATE_TTL_MS = 10 * 60_000;

type OAuthStatePayload = {
  tenantId: string;
  userId: string;
  nonce: string;
  exp: number;
};

const stateSecret = () => {
  const secret = String(
    process.env.INSTAGRAM_OAUTH_STATE_SECRET ||
      process.env.COMMUNICATION_WEBHOOK_SECRET ||
      "",
  ).trim();
  if (!secret || (process.env.NODE_ENV === "production" && secret.length < 32)) {
    badRequest({
      message: "Instagram OAuth state protection is not configured.",
      code: "INSTAGRAM_OAUTH_NOT_CONFIGURED",
    });
  }
  return secret;
};

const instagramClient = () => {
  const clientId = String(process.env.INSTAGRAM_APP_ID || "").trim();
  const clientSecret = String(process.env.INSTAGRAM_APP_SECRET || "").trim();
  const redirectUri = String(process.env.INSTAGRAM_OAUTH_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    badRequest({
      message: "Instagram OAuth is not configured.",
      code: "INSTAGRAM_OAUTH_NOT_CONFIGURED",
    });
  }
  return { clientId, clientSecret, redirectUri };
};

const signStatePayload = (payload: OAuthStatePayload) => {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
};

const parseState = (state: string, now = Date.now()): OAuthStatePayload => {
  const [encoded, signature] = String(state || "").split(".");
  if (!encoded || !signature) {
    badRequest({
      message: "Instagram OAuth state is invalid.",
      code: "INSTAGRAM_OAUTH_STATE_INVALID",
    });
  }
  const expected = createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    badRequest({
      message: "Instagram OAuth state is invalid.",
      code: "INSTAGRAM_OAUTH_STATE_INVALID",
    });
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
  } catch {
    badRequest({
      message: "Instagram OAuth state is invalid.",
      code: "INSTAGRAM_OAUTH_STATE_INVALID",
    });
  }
  if (
    !/^[a-f0-9]{24}$/i.test(payload.tenantId) ||
    !/^[a-f0-9]{24}$/i.test(payload.userId) ||
    !/^[A-Za-z0-9_-]{20,200}$/.test(payload.nonce) ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now
  ) {
    badRequest({
      message: "Instagram OAuth state has expired or is invalid.",
      code: "INSTAGRAM_OAUTH_STATE_EXPIRED",
    });
  }
  return payload;
};

const stateHash = (state: string) =>
  createHash("sha256").update(state).digest("hex");

export const beginInstagramOAuth = async ({
  settings,
  tenantId,
  userId,
  now = new Date(),
}: {
  settings: any;
  tenantId: string;
  userId: string;
  now?: Date;
}) => {
  const { clientId, redirectUri } = instagramClient();
  const payload: OAuthStatePayload = {
    tenantId,
    userId,
    nonce: randomBytes(24).toString("base64url"),
    exp: now.getTime() + STATE_TTL_MS,
  };
  const state = signStatePayload(payload);
  settings.channels.instagram.oauthStateHash = stateHash(state);
  settings.channels.instagram.oauthStateExpiresAt = new Date(payload.exp);
  settings.channels.instagram.oauthInitiatedBy = userId;
  await settings.save();

  const authorizationUrl = new URL(
    process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL?.trim() ||
      "https://www.instagram.com/oauth/authorize",
  );
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "scope",
    process.env.INSTAGRAM_OAUTH_SCOPES?.trim() ||
      "instagram_business_basic,instagram_business_manage_messages",
  );
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("enable_fb_login", "0");
  authorizationUrl.searchParams.set("force_authentication", "1");
  return {
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(payload.exp),
  };
};

const consumeOAuthState = async (state: string) => {
  const payload = parseState(state);
  const settings = await CommunicationSettingsModel.findOneAndUpdate(
    {
      tenantId: payload.tenantId,
      "channels.instagram.oauthStateHash": stateHash(state),
      "channels.instagram.oauthStateExpiresAt": { $gt: new Date() },
      "channels.instagram.oauthInitiatedBy": payload.userId,
    },
    {
      $set: {
        "channels.instagram.oauthStateHash": "",
        "channels.instagram.oauthStateExpiresAt": null,
        "channels.instagram.oauthInitiatedBy": null,
      },
    },
    { returnDocument: "after" },
  ).select("tenantId channels.instagram.instagramAccountId");
  if (!settings) {
    conflict({
      message: "Instagram OAuth state was already used or has expired.",
      code: "INSTAGRAM_OAUTH_STATE_REPLAYED",
    });
  }
  return { payload, settings };
};

const exchangeAuthorizationCode = async (code: string) => {
  const { clientId, clientSecret, redirectUri } = instagramClient();
  const tokenEndpoint =
    process.env.INSTAGRAM_OAUTH_TOKEN_URL?.trim() ||
    "https://api.instagram.com/oauth/access_token";
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const shortResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const shortPayload = (await shortResponse.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  if (!shortResponse.ok || !shortPayload.access_token) {
    throw new Error(
      String(
        shortPayload?.error_message ||
          shortPayload?.error?.message ||
          "Instagram authorization-code exchange failed.",
      ),
    );
  }

  const longEndpoint = new URL(
    process.env.INSTAGRAM_LONG_LIVED_TOKEN_URL?.trim() ||
      "https://graph.instagram.com/access_token",
  );
  longEndpoint.searchParams.set("grant_type", "ig_exchange_token");
  longEndpoint.searchParams.set("client_secret", clientSecret);
  longEndpoint.searchParams.set(
    "access_token",
    String(shortPayload.access_token),
  );
  const longResponse = await fetch(longEndpoint, {
    signal: AbortSignal.timeout(15_000),
  });
  const longPayload = (await longResponse.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  if (!longResponse.ok || !longPayload.access_token) {
    throw new Error(
      String(
        longPayload?.error?.message ||
          "Instagram long-lived token exchange failed.",
      ),
    );
  }
  const expiresIn = Math.max(
    60,
    Number(longPayload.expires_in || 60 * 86_400),
  );
  return {
    accessToken: String(longPayload.access_token),
    hintedAccountId: String(shortPayload.user_id || ""),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
};

const fetchInstagramProfile = async (
  accessToken: string,
  hintedAccountId: string,
) => {
  const baseUrl =
    process.env.INSTAGRAM_GRAPH_API_URL?.trim() ||
    "https://graph.instagram.com/v25.0";
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/me`);
  url.searchParams.set("fields", "id,user_id,username,name");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  if (!response.ok) {
    throw new Error(
      String(payload?.error?.message || "Instagram profile lookup failed."),
    );
  }
  const instagramAccountId = String(
    payload.user_id || payload.id || hintedAccountId || "",
  );
  if (!instagramAccountId) {
    throw new Error("Instagram did not return a professional account id.");
  }
  return {
    instagramAccountId,
    username: String(payload.username || ""),
  };
};

const subscribeInstagramWebhooks = async (
  instagramAccountId: string,
  accessToken: string,
) => {
  const baseUrl =
    process.env.INSTAGRAM_GRAPH_API_URL?.trim() ||
    "https://graph.instagram.com/v25.0";
  const fields = (process.env.INSTAGRAM_WEBHOOK_FIELDS ||
    "messages,messaging_postbacks")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const endpoint = new URL(
    `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(instagramAccountId)}/subscribed_apps`,
  );
  endpoint.searchParams.set("subscribed_fields", fields.join(","));
  const headers = { authorization: `Bearer ${accessToken}` };
  const subscribeResponse = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const subscribePayload = (await subscribeResponse
    .json()
    .catch(() => ({}))) as Record<string, any>;
  if (!subscribeResponse.ok || subscribePayload.success !== true) {
    throw new Error(
      String(
        subscribePayload?.error?.message ||
          "Instagram webhook subscription failed.",
      ),
    );
  }
  const verifyUrl = new URL(endpoint);
  verifyUrl.searchParams.delete("subscribed_fields");
  const verifyResponse = await fetch(verifyUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const verifyPayload = (await verifyResponse.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  const subscriptions = Array.isArray(verifyPayload.data)
    ? verifyPayload.data
    : [];
  const subscribedFields = new Set(
    subscriptions.flatMap((item: any) =>
      Array.isArray(item?.subscribed_fields) ? item.subscribed_fields : [],
    ),
  );
  if (
    !verifyResponse.ok ||
    fields.some((field) => !subscribedFields.has(field))
  ) {
    throw new Error(
      String(
        verifyPayload?.error?.message ||
          "Instagram messaging webhook subscription could not be verified.",
      ),
    );
  }
};

export const completeInstagramOAuth = async ({
  code,
  state,
  providerError,
}: {
  code?: string;
  state: string;
  providerError?: string;
}) => {
  const { payload } = await consumeOAuthState(state);
  if (providerError || !code) {
    return { connected: false, reason: "access_denied" } as const;
  }
  const token = await exchangeAuthorizationCode(code);
  const profile = await fetchInstagramProfile(
    token.accessToken,
    token.hintedAccountId,
  );
  const claimed = await CommunicationSettingsModel.findOne({
    tenantId: { $ne: payload.tenantId },
    "channels.instagram.instagramAccountId": profile.instagramAccountId,
  })
    .select("_id")
    .lean();
  if (claimed) {
    conflict({
      message: "This Instagram account is already connected to another workspace.",
      code: "INSTAGRAM_ACCOUNT_ALREADY_CONNECTED",
    });
  }
  await subscribeInstagramWebhooks(
    profile.instagramAccountId,
    token.accessToken,
  );
  try {
    const settings = await CommunicationSettingsModel.findOneAndUpdate(
      { tenantId: payload.tenantId },
      {
        $set: {
          "channels.instagram.enabled": true,
          "channels.instagram.provider": "meta",
          "channels.instagram.instagramAccountId":
            profile.instagramAccountId,
          "channels.instagram.username": profile.username,
          "channels.instagram.encryptedAccessToken": encryptSecret(
            token.accessToken,
          ),
          "channels.instagram.tokenExpiresAt": token.expiresAt,
          "channels.instagram.connectedAt": new Date(),
          "channels.instagram.lastTokenRefreshAt": new Date(),
          "channels.instagram.tokenRefreshFailedAt": null,
          "channels.instagram.tokenRefreshError": "",
        },
      },
      { returnDocument: "after", runValidators: true },
    ).select("tenantId channels.instagram.instagramAccountId channels.instagram.username");
    if (!settings) {
      throw new Error("Communication settings no longer exist.");
    }
    await recordCommunicationAudit({
      tenantId: payload.tenantId,
      actorType: "user",
      actorId: payload.userId,
      action: AUDIT_ACTION.UPDATED,
      resourceType: "communication_settings",
      summary: "Instagram account connected.",
      metadata: {
        channel: COMMUNICATION_CHANNEL.INSTAGRAM,
        instagramAccountId: profile.instagramAccountId,
        username: profile.username,
      },
    });
    return {
      connected: true,
      tenantId: String(settings.tenantId),
      instagramAccountId: profile.instagramAccountId,
      username: profile.username,
    } as const;
  } catch (error: any) {
    if (error?.code === 11000) {
      conflict({
        message: "This Instagram account is already connected to another workspace.",
        code: "INSTAGRAM_ACCOUNT_ALREADY_CONNECTED",
      });
    }
    throw error;
  }
};

export const disconnectInstagramAccount = async (tenantId: string) => {
  const existing: any = await CommunicationSettingsModel.findOne({ tenantId })
    .select(
      "+channels.instagram.encryptedAccessToken channels.instagram.instagramAccountId",
    );
  if (!existing) return { disconnected: false, providerWarning: "" };
  let providerWarning = "";
  const encryptedToken = String(
    existing.channels?.instagram?.encryptedAccessToken || "",
  );
  const instagramAccountId = String(
    existing.channels?.instagram?.instagramAccountId || "",
  );
  if (encryptedToken && instagramAccountId) {
    try {
      const token = decryptSecret(encryptedToken);
      const baseUrl =
        process.env.INSTAGRAM_GRAPH_API_URL?.trim() ||
        "https://graph.instagram.com/v25.0";
      const headers = { authorization: `Bearer ${token}` };
      const unsubscribeResponse = await fetch(
        `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(instagramAccountId)}/subscribed_apps`,
        {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!unsubscribeResponse.ok) {
        throw new Error(
          `Instagram webhook unsubscribe returned ${unsubscribeResponse.status}.`,
        );
      }
      const revokeResponse = await fetch(
        `${baseUrl.replace(/\/$/, "")}/me/permissions`,
        {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!revokeResponse.ok) {
        throw new Error(
          `Instagram permission revocation returned ${revokeResponse.status}.`,
        );
      }
    } catch (error: any) {
      providerWarning = String(
        error?.message || "Instagram provider disconnect failed.",
      ).slice(0, 500);
    }
  }
  const settings = await CommunicationSettingsModel.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        "channels.instagram.enabled": false,
        "channels.instagram.instagramAccountId": "",
        "channels.instagram.username": "",
        "channels.instagram.encryptedAccessToken": "",
        "channels.instagram.tokenExpiresAt": null,
        "channels.instagram.connectedAt": null,
        "channels.instagram.lastTokenRefreshAt": null,
        "channels.instagram.tokenRefreshFailedAt": null,
        "channels.instagram.tokenRefreshError": "",
        "channels.instagram.oauthStateHash": "",
        "channels.instagram.oauthStateExpiresAt": null,
        "channels.instagram.oauthInitiatedBy": null,
      },
    },
    { returnDocument: "after" },
  );
  return {
    disconnected: Boolean(settings),
    providerWarning,
  };
};

export const instagramOAuthFrontendRedirect = ({
  connected,
  reason,
}: {
  connected: boolean;
  reason?: string;
}) => {
  const configured = String(
    process.env.INSTAGRAM_OAUTH_FRONTEND_REDIRECT_URL ||
      process.env.CLIENT_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:4310",
  );
  const url = new URL(configured);
  url.searchParams.set("instagram", connected ? "connected" : "error");
  if (!connected) url.searchParams.set("reason", reason || "connection_failed");
  return url.toString();
};

export const __instagramOAuthTestables = { parseState, stateHash };
