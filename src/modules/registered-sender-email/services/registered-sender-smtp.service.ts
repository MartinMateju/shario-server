import nodemailer from "nodemailer";

import type { RegisteredSenderEmailDocument } from "../registered-sender-email.types.js";
import { decryptEmailPassword } from "@/shared/security/encryption.js";
import {
  resolveConfiguredSmtpEndpoint,
  type SmtpDnsLookup,
} from "./smtp-network-policy.js";

const tlsRejectUnauthorized = !(
  process.env.NODE_ENV !== "production" &&
  process.env.EMAIL_ALLOW_SELF_SIGNED === "true"
);

export const buildRegisteredSenderTransporter = async (
  senderEmail: RegisteredSenderEmailDocument,
  lookup?: SmtpDnsLookup,
) => {
  const smtpPassword = decryptEmailPassword(senderEmail.encryptedSmtpPassword);
  const provider = senderEmail.provider || "custom";
  const endpoint = await resolveConfiguredSmtpEndpoint({
    provider,
    hostname: senderEmail.smtpHost,
    port: Number(senderEmail.smtpPort),
    lookup,
  });

  return nodemailer.createTransport({
    host: endpoint.address,
    port: Number(senderEmail.smtpPort),
    secure: Boolean(senderEmail.smtpSecure),
    connectionTimeout: Number(
      process.env.EMAIL_CONNECTION_TIMEOUT_MS || 15_000,
    ),
    greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT_MS || 10_000),
    socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT_MS || 30_000),
    auth: {
      user: senderEmail.smtpUser,
      pass: smtpPassword,
    },
    tls: {
      rejectUnauthorized: tlsRejectUnauthorized,
      ...(endpoint.servername ? { servername: endpoint.servername } : {}),
    },
  });
};

export const verifyRegisteredSenderSmtp = async (
  senderEmail: RegisteredSenderEmailDocument,
): Promise<void> => {
  const transporter = await buildRegisteredSenderTransporter(senderEmail);

  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
};
