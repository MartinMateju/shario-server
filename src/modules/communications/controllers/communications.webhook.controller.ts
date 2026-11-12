import type { Request, Response } from "express";

import { unauthorized, notFound } from "@/shared/http/httpErrors.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  inboundWebhookSchema,
  instagramOAuthCallbackSchema,
  satisfactionResponseSchema,
  satisfactionTokenParamsSchema,
  webhookParamsSchema,
} from "../communications.validators.js";
import { submitSatisfactionResponse } from "../services/communications.service.js";
import {
  findCommunicationSettingsByInstagramAccountId,
  findCommunicationSettingsByTenantKey,
  ingestCommunicationEvent,
} from "../services/ingestion.service.js";
import {
  normalizeProviderWebhook,
  verifyCommunicationWebhookSignature,
} from "../services/provider.service.js";
import {
  completeInstagramOAuth,
  instagramOAuthFrontendRedirect,
} from "../services/instagram-oauth.service.js";

type RawRequest = Request & { rawBody?: Buffer };

export const verifyCommunicationWebhook = asyncHandler(async (req: RawRequest, res: Response) => {
  const { channel, tenantKey } = webhookParamsSchema.parse(req.params);
  if (channel === "instagram") {
    // Instagram is account-routed only. Accepting a tenant key here would let
    // a caller choose the tenant when Meta omits an account id.
    notFound("Communication endpoint not found.");
  }
  const settings = await findCommunicationSettingsByTenantKey(tenantKey);
  if (!settings) notFound("Communication endpoint not found.");
  const channelEnabled = channel === "email"
    ? settings.channels?.email?.enabled && settings.channels?.email?.inboundEnabled
    : channel === "whatsapp"
      ? settings.channels?.whatsapp?.enabled
      : channel === "instagram"
        ? settings.channels?.instagram?.enabled
      : settings.channels?.inApp?.enabled;
  if (!channelEnabled) notFound("Communication endpoint not found.");
  const signature = req.get("x-shario-signature") || req.get("x-hub-signature-256");
  const timestamp = req.get("x-shario-timestamp");
  if (!verifyCommunicationWebhookSignature({ channel, body: req.body, rawBody: req.rawBody, signature, timestamp })) {
    unauthorized("Invalid communication webhook signature.");
  }
  const normalized = normalizeProviderWebhook(channel, req.body);
  const results = [];
  for (const event of normalized) {
    const input = inboundWebhookSchema.parse(event);
    if (
      channel === "instagram" &&
      input.providerAccountId &&
      input.providerAccountId !==
        String(settings.channels?.instagram?.instagramAccountId || "")
    ) {
      continue;
    }
    results.push(await ingestCommunicationEvent({ settings, channel, input }));
  }
  res.status(202).json({ accepted: true, results });
});

export const verifyWhatsAppWebhookChallenge = asyncHandler(async (req, res) => {
  const { channel, tenantKey } = webhookParamsSchema.parse(req.params);
  const settings = await findCommunicationSettingsByTenantKey(tenantKey);
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || tenantKey;
  if (channel !== "whatsapp" || !settings || mode !== "subscribe" || token !== expected) {
    unauthorized("WhatsApp webhook verification failed.");
  }
  res.status(200).send(challenge);
});

export const verifyInstagramWebhookChallenge = asyncHandler(
  async (req, res) => {
    const mode = String(req.query["hub.mode"] || "");
    const token = String(req.query["hub.verify_token"] || "");
    const challenge = String(req.query["hub.challenge"] || "");
    const expected = String(process.env.INSTAGRAM_VERIFY_TOKEN || "");
    if (
      mode !== "subscribe" ||
      !expected ||
      token !== expected ||
      !challenge
    ) {
      unauthorized("Instagram webhook verification failed.");
    }
    res.status(200).send(challenge);
  },
);

export const receiveInstagramWebhook = asyncHandler(
  async (req: RawRequest, res: Response) => {
    const signature = req.get("x-hub-signature-256");
    if (
      !verifyCommunicationWebhookSignature({
        channel: "instagram",
        body: req.body,
        rawBody: req.rawBody,
        signature,
      })
    ) {
      unauthorized("Invalid Instagram webhook signature.");
    }
    const normalized = normalizeProviderWebhook("instagram", req.body);
    const settingsByAccount = new Map<string, any>();
    let processed = 0;
    let ignored = 0;
    for (const event of normalized) {
      const input = inboundWebhookSchema.parse(event);
      const accountId = String(input.providerAccountId || "").trim();
      if (!accountId) {
        ignored += 1;
        continue;
      }
      let settings = settingsByAccount.get(accountId);
      if (settings === undefined) {
        settings = await findCommunicationSettingsByInstagramAccountId(
          accountId,
        );
        settingsByAccount.set(accountId, settings || null);
      }
      if (!settings?.channels?.instagram?.enabled) {
        // A valid app-signed payload may contain an account that has been
        // disconnected or belongs elsewhere. Acknowledge without revealing
        // whether the account exists in shario.io.
        ignored += 1;
        continue;
      }
      await ingestCommunicationEvent({
        settings,
        channel: "instagram",
        input,
      });
      processed += 1;
    }
    res.status(202).json({ accepted: true, processed, ignored });
  },
);

export const completeInstagramConnection = asyncHandler(async (req, res) => {
  res.set("cache-control", "no-store");
  try {
    const input = instagramOAuthCallbackSchema.parse(req.query);
    const result = await completeInstagramOAuth({
      code: input.code,
      state: input.state,
      providerError: input.error,
    });
    res.redirect(
      302,
      instagramOAuthFrontendRedirect({
        connected: result.connected,
        reason: result.connected ? undefined : result.reason,
      }),
    );
  } catch {
    res.redirect(
      302,
      instagramOAuthFrontendRedirect({
        connected: false,
        reason: "connection_failed",
      }),
    );
  }
});

export const submitSatisfaction = asyncHandler(async (req, res) => {
  const { token } = satisfactionTokenParamsSchema.parse(req.params);
  const result = await submitSatisfactionResponse(token, satisfactionResponseSchema.parse(req.body));
  res.status(200).json({ data: result });
});
