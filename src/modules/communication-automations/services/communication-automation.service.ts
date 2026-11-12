import mongoose, { type ClientSession } from "mongoose";

import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import { communicationAutomationRepository } from "@/modules/communication-automations/communication-automation.repository.js";
import UserModel from "@/modules/user/user.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  getAutomationCapacity,
  getAutomationLimitBasis,
} from "@/modules/tenants/tenant-plan-usage.js";
import EmailTemplate from "@/modules/email-template/email-template.model.js";
import {
  assertValidEmailTemplateVariables,
  hasDeliverableEmailTemplateContent,
  selectLocalizedEmailContent,
} from "@/modules/email-template/email-template.rendering.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";
import { calculateNextAutomationRun } from "./communication-automation-schedule.service.js";
import { RECURRING_COMMUNICATION_SCHEDULE_TYPES } from "../communication-automation.constants.js";
import {
  BOOKING_COMMUNICATION_SCHEDULE_TYPES,
  COMMUNICATION_AUTOMATION_PURPOSE,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE,
  COMMUNICATION_SCHEDULE_TYPE,
} from "../communication-automation.constants.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import { isCommunicationAutomationLocationScopeValid } from "../communication-automation.utils.js";

const assertValidLocationConfiguration = (
  automation: Record<string, any>,
): void => {
  if (!isCommunicationAutomationLocationScopeValid(automation)) {
    badRequest(
      "A valid location is required when an automation does not apply to all locations.",
    );
  }
};

const assertAutomationWithinLocationScope = (
  automation: { appliesToAllLocations?: boolean; location?: unknown },
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  if (automation.appliesToAllLocations) {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    return;
  }

  assertLocationIdsWithinWorkspaceScope(
    [String((automation.location as any)?._id ?? automation.location ?? "")],
    allowedLocationIds,
  );
};

const assertRecipientUsersBelongToTenant = async (
  tenantId: string,
  recipients: readonly { user?: unknown }[] | undefined,
): Promise<void> => {
  const userIds = [
    ...new Set(
      (recipients ?? [])
        .map((recipient) => String(recipient.user ?? ""))
        .filter(Boolean),
    ),
  ];

  if (!userIds.length) return;

  const count = await UserModel.countDocuments({
    _id: { $in: userIds },
    tenant: tenantId,
    tenantRole: "customer",
    isAccessGranted: { $ne: false },
    email: { $exists: true, $ne: "" },
  }).exec();

  if (count !== userIds.length) {
    badRequest("One or more communication recipients are invalid.");
  }
};

const getReferenceId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

const assertTemplateBelongsToTenant = async (
  tenantId: string,
  templateId: unknown,
): Promise<void> => {
  if (!templateId) return;
  const template = await EmailTemplate.findOne({
    _id: getReferenceId(templateId),
    tenant: tenantId,
    isActive: true,
  }).lean();
  if (!template) {
    badRequest("Selected email template does not exist or is inactive.");
  }
  if (!hasDeliverableEmailTemplateContent(template as any)) {
    badRequest(
      "Selected email template must be an active content template with a complete localized message.",
    );
  }
};

const assertAutomationPlanLimit = async (
  tenantId: string,
  session: ClientSession,
  action: "create_definition" | "activate",
): Promise<void> => {
  const tenantQuery = TenantModel.findById(tenantId).select(
    "plan planVersion limits.monthlyAutomations",
  );
  tenantQuery.session(session);
  const tenant = await tenantQuery.lean();

  if (!tenant) {
    notFound("Tenant not found.");
  }

  const limitBasis = getAutomationLimitBasis(tenant.planVersion ?? 1);
  if (
    limitBasis === "none" ||
    (limitBasis === "definitions" && action !== "create_definition") ||
    (limitBasis === "active" && action !== "activate")
  ) {
    return;
  }

  const automationLimit = Math.max(
    Number(tenant.limits?.monthlyAutomations ?? 0),
    0,
  );
  const automationCount =
    await communicationAutomationRepository.countForTenant(tenantId, {
      session,
      activeOnly: limitBasis === "active",
    });
  const capacity = getAutomationCapacity({
    planVersion: tenant.planVersion,
    current: automationCount,
    limit: automationLimit,
  });

  if (capacity.reached) {
    conflict({
      message: "Your current plan has reached its custom automation limit.",
      code: "AUTOMATION_LIMIT_REACHED",
      details: {
        automationCount: capacity.current,
        automationLimit: capacity.limit,
        limitBasis,
        plan: tenant.plan,
        planVersion: tenant.planVersion,
        upgradeRequired: true,
      },
    });
  }
};

const AUTOMATION_SCHEDULE_FIELDS = new Set([
  "scheduleType",
  "sendTime",
  "oneTimeSendAt",
  "dayOfWeek",
  "dayOfMonth",
  "minutesOffset",
  "connectedProductType",
]);

const scheduleFieldValue = (field: string, value: unknown): unknown => {
  if (field === "oneTimeSendAt") {
    return value == null ? null : new Date(value as Date | string).getTime();
  }
  return value;
};

const ACTIVE_DELIVERY_FIELDS = new Set([
  "senderEmail",
  "templateId",
  "subject",
  "htmlContent",
  "body",
  "format",
  "contentVariants",
  "defaultLocale",
  "recipients",
  "sendToAllRecipients",
  "purpose",
  "location",
  "appliesToAllLocations",
  "respectQuietHours",
  "cancelOnReschedule",
]);

const assertSupportedTriggerConfiguration = (
  automation: Record<string, any>,
): void => {
  if (automation.purpose === COMMUNICATION_AUTOMATION_PURPOSE.MARKETING) {
    badRequest(
      "Marketing automations are unavailable until customer unsubscribe management is enabled.",
    );
  }
  if (
    automation.appliesToAllLocations === false &&
    (RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(automation.scheduleType) ||
      automation.scheduleType ===
        COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION)
  ) {
    badRequest(
      "Broadcast and registration automations must apply to all locations.",
    );
  }
  if (["afterItemRegistered", "afterBisqueFiring", "afterFinalFiring"].includes(automation.scheduleType) || automation.connectedProductType === "pottery-item") {
    badRequest("This automation type is not available in Shario.");
  }
  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.PASSWORD_RESET) {
    badRequest(
      "Password reset delivery is managed by authentication and cannot be activated as an automation.",
    );
  }
  if (
    automation.scheduleType ===
      COMMUNICATION_SCHEDULE_TYPE.AFTER_BISQUE_FIRING ||
    automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_FINAL_FIRING
  ) {
    badRequest(
      "Firing notifications are managed by the grouped firing workflow and cannot be activated as per-item automations.",
    );
  }
  const bookingProductTypes = new Set<string>([
    COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL,
    COMMUNICATION_CONNECTED_PRODUCT_TYPE.BOOKING,
    COMMUNICATION_CONNECTED_PRODUCT_TYPE.WORKSHOP,
    COMMUNICATION_CONNECTED_PRODUCT_TYPE.COURSE,
    COMMUNICATION_CONNECTED_PRODUCT_TYPE.PRIVATE_SESSION,
  ]);
  if (
    BOOKING_COMMUNICATION_SCHEDULE_TYPES.has(automation.scheduleType) &&
    !bookingProductTypes.has(automation.connectedProductType)
  ) {
    badRequest("This product type is not supported by booking automations.");
  }
  const potteryEvents = new Set<string>([
    COMMUNICATION_SCHEDULE_TYPE.AFTER_ITEM_REGISTERED,
    COMMUNICATION_SCHEDULE_TYPE.AFTER_BISQUE_FIRING,
    COMMUNICATION_SCHEDULE_TYPE.AFTER_FINAL_FIRING,
  ]);
  if (
    potteryEvents.has(automation.scheduleType) &&
    ![
      COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL,
      COMMUNICATION_CONNECTED_PRODUCT_TYPE.POTTERY_ITEM,
    ].includes(automation.connectedProductType)
  ) {
    badRequest(
      "Pottery event automations support only all products or pottery items.",
    );
  }
  if (
    automation.scheduleType ===
      COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION &&
    automation.connectedProductType !== COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL
  ) {
    badRequest("Registration automations must apply to all products.");
  }
};

const assertAutomationCanActivate = async (
  tenantId: string,
  automation: Record<string, any>,
): Promise<void> => {
  assertSupportedTriggerConfiguration(automation);
  const senderId = getReferenceId(automation.senderEmail);
  if (
    !senderId ||
    !(await communicationAutomationRepository.readySenderEmailExists(
      tenantId,
      senderId,
    ))
  ) {
    badRequest(
      "Test the selected sender email successfully before activating this automation.",
    );
  }

  await assertTemplateBelongsToTenant(tenantId, automation.templateId);
  const selected = selectLocalizedEmailContent(
    automation,
    automation.defaultLocale,
  );
  if (!automation.templateId && (!selected.subject || !selected.htmlContent)) {
    badRequest(
      "Automation subject and email content are required before activation.",
    );
  }
  assertValidEmailTemplateVariables(
    automation.subject,
    automation.htmlContent,
    automation.body,
    ...Object.values(automation.contentVariants || {}).flatMap(
      (variant: any) => [variant?.subject, variant?.htmlContent, variant?.body],
    ),
  );

  if (
    RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(automation.scheduleType) &&
    !automation.sendToAllRecipients &&
    !(automation.recipients || []).length
  ) {
    badRequest("At least one recipient is required before activation.");
  }
};

export const communicationAutomationService = {
  async list(
    filters: Parameters<typeof communicationAutomationRepository.list>[0],
  ) {
    const [automations, totalCount] = await Promise.all([
      communicationAutomationRepository.list(filters),
      communicationAutomationRepository.count(filters),
    ]);

    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);

    return {
      automations,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: page,
      pageSize: limit,
    };
  },

  async findById(tenantId: string, automationId: string) {
    const automation =
      await communicationAutomationRepository.findByIdForTenant(
        tenantId,
        automationId,
      );

    if (!automation) {
      notFound("Automation not found.");
    }

    return automation;
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: Parameters<typeof communicationAutomationRepository.create>[2],
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    assertValidLocationConfiguration(input as Record<string, any>);
    assertSupportedTriggerConfiguration(input as Record<string, any>);
    if (input.appliesToAllLocations) {
      assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    } else if (input.location) {
      await assertTenantLocationsWithinWorkspaceScope({
        tenantId,
        locationIds: [input.location],
        allowedLocationIds,
      });
    }

    await assertRecipientUsersBelongToTenant(tenantId, input.recipients);

    await assertTemplateBelongsToTenant(tenantId, input.templateId);

    const senderExists =
      await communicationAutomationRepository.activeSenderEmailExists(
        tenantId,
        input.senderEmail,
      );

    if (!senderExists) {
      badRequest("Selected sender email does not exist or is inactive.");
    }

    const session = await mongoose.startSession();
    let created: Awaited<
      ReturnType<typeof communicationAutomationRepository.create>
    > | null = null;

    try {
      await session.withTransaction(async () => {
        // A write to the tenant row serializes plan-slot allocation for this
        // workspace. The driver retries transient write conflicts, so two V2
        // creates cannot both consume the final definition slot.
        const lockedTenant = await TenantModel.findOneAndUpdate(
          { _id: tenantId },
          { $set: { updatedAt: new Date() } },
          { session, returnDocument: "after" },
        )
          .select("_id")
          .lean();

        if (!lockedTenant) notFound("Tenant not found.");

        await assertAutomationPlanLimit(tenantId, session, "create_definition");
        created = await communicationAutomationRepository.create(
          tenantId,
          createdBy,
          input,
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    if (!created) {
      throw new Error("Automation creation transaction did not commit.");
    }

    return created;
  },

  async update(
    tenantId: string,
    input: Parameters<typeof communicationAutomationRepository.update>[1],
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    let updated: Awaited<
      ReturnType<typeof communicationAutomationRepository.update>
    > = null;
    let deactivated = false;
    let rescheduled = false;
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        // Every edit takes the tenant write lock. This serializes definition
        // edits with activation, so validation, slot allocation and the final
        // update all use the same current automation state.
        const lockedTenant = await TenantModel.findOneAndUpdate(
          { _id: tenantId },
          { $set: { updatedAt: new Date() } },
          { session, returnDocument: "after" },
        )
          .select("_id settings.timezone")
          .lean();

        if (!lockedTenant) notFound("Tenant not found.");

        const current =
          await communicationAutomationRepository.findByIdForTenant(
            tenantId,
            input.id,
            { session },
          );
        if (!current) notFound("Automation not found.");

        assertAutomationWithinLocationScope(current, allowedLocationIds);

        const transactionInput = { ...input } as typeof input &
          Record<string, any>;

        if (transactionInput.appliesToAllLocations === true) {
          assertCanAccessAllWorkspaceLocations(allowedLocationIds);
        } else if (transactionInput.location) {
          await assertTenantLocationsWithinWorkspaceScope({
            tenantId,
            locationIds: [transactionInput.location],
            allowedLocationIds,
          });
        }

        await assertRecipientUsersBelongToTenant(
          tenantId,
          transactionInput.recipients,
        );

        if (transactionInput.templateId !== undefined) {
          await assertTemplateBelongsToTenant(
            tenantId,
            transactionInput.templateId,
          );
        }

        if (transactionInput.senderEmail) {
          const senderExists =
            await communicationAutomationRepository.activeSenderEmailExists(
              tenantId,
              transactionInput.senderEmail,
            );

          if (!senderExists) {
            badRequest("Selected sender email does not exist or is inactive.");
          }
        }

        const merged = {
          ...(typeof current.toObject === "function"
            ? current.toObject()
            : current),
          ...transactionInput,
          recipients:
            transactionInput.recipients !== undefined
              ? transactionInput.recipients
              : current.recipients,
          senderEmail: transactionInput.senderEmail || current.senderEmail,
          templateId:
            transactionInput.templateId !== undefined
              ? transactionInput.templateId
              : current.templateId,
        } as Record<string, any>;

        assertValidLocationConfiguration(merged);

        if (transactionInput.isActive !== false) {
          assertSupportedTriggerConfiguration(merged);
        }

        const activating =
          transactionInput.isActive === true && !current.isActive;
        const scheduleChanged = Object.keys(transactionInput).some(
          (field) =>
            AUTOMATION_SCHEDULE_FIELDS.has(field) &&
            scheduleFieldValue(field, transactionInput[field]) !==
              scheduleFieldValue(field, (current as Record<string, any>)[field]),
        );
        const reschedulingActiveAutomation =
          current.isActive &&
          transactionInput.isActive !== false &&
          scheduleChanged;
        const revalidatingActiveAutomation =
          current.isActive &&
          transactionInput.isActive !== false &&
          Object.keys(transactionInput).some((field) =>
            ACTIVE_DELIVERY_FIELDS.has(field),
          );

        if (
          activating ||
          reschedulingActiveAutomation ||
          revalidatingActiveAutomation
        ) {
          await assertAutomationCanActivate(tenantId, merged);
        }

        if (activating || reschedulingActiveAutomation) {
          const nextRunAt = calculateNextAutomationRun(
            merged as any,
            lockedTenant.settings?.timezone || "Europe/Prague",
            new Date(),
          );
          if (
            RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(merged.scheduleType) &&
            !nextRunAt
          ) {
            badRequest(
              "The automation schedule must include a future delivery time.",
            );
          }
          transactionInput.nextRunAt = nextRunAt;
          if (reschedulingActiveAutomation) {
            transactionInput.lastRunAt = new Date();
            transactionInput.runClaimedUntil = null;
            transactionInput.runClaimToken = "";
          }
        }

        if (transactionInput.isActive === false) {
          transactionInput.nextRunAt = null;
          transactionInput.runClaimedUntil = null;
          transactionInput.runClaimToken = "";
        }

        if (activating) {
          await assertAutomationPlanLimit(tenantId, session, "activate");
        }

        updated = await communicationAutomationRepository.update(
          tenantId,
          transactionInput,
          { session, existing: current },
        );
        deactivated = transactionInput.isActive === false && current.isActive;
        rescheduled = reschedulingActiveAutomation;
      });
    } finally {
      await session.endSession();
    }

    if (!updated) {
      notFound("Automation not found.");
    }

    if (deactivated) {
      await communicationEmailLogRepository.cancelPendingForAutomation(
        tenantId,
        input.id,
        "Automation was deactivated.",
      );
    }
    if (rescheduled) {
      await communicationEmailLogRepository.cancelPendingForAutomation(
        tenantId,
        input.id,
        "Automation schedule changed.",
      );
    }

    return updated;
  },

  async delete(
    tenantId: string,
    automationId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existing = await communicationAutomationRepository.findByIdForTenant(
      tenantId,
      automationId,
    );

    if (!existing) {
      notFound("Automation not found.");
    }

    assertAutomationWithinLocationScope(existing, allowedLocationIds);

    if (existing.isActive) {
      badRequest("Deactivate the automation before deleting it.");
    }

    await communicationEmailLogRepository.cancelPendingForAutomation(
      tenantId,
      automationId,
      "Automation was deleted.",
    );

    const deleted = await communicationAutomationRepository.delete(
      tenantId,
      automationId,
    );

    if (!deleted) {
      notFound("Automation not found.");
    }

    return {
      message: "Automation deleted.",
    };
  },

  async markFailed(
    tenantId: string,
    automationId: string,
    errorMessage: string,
  ) {
    return communicationAutomationRepository.markFailed(
      tenantId,
      automationId,
      errorMessage,
    );
  },
};
