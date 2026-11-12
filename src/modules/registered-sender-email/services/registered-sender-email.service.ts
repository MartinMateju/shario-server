import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import {
  sendManagedTenantEmail,
  sendSystemPostmarkEmail,
} from "@/infrastructure/email/managed-email.service.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import {
  MANAGED_SENDER_PROVISIONING_ERROR_CODE_REGEX,
  MANAGED_SENDER_PROVISIONING_ERROR_FALLBACK,
} from "../registered-sender-email.constants.js";
import { registeredSenderEmailRepository } from "../registered-sender-email.repository.js";
import { sanitizeRegisteredSenderEmail } from "../registered-sender-email.utils.js";
import type {
  ConfirmReplyToVerificationInput,
  CreateRegisteredSenderEmailInput,
  ListRegisteredSenderEmailsInput,
  UpdateRegisteredSenderEmailInput,
} from "../registered-sender-email.validators.js";
import {
  buildManagedSenderEmail,
  configureStoredManagedTenantWebhook,
  provisionManagedTenantServer,
} from "./postmark-provisioning.service.js";

const verificationTtlSeconds = () =>
  Math.max(
    300,
    Math.min(
      86_400,
      Number(process.env.REPLY_TO_VERIFICATION_TTL_SECONDS || 900),
    ),
  );
const verificationResendSeconds = () =>
  Math.max(
    30,
    Math.min(
      3_600,
      Number(process.env.REPLY_TO_VERIFICATION_RESEND_SECONDS || 60),
    ),
  );
const verificationMaximumAttempts = () =>
  Math.max(
    1,
    Math.min(10, Number(process.env.REPLY_TO_VERIFICATION_MAX_ATTEMPTS || 5)),
  );

const verificationHash = ({
  senderEmailId,
  pendingReplyToEmail,
  code,
}: {
  senderEmailId: string;
  pendingReplyToEmail: string;
  code: string;
}) => {
  const pepper = String(process.env.EMAIL_SECRET_KEY || "");
  if (!pepper) {
    throw new Error("EMAIL_SECRET_KEY is required for Reply-To verification.");
  }
  return createHmac("sha256", pepper)
    .update(`${senderEmailId}\n${pendingReplyToEmail}\n${code}`, "utf8")
    .digest("hex");
};

const equalHash = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

const provisioningErrorCode = (error: unknown): string => {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  return (candidate.startsWith("POSTMARK_") ||
    candidate.startsWith("MANAGED_EMAIL_")) &&
    MANAGED_SENDER_PROVISIONING_ERROR_CODE_REGEX.test(candidate)
    ? candidate
    : MANAGED_SENDER_PROVISIONING_ERROR_FALLBACK;
};

const provisioningSuperseded = () =>
  Object.assign(
    new Error("A newer managed email provisioning attempt replaced this one."),
    { code: "MANAGED_EMAIL_PROVISIONING_SUPERSEDED" },
  );

const provisionIfNeeded = async (
  tenantId: string,
  sender: Awaited<
    ReturnType<typeof registeredSenderEmailRepository.findManagedWithSecrets>
  >,
) => {
  if (!sender) {
    throw new Error("Managed sender disappeared during provisioning.");
  }

  const attempt = { id: randomUUID(), at: new Date() };
  let pending =
    await registeredSenderEmailRepository.beginPostmarkProvisioning(
      sender,
      attempt,
    );
  if (!pending) throw provisioningSuperseded();

  try {
    if (!pending.providerServerId || !pending.encryptedPostmarkServerToken) {
      const binding = await provisionManagedTenantServer(tenantId);
      const bound =
        await registeredSenderEmailRepository.bindPostmarkServerPending(
          pending,
          attempt.id,
          binding,
        );
      if (!bound) throw provisioningSuperseded();
      pending = bound;
    }

    await configureStoredManagedTenantWebhook(
      String(pending.encryptedPostmarkServerToken),
      attempt.id,
    );
    const ready = await registeredSenderEmailRepository.markPostmarkServerReady(
      pending,
      attempt.id,
      new Date(),
    );
    if (!ready) throw provisioningSuperseded();
    return ready;
  } catch (error) {
    await registeredSenderEmailRepository.markProvisioningFailure(
      tenantId,
      String(pending._id),
      attempt.id,
      {
        message:
          error instanceof Error
            ? error.message
            : "Postmark provisioning failed.",
        code: provisioningErrorCode(error),
        attemptedAt: attempt.at,
      },
    );
    throw error;
  }
};

export const registeredSenderEmailService = {
  async list(tenantId: string, input: ListRegisteredSenderEmailsInput) {
    const emails = await registeredSenderEmailRepository.list({
      tenantId,
      search: input.search,
      isActive: input.isActive,
    });
    const bindingMap =
      await registeredSenderEmailRepository.getAutomationCountMap(
        tenantId,
        emails.map((item) => item._id),
      );
    return emails.map((item) => ({
      ...sanitizeRegisteredSenderEmail(item),
      automationCount: bindingMap[String(item._id)] || 0,
    }));
  },

  async createOrReactivate(
    tenantId: string,
    createdBy: string,
    input: CreateRegisteredSenderEmailInput,
  ) {
    let sender =
      await registeredSenderEmailRepository.findManagedWithSecrets(tenantId);
    if (sender) {
      if (!sender.isActive) {
        sender =
          await registeredSenderEmailRepository.reactivateManaged(sender);
      }
      sender = await registeredSenderEmailRepository.updateManaged(
        sender,
        input,
      );
      sender = await provisionIfNeeded(tenantId, sender);
      await registeredSenderEmailRepository.rebindTenantAutomationsToManaged(
        tenantId,
        String(sender._id),
      );
      return sanitizeRegisteredSenderEmail(sender);
    }

    try {
      sender = await registeredSenderEmailRepository.createManagedProvisioning(
        tenantId,
        createdBy,
        buildManagedSenderEmail(tenantId),
        input,
      );
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      sender =
        await registeredSenderEmailRepository.findManagedWithSecrets(tenantId);
      if (!sender) conflict("Managed sender identity already exists.");
      sender = await registeredSenderEmailRepository.updateManaged(
        sender,
        input,
      );
    }
    sender = await provisionIfNeeded(tenantId, sender);
    await registeredSenderEmailRepository.rebindTenantAutomationsToManaged(
      tenantId,
      String(sender._id),
    );
    return sanitizeRegisteredSenderEmail(sender);
  },

  async update(
    tenantId: string,
    senderEmailId: string,
    input: UpdateRegisteredSenderEmailInput,
  ) {
    const existing = await registeredSenderEmailRepository.findByIdWithSecrets(
      tenantId,
      senderEmailId,
    );
    if (!existing) notFound("Managed sender identity not found.");
    let updated = await registeredSenderEmailRepository.updateManaged(
      existing,
      input,
    );
    if (
      updated.providerProvisioningStatus !== "ready" ||
      !updated.providerServerId ||
      !updated.providerProvisionedAt ||
      !updated.encryptedPostmarkServerToken
    ) {
      updated = await provisionIfNeeded(tenantId, updated);
    }
    return sanitizeRegisteredSenderEmail(updated);
  },

  async getDetails(tenantId: string, senderEmailId: string) {
    const sender = await registeredSenderEmailRepository.findByIdForTenant(
      tenantId,
      senderEmailId,
    );
    if (!sender) notFound("Managed sender identity not found.");
    const automations =
      await registeredSenderEmailRepository.listActiveAutomationBindings(
        tenantId,
        senderEmailId,
      );
    return { ...sanitizeRegisteredSenderEmail(sender), automations };
  },

  async requestReplyToVerification(tenantId: string, senderEmailId: string) {
    const sender = await registeredSenderEmailRepository.findByIdWithSecrets(
      tenantId,
      senderEmailId,
    );
    if (!sender) notFound("Managed sender identity not found.");
    if (!sender.isActive)
      badRequest("Inactive sender identity cannot be verified.");
    const pendingReplyToEmail = String(sender.pendingReplyToEmail || "")
      .trim()
      .toLowerCase();
    if (!pendingReplyToEmail) {
      badRequest("Set a new Reply-To address before requesting a code.");
    }
    const now = new Date();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const codeHash = verificationHash({
      senderEmailId,
      pendingReplyToEmail,
      code,
    });
    const armed = await registeredSenderEmailRepository.armReplyToVerification({
      tenantId,
      id: senderEmailId,
      pendingReplyToEmail,
      codeHash,
      sentAt: now,
      expiresAt: new Date(now.getTime() + verificationTtlSeconds() * 1_000),
      notSentAfter: new Date(
        now.getTime() - verificationResendSeconds() * 1_000,
      ),
    });
    if (!armed) {
      badRequest("Wait before requesting another verification code.");
    }
    try {
      await sendSystemPostmarkEmail({
        to: pendingReplyToEmail,
        subject: "Verify your shario.io Reply-To address",
        text:
          `Your shario.io verification code is ${code}.\n\n` +
          `It expires in ${Math.ceil(verificationTtlSeconds() / 60)} minutes. ` +
          "If you did not request this, you can ignore this email.",
        metadata: {
          purpose: "reply-to-verification",
          tenantId,
          managedSenderId: senderEmailId,
        },
      });
    } catch (error) {
      await registeredSenderEmailRepository.clearReplyToVerification(
        tenantId,
        senderEmailId,
        codeHash,
      );
      throw error;
    }
    return {
      message: "Verification code sent.",
      senderEmail: sanitizeRegisteredSenderEmail(armed),
    };
  },

  async confirmReplyToVerification(
    tenantId: string,
    senderEmailId: string,
    input: ConfirmReplyToVerificationInput,
  ) {
    const sender = await registeredSenderEmailRepository.findByIdWithSecrets(
      tenantId,
      senderEmailId,
    );
    if (!sender) notFound("Managed sender identity not found.");
    const pendingReplyToEmail = String(sender.pendingReplyToEmail || "")
      .trim()
      .toLowerCase();
    const storedHash = String(sender.replyToVerificationCodeHash || "");
    const expiresAt = sender.replyToVerificationExpiresAt
      ? new Date(sender.replyToVerificationExpiresAt)
      : null;
    const maximumAttempts = verificationMaximumAttempts();
    if (
      !pendingReplyToEmail ||
      !storedHash ||
      !expiresAt ||
      expiresAt.getTime() <= Date.now() ||
      Number(sender.replyToVerificationAttempts || 0) >= maximumAttempts
    ) {
      badRequest("The verification code is invalid or expired.");
    }
    const submittedHash = verificationHash({
      senderEmailId,
      pendingReplyToEmail,
      code: input.code,
    });
    if (!equalHash(storedHash, submittedHash)) {
      await registeredSenderEmailRepository.recordFailedReplyToVerification({
        tenantId,
        id: senderEmailId,
        pendingReplyToEmail,
        codeHash: storedHash,
        maximumAttempts,
      });
      badRequest("The verification code is invalid or expired.");
    }
    const verified =
      await registeredSenderEmailRepository.consumeReplyToVerification({
        tenantId,
        id: senderEmailId,
        pendingReplyToEmail,
        codeHash: storedHash,
        maximumAttempts,
        now: new Date(),
      });
    if (!verified) badRequest("The verification code is invalid or expired.");
    return {
      message: "Reply-To address verified.",
      senderEmail: sanitizeRegisteredSenderEmail(verified),
    };
  },

  async test(tenantId: string, senderEmailId: string) {
    const sender = await registeredSenderEmailRepository.findByIdWithSecrets(
      tenantId,
      senderEmailId,
    );
    if (!sender) notFound("Managed sender identity not found.");
    if (!sender.replyToEmail || !sender.replyToVerifiedAt) {
      badRequest("Verify the Reply-To address before sending a test email.");
    }
    const delivery = await sendManagedTenantEmail({
      tenantId,
      senderEmailId,
      to: String(sender.replyToEmail),
      subject: "Your shario.io managed email is ready",
      text: "This test confirms that shario.io can send through your isolated Postmark Server.",
      idempotencyKey: `managed-email-test:${senderEmailId}:${Date.now()}`,
    });
    const persisted =
      await registeredSenderEmailRepository.recordManagedTestAccepted({
        tenantId,
        id: senderEmailId,
        recipientEmail: String(sender.replyToEmail).trim().toLowerCase(),
        providerMessageId: delivery.providerMessageId,
        acceptedAt: new Date(),
      });
    if (!persisted) {
      throw Object.assign(
        new Error(
          "Postmark accepted the test email, but its delivery correlation could not be persisted.",
        ),
        {
          code: "MANAGED_EMAIL_TEST_CORRELATION_FAILED",
          deliveryOutcome: "ambiguous",
        },
      );
    }
    return {
      message:
        "Postmark accepted the test email for the verified Reply-To address.",
      providerMessageId: delivery.providerMessageId,
      senderEmail: sanitizeRegisteredSenderEmail(persisted),
    };
  },

  async deactivate(tenantId: string, senderEmailId: string) {
    const bindings =
      await registeredSenderEmailRepository.countActiveAutomationBindings(
        tenantId,
        senderEmailId,
      );
    if (bindings > 0) {
      badRequest(
        "This sender cannot be deactivated because active automations use it.",
      );
    }
    const sender = await registeredSenderEmailRepository.deactivate(
      tenantId,
      senderEmailId,
    );
    if (!sender) notFound("Managed sender identity not found.");
    return sanitizeRegisteredSenderEmail(sender);
  },
};
