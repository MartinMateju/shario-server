import type { HydratedDocument, Model, Types } from "mongoose";

import type {
  CommunicationAutomationStatus,
  CommunicationConnectedProductType,
  CommunicationDayOfWeek,
  CommunicationContentLocale,
  CommunicationAutomationPurpose,
  CommunicationScheduleType,
} from "./communication-automation.constants.js";
import type { EmailTemplateFormat } from "@/modules/email-template/email-template.constants.js";

export type CommunicationRecipient = {
  user?: Types.ObjectId | null;
  email?: string;
  customId?: string;
  name?: string;
  locale?: CommunicationContentLocale;
};

export type CommunicationContentVariant = {
  subject: string;
  htmlContent: string;
  body?: string;
  format?: EmailTemplateFormat;
};

export type CommunicationAutomationEntity = {
  tenant: Types.ObjectId;
  name: string;
  scheduleType: CommunicationScheduleType;
  connectedProductType: CommunicationConnectedProductType;
  automationStatus: CommunicationAutomationStatus;
  minutesOffset: number;
  sendTime: string;
  oneTimeSendAt?: Date | null;
  dayOfWeek: CommunicationDayOfWeek;
  dayOfMonth: number;
  senderEmail: Types.ObjectId;
  sendToAllRecipients: boolean;
  recipients: CommunicationRecipient[];
  subject: string;
  htmlContent: string;
  body: string;
  format: EmailTemplateFormat;
  contentVariants?: Partial<Record<CommunicationContentLocale, CommunicationContentVariant>>;
  defaultLocale: CommunicationContentLocale;
  purpose: CommunicationAutomationPurpose;
  templateId?: Types.ObjectId | null;
  respectQuietHours: boolean;
  cancelOnReschedule: boolean;
  isActive: boolean;
  location?: Types.ObjectId | null;
  appliesToAllLocations: boolean;
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
  lastScheduledFor?: Date | null;
  runClaimedUntil?: Date | null;
  runClaimToken?: string;
  runSequence: number;
  activatedAt?: Date | null;
  deactivatedAt?: Date | null;
  failedAt?: Date | null;
  errorMessage: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type CommunicationAutomationDocument =
  HydratedDocument<CommunicationAutomationEntity>;

export type CommunicationAutomationModel = Model<CommunicationAutomationEntity>;

export type CommunicationAutomationListFilters = {
  tenantId: string;
  allowedLocationIds?: readonly string[] | null;
  page?: number;
  limit?: number;
  search?: string;
  scheduleType?: CommunicationScheduleType;
  connectedProductType?: CommunicationConnectedProductType;
  automationStatus?: CommunicationAutomationStatus;
  isActive?: boolean;
  senderEmail?: string;
};
