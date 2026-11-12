import { randomUUID } from "node:crypto";
import { Router } from "express";
import mongoose from "mongoose";

import { assertE2ETestMode, isE2ETestMode } from "@/config/e2e-mode.js";
import Booking from "@/modules/booking/booking.model.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import { REGISTERED_SENDER_PROVIDER } from "@/modules/registered-sender-email/registered-sender-email.constants.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { encryptSecret } from "@/shared/security/encryption.js";
import { processBookingLifecycleEmail } from "@/workers/booking-lifecycle-email.processor.js";

// The same fixed, disposable alpha fixture used by e2e-fixtures.ts. No caller
// can choose a tenant, recipient, provider credential or arbitrary email log.
export const E2E_LIFECYCLE_SCOPE = {
  tenant: "100000000000000000000001",
  owner: "200000000000000000000001",
  customer: "200000000000000000000005",
  location: "300000000000000000000001",
  product: "400000000000000000000003",
  sender: "710000000000000000000001",
  recipient: "booking-customer@studio-alpha.test",
} as const;
const STUB_TOKEN = "e2e-postmark-system-server-token";

const assertIsolatedDelivery = () => {
  assertE2ETestMode();
  if (
    !/(^|[-_])(e2e|test)([-_]|$)/.test(mongoose.connection.name || "") ||
    process.env.POSTMARK_API_URL !== "http://127.0.0.1:4100" ||
    process.env.POSTMARK_SYSTEM_SERVER_TOKEN !== STUB_TOKEN ||
    process.env.POSTMARK_FROM_DOMAIN !== "notify.shario.io"
  ) {
    throw new Error(
      "E2E lifecycle delivery requires the isolated database and loopback Postmark stub.",
    );
  }
};

export const createE2EBookingLifecycleRouter = (): Router => {
  assertE2ETestMode();
  const router = Router();
  router.post(
    "/booking-lifecycle-delivery",
    asyncHandler(async (req, res) => {
      if (!isE2ETestMode()) {
        res.status(404).json({ message: "Not found." });
        return;
      }
      if (
        req.get("x-e2e-key") !==
        (process.env.E2E_TEST_KEY?.trim() || "shario-e2e-local-key")
      ) {
        res.status(403).json({ code: "E2E_CONTROL_FORBIDDEN" });
        return;
      }
      assertIsolatedDelivery();
      if (
        !mongoose.isValidObjectId(req.body?.bookingId) ||
        Object.keys(req.body).some((key) => key !== "bookingId")
      ) {
        res.status(400).json({ message: "A fixture booking ID is required." });
        return;
      }
      const bookingId = String(req.body.bookingId);
      const booking = await Booking.exists({
        _id: bookingId,
        tenant: E2E_LIFECYCLE_SCOPE.tenant,
        createdBy: E2E_LIFECYCLE_SCOPE.customer,
        location: E2E_LIFECYCLE_SCOPE.location,
        bookingProduct: E2E_LIFECYCLE_SCOPE.product,
        status: "processed",
        paymentStatus: "CONFIRMED",
      });
      if (!booking) {
        res
          .status(404)
          .json({ message: "Paid local fixture booking not found." });
        return;
      }
      const scope = {
        tenant: E2E_LIFECYCLE_SCOPE.tenant,
        user: E2E_LIFECYCLE_SCOPE.customer,
        relatedEntityId: bookingId,
        relatedEntityType: "booking",
        location: E2E_LIFECYCLE_SCOPE.location,
        recipientEmail: E2E_LIFECYCLE_SCOPE.recipient,
        emailType: "bookingRescheduled" as const,
        purpose: "transactional" as const,
        allowanceClass: "essential_system" as const,
        automation: null,
      };
      const logs = await CommunicationEmailLogModel.find(scope)
        .sort({ createdAt: 1 })
        .limit(21)
        .exec();
      if (logs.length > 20)
        throw new Error("Too many local fixture lifecycle notices.");
      if (logs.length > 0) {
        // Only this local harness seeds an accepted fake managed sender. The real
        // resolver, provider-boundary fencing and sent transition remain intact.
        await RegisteredSenderEmailModel.updateOne(
          { _id: E2E_LIFECYCLE_SCOPE.sender },
          {
            $setOnInsert: {
              tenant: E2E_LIFECYCLE_SCOPE.tenant,
              createdBy: E2E_LIFECYCLE_SCOPE.owner,
              email: "studio-alpha@notify.shario.io",
              displayName: "Studio Alpha",
              replyToEmail: "owner@studio-alpha.test",
              replyToVerifiedAt: new Date(),
              provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
              providerServerId: 900001,
              providerProvisionedAt: new Date(),
              providerProvisioningStatus: "ready",
              encryptedPostmarkServerToken: encryptSecret(STUB_TOKEN),
              isActive: true,
              isDefault: true,
            },
          },
          { upsert: true, runValidators: true },
        );
      }
      for (const candidate of logs) {
        assertIsolatedDelivery();
        const emailLogId = String(candidate._id);
        const jobId = `e2e-booking-${emailLogId}`;
        const claimToken = randomUUID();
        const log = await communicationEmailLogRepository.claimForSending({
          tenantId: E2E_LIFECYCLE_SCOPE.tenant,
          logId: emailLogId,
          jobId,
          claimToken,
        });
        if (!log) continue;
        await processBookingLifecycleEmail({
          tenantId: E2E_LIFECYCLE_SCOPE.tenant,
          emailLogId,
          jobId,
          claimToken,
          log,
        });
      }
      const completed = await CommunicationEmailLogModel.find(scope)
        .sort({ createdAt: 1 })
        .lean()
        .exec();
      res.json({
        bookingId,
        logs: completed.map((log) => ({
          id: String(log._id),
          emailType: log.emailType,
          status: log.status,
          providerMessageId: log.providerMessageId || "",
        })),
      });
    }),
  );
  return router;
};
