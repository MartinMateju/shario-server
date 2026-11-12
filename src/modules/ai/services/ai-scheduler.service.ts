import { logger } from "@/config/logger.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import {
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/index.js";

import { AI_AUDIENCE } from "../ai.constants.js";
import { AiSettingsModel } from "../ai.models.js";
import { resolveAiLocale } from "../ai-locale.js";
import type { AiRequestContext } from "../ai.types.js";
import { resolveAiEntitlement } from "./ai-access.service.js";
import { generateBriefing, getLatestBriefing } from "./briefing.service.js";

const localClock = (date: Date, timezone: string) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value || "";
    return {
      dateKey: `${value("year")}-${value("month")}-${value("day")}`,
      minutes: Number(value("hour")) * 60 + Number(value("minute")),
    };
  } catch {
    return {
      dateKey: date.toISOString().slice(0, 10),
      minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
    };
  }
};

const clockMinutes = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

/** Generates at most one tenant-local briefing per user/scope/day. */
export const generateDueAiBriefings = async (now = new Date()) => {
  const settingsRows = await AiSettingsModel.find({
    enabled: { $ne: false },
    dailyBriefingEnabled: { $ne: false },
  })
    .select("tenant defaultLocale briefingTime")
    .lean();
  let generated = 0;
  let skipped = 0;

  for (const settings of settingsRows) {
    try {
      const entitlement = await resolveAiEntitlement(String(settings.tenant));
      if (
        !entitlement.canUseAi ||
        entitlement.settings.dailyBriefingEnabled === false
      ) {
        skipped += 1;
        continue;
      }
      const timezone = String(entitlement.tenant.settings?.timezone || "UTC");
      const local = localClock(now, timezone);
      if (local.minutes < clockMinutes(settings.briefingTime || "07:30")) {
        skipped += 1;
        continue;
      }
      const memberships = await TenantMembershipModel.find({
        tenant: settings.tenant,
        status: "active",
      })
        .select("user")
        .lean();
      for (const membership of memberships) {
        const userId = String(membership.user);
        try {
          const access = await resolveWorkspaceAccessForUser({
            tenantId: String(settings.tenant),
            userId,
          });
          if (!hasWorkspacePermission(access, WORKSPACE_PERMISSION.AI_USE)) {
            skipped += 1;
            continue;
          }
          const context: AiRequestContext = {
            tenantId: String(settings.tenant),
            userId,
            audience: AI_AUDIENCE.SYSTEM,
            access,
            allowedLocationIds: getAllowedWorkspaceLocationIds(access!),
            locale: resolveAiLocale(
              access?.preferences.language || settings.defaultLocale,
            ),
          };
          const existing = await getLatestBriefing(context, {
            locale: context.locale,
          });
          if (existing) {
            skipped += 1;
            continue;
          }
          await generateBriefing(context, {
            force: false,
            locale: context.locale,
          });
          generated += 1;
        } catch (error) {
          skipped += 1;
          logger.warn(
            { err: error, tenantId: String(settings.tenant), userId },
            "Scheduled AI briefing generation failed for member.",
          );
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, tenantId: String(settings.tenant) },
        "Scheduled AI briefing generation failed for tenant.",
      );
    }
  }
  return { generated, skipped };
};

export const aiSchedulerService = {
  generateDueBriefings: generateDueAiBriefings,
};
