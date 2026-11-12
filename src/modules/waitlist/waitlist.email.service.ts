import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import {
  buildTenantCommerceUrl,
  resolveTenantCommerceOrigin,
} from "@/modules/checkout/checkout.urls.js";

import {
  WAITLIST_EMAIL_TYPE,
  WAITLIST_STATE,
  WAITLIST_TOKEN_PURPOSE,
} from "./waitlist.constants.js";
import {
  WaitlistEmailOutboxModel,
  WaitlistEntryModel,
  WaitlistVerificationModel,
} from "./waitlist.model.js";
import { deriveWaitlistToken, hashWaitlistToken } from "./waitlist.policy.js";
import {
  fromCurrencyMinorUnits,
  normalizeStudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  DEFAULT_APP_LOCALE,
  resolveRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const CLAIM_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;

const tenantModel = (): mongoose.Model<any> =>
  mongoose.model("Tenant") as mongoose.Model<any>;

const messageIdFor = (deduplicationKey: string): string =>
  `<waitlist.${createHash("sha256")
    .update(deduplicationKey)
    .digest("hex")}@shario.io>`;

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const knownNotSent = (error: any): boolean => {
  if (error?.deliveryOutcome === "not_sent" || error?.deliveryOutcome === "rejected") return true;
  if (error?.deliveryOutcome === "unknown") return false;
  const responseCode = Number(error?.responseCode);
  if (Number.isFinite(responseCode) && responseCode >= 400) return true;
  return new Set(["EAUTH", "EENVELOPE", "EMESSAGE", "EDNS", "ECONNECTION"]).has(
    String(error?.code ?? ""),
  );
};

type ResolvedMail = {
  subject: string;
  text: string;
  html: string;
};

const resolveToken = async (outbox: any, now: Date) => {
  const purpose = String(outbox.tokenPurpose ?? "");
  const generation = Number(outbox.tokenGeneration);
  if (!purpose)
    return {
      token: "",
      managementToken: "",
      locale: DEFAULT_APP_LOCALE,
      entry: null,
    };

  if (purpose === WAITLIST_TOKEN_PURPOSE.VERIFY) {
    const verification = await WaitlistVerificationModel.findOne({
      _id: outbox.verification,
      tenant: outbox.tenant,
      generation,
      consumedAt: null,
      expiresAt: { $gt: now },
    })
      .select(
        "email locale generation expiresAt courseSession product +tokenHash",
      )
      .populate({ path: "product", select: "name" })
      .populate({
        path: "courseSession",
        select: "start end location",
        populate: { path: "location", select: "name" },
      })
      .lean()
      .exec();
    if (!verification || verification.email !== outbox.recipientEmail)
      return null;
    const token = deriveWaitlistToken({
      subject: verification._id,
      purpose,
      generation,
    });
    if (verification.tokenHash !== hashWaitlistToken(token, purpose))
      return null;
    return {
      token,
      managementToken: "",
      locale: resolveRolloutEligibleAppLocale(verification.locale),
      entry: verification,
    };
  }

  const entry = await WaitlistEntryModel.findOne({
    _id: outbox.entry,
    tenant: outbox.tenant,
    email: outbox.recipientEmail,
  })
    .select(
      "state isLive locale email firstName lastName offerGeneration offerExpiresAt managementGeneration managementExpiresAt courseSession product +offerTokenHash +managementTokenHash",
    )
    .populate({ path: "product", select: "name" })
    .populate({
      path: "courseSession",
      select: "start end location",
      populate: { path: "location", select: "name" },
    })
    .lean()
    .exec();
  if (!entry) return null;

  if (purpose === WAITLIST_TOKEN_PURPOSE.OFFER) {
    if (
      entry.state !== WAITLIST_STATE.OFFERED ||
      Number(entry.offerGeneration) !== generation ||
      new Date(entry.offerExpiresAt ?? 0) <= now
    ) {
      return null;
    }
  } else if (
    purpose !== WAITLIST_TOKEN_PURPOSE.MANAGE ||
    Number(entry.managementGeneration) !== generation ||
    new Date(entry.managementExpiresAt ?? 0) <= now
  ) {
    return null;
  }

  const token = deriveWaitlistToken({
    subject: entry._id,
    purpose,
    generation,
  });
  const storedHash =
    purpose === WAITLIST_TOKEN_PURPOSE.OFFER
      ? entry.offerTokenHash
      : entry.managementTokenHash;
  if (storedHash !== hashWaitlistToken(token, purpose)) return null;
  const managementToken =
    Number(entry.managementGeneration) > 0 &&
    new Date(entry.managementExpiresAt ?? 0) > now
      ? deriveWaitlistToken({
          subject: entry._id,
          purpose: WAITLIST_TOKEN_PURPOSE.MANAGE,
          generation: Number(entry.managementGeneration),
        })
      : "";
  if (
    managementToken &&
    entry.managementTokenHash !==
      hashWaitlistToken(managementToken, WAITLIST_TOKEN_PURPOSE.MANAGE)
  ) {
    return null;
  }
  return {
    token,
    managementToken,
    locale: resolveRolloutEligibleAppLocale(entry.locale),
    entry,
  };
};

const resolveMail = async (
  outbox: any,
  now: Date,
): Promise<ResolvedMail | null> => {
  const tokenContext = await resolveToken(outbox, now);
  if (!tokenContext) return null;

  let entry = tokenContext.entry;
  if (!entry && outbox.entry) {
    entry = await WaitlistEntryModel.findOne({
      _id: outbox.entry,
      tenant: outbox.tenant,
      email: outbox.recipientEmail,
    })
      .select(
        "state isLive locale firstName lastName courseSession product refundSnapshot",
      )
      .populate({ path: "product", select: "name" })
      .populate({
        path: "courseSession",
        select: "start end location",
        populate: { path: "location", select: "name" },
      })
      .lean()
      .exec();
    if (!entry) return null;
  }

  const stateMatchesType =
    outbox.type === WAITLIST_EMAIL_TYPE.VERIFY ||
    (outbox.type === WAITLIST_EMAIL_TYPE.JOINED && entry?.isLive === true) ||
    (outbox.type === WAITLIST_EMAIL_TYPE.OFFERED &&
      entry?.state === WAITLIST_STATE.OFFERED) ||
    (outbox.type === WAITLIST_EMAIL_TYPE.EXPIRED &&
      entry?.state === WAITLIST_STATE.EXPIRED) ||
    (outbox.type === WAITLIST_EMAIL_TYPE.WITHDRAWN &&
      entry?.state === WAITLIST_STATE.WITHDRAWN) ||
    (outbox.type === WAITLIST_EMAIL_TYPE.CANCELLED &&
      entry?.state === WAITLIST_STATE.CANCELLED) ||
    (outbox.type === WAITLIST_EMAIL_TYPE.REFUNDED &&
      [WAITLIST_STATE.EXPIRED, WAITLIST_STATE.CANCELLED].includes(
        entry?.state,
      ) &&
      String(entry?.refundSnapshot?.refundId ?? "") !== "");
  if (!stateMatchesType) return null;

  const tenant = await tenantModel()
    .findById(outbox.tenant)
    .select("slug name plan planVersion domains")
    .lean()
    .exec();
  if (!tenant?.slug) return null;

  // Keep the customer on the locale captured when they joined. Legacy `CZ`
  // snapshots normalize to `cs`; Wave 1 links retain their canonical route
  // while email prose safely falls back to English until translated.
  const locale = resolveRolloutEligibleAppLocale(
    entry?.locale ?? tokenContext.locale,
  );
  const origin = resolveTenantCommerceOrigin({ tenant });
  const purpose = String(outbox.tokenPurpose ?? "");
  const link = tokenContext.token
    ? purpose === WAITLIST_TOKEN_PURPOSE.OFFER
      ? `${buildTenantCommerceUrl({
          origin,
          locale,
          path: "waitlists/offer",
        })}#offer=${encodeURIComponent(tokenContext.token)}`
      : `${buildTenantCommerceUrl({
          origin,
          locale,
          path: "waitlists/manage",
        })}#${
          purpose === WAITLIST_TOKEN_PURPOSE.VERIFY ? "verify" : "manage"
        }=${encodeURIComponent(tokenContext.token)}`
    : "";
  const managementLink = tokenContext.managementToken
    ? `${buildTenantCommerceUrl({
        origin,
        locale,
        path: "waitlists/manage",
      })}#manage=${encodeURIComponent(tokenContext.managementToken)}`
    : "";
  const course = String(
    entry?.product?.name ?? (locale === "cs" ? "kurz" : "class"),
  );
  const greeting = locale === "cs" ? "Dobrý den" : "Hello";
  const refund = outbox.refundSnapshot ?? entry?.refundSnapshot;
  const refundCurrency = String(refund?.currency ?? "").toUpperCase();
  const refundAmountMinor = Number(refund?.amountMinor);
  const refundAmount =
    refundCurrency && Number.isSafeInteger(refundAmountMinor)
      ? `${fromCurrencyMinorUnits(
          refundAmountMinor,
          normalizeStudioCommerceCurrency(refundCurrency),
        )} ${refundCurrency}`
      : "";

  const copy: Record<string, { subject: string; body: string }> =
    locale === "cs"
      ? {
          [WAITLIST_EMAIL_TYPE.VERIFY]: {
            subject: `Ověřte čekací listinu – ${tenant.name}`,
            body: "Potvrďte e-mail, abychom vás mohli zařadit do čekací listiny.",
          },
          [WAITLIST_EMAIL_TYPE.JOINED]: {
            subject: `Jste v čekací listině – ${course}`,
            body: "Vaše místo v čekací listině je potvrzeno.",
          },
          [WAITLIST_EMAIL_TYPE.OFFERED]: {
            subject: `Uvolnilo se místo – ${course}`,
            body: "Uvolnilo se pro vás místo. Otevřete odkaz a dokončete platbu včas.",
          },
          [WAITLIST_EMAIL_TYPE.EXPIRED]: {
            subject: `Nabídka vypršela – ${course}`,
            body: "Čas pro přijetí nabídky vypršel a místo bylo nabídnuto dalšímu zájemci.",
          },
          [WAITLIST_EMAIL_TYPE.WITHDRAWN]: {
            subject: `Odhlášení z čekací listiny – ${course}`,
            body: "Vaše odhlášení z čekací listiny bylo potvrzeno.",
          },
          [WAITLIST_EMAIL_TYPE.CANCELLED]: {
            subject: `Čekací listina byla zrušena – ${course}`,
            body: "Studio zrušilo tuto položku čekací listiny.",
          },
          [WAITLIST_EMAIL_TYPE.REFUNDED]: {
            subject: `Platba byla vrácena – ${course}`,
            body: `Platbu kartou${refundAmount ? ` ve výši ${refundAmount}` : ""} jsme úspěšně vrátili. Refundace je dokončena.`,
          },
        }
      : {
          [WAITLIST_EMAIL_TYPE.VERIFY]: {
            subject: `Verify your waitlist request – ${tenant.name}`,
            body: "Verify your email so we can add you to the waitlist.",
          },
          [WAITLIST_EMAIL_TYPE.JOINED]: {
            subject: `You're on the waitlist – ${course}`,
            body: "Your place on the waitlist is confirmed.",
          },
          [WAITLIST_EMAIL_TYPE.OFFERED]: {
            subject: `A place is available – ${course}`,
            body: "A place is being held for you. Open the link and complete payment before it expires.",
          },
          [WAITLIST_EMAIL_TYPE.EXPIRED]: {
            subject: `Your offer expired – ${course}`,
            body: "The offer window ended and the place was released to the next customer.",
          },
          [WAITLIST_EMAIL_TYPE.WITHDRAWN]: {
            subject: `Waitlist withdrawal confirmed – ${course}`,
            body: "Your waitlist withdrawal is confirmed.",
          },
          [WAITLIST_EMAIL_TYPE.CANCELLED]: {
            subject: `Waitlist entry cancelled – ${course}`,
            body: "The studio cancelled this waitlist entry.",
          },
          [WAITLIST_EMAIL_TYPE.REFUNDED]: {
            subject: `Payment refunded – ${course}`,
            body: `Your card payment${refundAmount ? ` of ${refundAmount}` : ""} was refunded successfully. The refund is complete.`,
          },
        };
  const selected = copy[outbox.type];
  if (!selected) return null;
  const start = new Date(entry?.courseSession?.start ?? 0);
  const locationName = String(entry?.courseSession?.location?.name ?? "");
  const safeDetails = [
    course,
    Number.isFinite(start.getTime()) && start.getTime() > 0
      ? start.toISOString()
      : "",
    locationName,
  ].filter(Boolean);
  const detailsText = safeDetails.length
    ? `\n\n${locale === "cs" ? "Kurz" : "Class"}: ${safeDetails.join(" · ")}`
    : "";
  const linkText = link
    ? locale === "cs"
      ? `\n\nOtevřít: ${link}`
      : `\n\nOpen: ${link}`
    : "";
  const managementText =
    managementLink && managementLink !== link
      ? locale === "cs"
        ? `\n\nSpravovat čekací listinu: ${managementLink}`
        : `\n\nManage waitlist: ${managementLink}`
      : "";
  const text = `${greeting},\n\n${selected.body}${detailsText}${linkText}${managementText}`;
  const html = `<p>${escapeHtml(greeting)},</p><p>${escapeHtml(
    selected.body,
  )}</p>${
    safeDetails.length
      ? `<p><strong>${locale === "cs" ? "Kurz" : "Class"}:</strong> ${escapeHtml(
          safeDetails.join(" · "),
        )}</p>`
      : ""
  }${
    link
      ? `<p><a href="${escapeHtml(link)}">${
          locale === "cs" ? "Otevřít čekací listinu" : "Open waitlist"
        }</a></p>`
      : ""
  }${
    managementLink && managementLink !== link
      ? `<p><a href="${escapeHtml(managementLink)}">${
          locale === "cs" ? "Spravovat čekací listinu" : "Manage waitlist"
        }</a></p>`
      : ""
  }`;
  return { subject: selected.subject, text, html };
};

const recoverStaleClaims = async (now: Date) => {
  const safe = await WaitlistEmailOutboxModel.updateMany(
    {
      status: "sending",
      claimExpiresAt: { $lte: now },
      providerAttemptStartedAt: null,
    },
    {
      $set: {
        status: "pending",
        claimToken: "",
        claimExpiresAt: null,
        nextAttemptAt: now,
      },
    },
  ).exec();
  const ambiguous = await WaitlistEmailOutboxModel.updateMany(
    {
      status: "sending",
      claimExpiresAt: { $lte: now },
      providerAttemptStartedAt: { $ne: null },
    },
    {
      $set: {
        status: "ambiguous",
        claimToken: "",
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError:
          "Email provider attempt outlived its lease; reconcile the stable Message-ID before retrying.",
      },
    },
  ).exec();
  return { requeued: safe.modifiedCount, ambiguous: ambiguous.modifiedCount };
};

export const processWaitlistEmailOutbox = async (): Promise<number> => {
  const startedAt = new Date();
  await recoverStaleClaims(startedAt);
  let sent = 0;

  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const now = new Date();
    const claimToken = randomUUID();
    const outbox = await WaitlistEmailOutboxModel.findOneAndUpdate(
      {
        status: { $in: ["pending", "failed"] },
        nextAttemptAt: { $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      {
        $set: {
          status: "sending",
          claimToken,
          claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
          providerAttemptStartedAt: null,
          lastError: "",
        },
      },
      { returnDocument: "after", sort: { createdAt: 1, _id: 1 } },
    )
      .select("+claimToken")
      .lean()
      .exec();
    if (!outbox) break;

    try {
      const mail = await resolveMail(outbox, now);
      if (!mail) {
        await WaitlistEmailOutboxModel.updateOne(
          { _id: outbox._id, status: "sending", claimToken },
          {
            $set: {
              status: "skipped",
              claimToken: "",
              claimExpiresAt: null,
              nextAttemptAt: null,
              lastError:
                "Source state or token generation is no longer current.",
            },
          },
        ).exec();
        continue;
      }

      const providerAttempt = await WaitlistEmailOutboxModel.findOneAndUpdate(
        {
          _id: outbox._id,
          status: "sending",
          claimToken,
          claimExpiresAt: { $gt: new Date() },
          providerAttemptStartedAt: null,
        },
        {
          $set: { providerAttemptStartedAt: new Date() },
          $inc: { attempts: 1 },
        },
        { returnDocument: "after" },
      )
        .select("+claimToken")
        .lean()
        .exec();
      if (!providerAttempt) continue;

      let info: any;
      try {
        info = await sendEmail({
          tenantId: String(outbox.tenant),
          to: outbox.recipientEmail,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          messageId: messageIdFor(outbox.deduplicationKey),
          headers: { "Message-ID": messageIdFor(outbox.deduplicationKey) },
        });
      } catch (error: any) {
        const attempts = Number(providerAttempt.attempts ?? 1);
        if (knownNotSent(error)) {
          await WaitlistEmailOutboxModel.updateOne(
            { _id: outbox._id, status: "sending", claimToken },
            {
              $set: {
                status: "failed",
                claimToken: "",
                claimExpiresAt: null,
                providerAttemptStartedAt: null,
                nextAttemptAt:
                  attempts < MAX_ATTEMPTS
                    ? new Date(
                        Date.now() + Math.min(60, 2 ** attempts) * 60_000,
                      )
                    : null,
                lastError: String(error?.message ?? "Email rejected").slice(
                  0,
                  3000,
                ),
              },
            },
          ).exec();
        } else {
          await WaitlistEmailOutboxModel.updateOne(
            { _id: outbox._id, status: "sending", claimToken },
            {
              $set: {
                status: "ambiguous",
                claimToken: "",
                claimExpiresAt: null,
                nextAttemptAt: null,
                lastError:
                  "Email provider outcome is unknown; reconcile the stable Message-ID before retrying.",
              },
            },
          ).exec();
        }
        continue;
      }

      const recorded = await WaitlistEmailOutboxModel.updateOne(
        { _id: outbox._id, status: "sending", claimToken },
        {
          $set: {
            status: "sent",
            sentAt: new Date(),
            providerMessageId: String(info?.providerMessageId ?? "").slice(0, 500),
            claimToken: "",
            claimExpiresAt: null,
            nextAttemptAt: null,
            lastError: "",
          },
        },
      ).exec();
      if (recorded.modifiedCount !== 1) {
        await WaitlistEmailOutboxModel.updateOne(
          { _id: outbox._id, status: "sending", claimToken },
          {
            $set: {
              status: "ambiguous",
              nextAttemptAt: null,
              lastError:
                "SMTP accepted the message but the sent state could not be recorded.",
            },
          },
        ).exec();
      } else {
        sent += 1;
      }
    } catch (error) {
      logger.error(
        { err: error, waitlistEmailOutboxId: String(outbox._id) },
        "Waitlist email outbox processing failed.",
      );
      await WaitlistEmailOutboxModel.updateOne(
        {
          _id: outbox._id,
          status: "sending",
          claimToken,
          providerAttemptStartedAt: null,
        },
        {
          $set: {
            status: "failed",
            claimToken: "",
            claimExpiresAt: null,
            nextAttemptAt: new Date(Date.now() + 5 * 60_000),
            lastError: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 3000),
          },
        },
      ).exec();
    }
  }

  return sent;
};

export const waitlistEmailInternals = {
  messageIdFor,
  knownNotSent,
  recoverStaleClaims,
};
