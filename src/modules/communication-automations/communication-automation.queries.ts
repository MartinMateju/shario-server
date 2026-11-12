import type {
  CommunicationAutomationListFilters,
} from "./communication-automation.types.js";
import { toObjectId } from "./communication-automation.utils.js";

type CommunicationAutomationQuery = Record<string, unknown>;

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

export const buildCommunicationAutomationListQuery = (
  filters: CommunicationAutomationListFilters,
): CommunicationAutomationQuery => {
  const query: CommunicationAutomationQuery = {
    tenant: toObjectId(filters.tenantId),
  };

  if (filters.allowedLocationIds !== null && filters.allowedLocationIds !== undefined) {
    query.location = { $in: filters.allowedLocationIds.map(toObjectId) };
    query.appliesToAllLocations = false;
  }

  if (filters.scheduleType) {
    query.scheduleType = filters.scheduleType;
  }

  if (filters.connectedProductType) {
    query.connectedProductType = filters.connectedProductType;
  }

  if (filters.automationStatus) {
    query.automationStatus = filters.automationStatus;
  }

  if (typeof filters.isActive === "boolean") {
    query.isActive = filters.isActive;
  }

  if (filters.senderEmail) {
    query.senderEmail = toObjectId(filters.senderEmail);
  }

  if (filters.search) {
    const search = escapeRegex(filters.search.trim());

    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { subject: { $regex: search, $options: "i" } },
      { "recipients.email": { $regex: search, $options: "i" } },
      { "recipients.customId": { $regex: search, $options: "i" } },
    ];
  }

  return query;
};
