import os from "os";
import mongoose from "mongoose";

import {
  COMMUNICATION_CONTENT_LOCALE,
  getCommunicationIntlLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

import {
  ACCESS_CODE_LOCK_OWNER_PREFIX,
  ACCESS_CODE_MAX_ERROR_LENGTH,
} from "./access-code.constants.js";

export const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

export const createAccessCodeLockOwner = (): string => {
  return `${ACCESS_CODE_LOCK_OWNER_PREFIX}:${os.hostname()}:${process.pid}`;
};

export const truncateAccessCodeError = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : String(error || "Unknown error");

  return message.slice(0, ACCESS_CODE_MAX_ERROR_LENGTH);
};

export const formatDateTimeRange = (
  start: Date,
  end: Date,
  timezone: string,
  locale: CommunicationContentLocale = COMMUNICATION_CONTENT_LOCALE.CS,
): string => {
  const intlLocale = getCommunicationIntlLocale(locale);
  const date = new Intl.DateTimeFormat(intlLocale, {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(start);

  const timeFormatter = new Intl.DateTimeFormat(intlLocale, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `${date} ${timeFormatter.format(start)}–${timeFormatter.format(end)}`;
};
