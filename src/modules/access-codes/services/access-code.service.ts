import { locationRepository } from "@/modules/location/location.repository.js";
import {
  assertLocationIdsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import {
  ACCESS_CODE_AUDIT_ACTION,
  ACCESS_CODE_SOURCE,
  ACCESS_CODE_STATUS,
  ACCESS_CODE_TYPE,
} from "../access-code.constants.js";
import {
  decryptAccessCode,
  encryptAccessCode,
  fingerprintAccessCode,
  maskAccessCode,
  normalizeAccessCodeValue,
} from "../access-code.crypto.js";
import { accessCodeInventoryRepository as repository } from "../access-code-inventory.repository.js";
import {
  isAccessCodeCurrentlyAvailable,
  serializeAccessCode,
  serializeAccessCodeAuditEvent,
  serializeAccessCodePool,
} from "../access-code.serializer.js";
import type { AccessCodeAuditContext } from "../access-code.types.js";
import {
  bulkAccessCodeRowSchema,
  type BulkAccessCodeRowDto,
  type CreateAccessCodeDto,
  type CreateAccessCodePoolDto,
  type ListAccessCodeAuditDto,
  type ListAccessCodePoolsDto,
  type ListAccessCodesDto,
  type UpdateAccessCodeDto,
  type UpdateAccessCodePoolDto,
} from "../access-code.validators.js";

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000,
  );

const requirePool = async (
  tenantId: string,
  poolId: string,
  allowedLocationIds: AllowedWorkspaceLocationIds,
  requireActive = false,
) => {
  const pool = await repository.findPoolById(tenantId, poolId);
  if (!pool) {
    notFound({
      message: "Access-code pool not found.",
      code: "ACCESS_CODE_POOL_NOT_FOUND",
    });
  }
  assertLocationIdsWithinWorkspaceScope(
    [String(pool.location)],
    allowedLocationIds,
  );
  if (requireActive && !pool.isActive) {
    conflict({
      message: "The access-code pool is archived.",
      code: "ACCESS_CODE_POOL_ARCHIVED",
    });
  }
  return pool;
};

const requireCode = async (
  tenantId: string,
  codeId: string,
  allowedLocationIds: AllowedWorkspaceLocationIds,
  includeSecret = false,
) => {
  const code = await repository.findCodeById(
    tenantId,
    codeId,
    includeSecret,
  );
  if (!code) {
    notFound({
      message: "Access code not found.",
      code: "ACCESS_CODE_NOT_FOUND",
    });
  }
  assertLocationIdsWithinWorkspaceScope(
    [String(code.location)],
    allowedLocationIds,
  );
  return code;
};

const recordAudit = async ({
  tenantId,
  locationId,
  poolId,
  accessCodeId = null,
  context,
  action,
  metadata = {},
}: {
  tenantId: string;
  locationId: string;
  poolId: string;
  accessCodeId?: string | null;
  context: AccessCodeAuditContext;
  action: string;
  metadata?: Record<string, unknown>;
}) =>
  repository.createAuditEvent({
    tenant: tenantId,
    location: locationId,
    pool: poolId,
    accessCode: accessCodeId,
    actor: context.actorId,
    action,
    metadata,
    ipAddress: String(context.ipAddress || "").slice(0, 120),
    userAgent: String(context.userAgent || "").slice(0, 500),
  });

const assertAvailableCodeIsVerified = (
  status: string,
  verifiedAt: Date | null,
): void => {
  if (status === ACCESS_CODE_STATUS.AVAILABLE && !verifiedAt) {
    badRequest({
      message:
        "Confirm that the code is programmed and tested before making it available.",
      code: "ACCESS_CODE_VERIFICATION_REQUIRED",
    });
  }
};

const assertValidity = (
  validFrom: Date | null,
  validUntil: Date | null,
): void => {
  if (
    validFrom &&
    validUntil &&
    validUntil.getTime() <= validFrom.getTime()
  ) {
    badRequest({
      message: "Valid until must be later than valid from.",
      code: "ACCESS_CODE_VALIDITY_INVALID",
    });
  }
};

const assertEmergencySlotAvailable = async ({
  tenantId,
  poolId,
  type,
  status,
  excludeId,
}: {
  tenantId: string;
  poolId: string;
  type: string;
  status: string;
  excludeId?: string;
}): Promise<void> => {
  if (
    type !== ACCESS_CODE_TYPE.EMERGENCY_RESERVE ||
    status === ACCESS_CODE_STATUS.RETIRED
  ) {
    return;
  }
  if (
    await repository.findNonRetiredEmergency(
      tenantId,
      poolId,
      excludeId,
    )
  ) {
    conflict({
      message:
        "This pool already has a non-retired emergency reserve code.",
      code: "ACCESS_CODE_EMERGENCY_RESERVE_EXISTS",
    });
  }
};

const emergencyReserveKey = ({
  tenantId,
  poolId,
  type,
  status,
}: {
  tenantId: string;
  poolId: string;
  type: string;
  status: string;
}): string | null =>
  type === ACCESS_CODE_TYPE.EMERGENCY_RESERVE &&
  status !== ACCESS_CODE_STATUS.RETIRED
    ? `${tenantId}:${poolId}`
    : null;

const normalizedError = (error: unknown) => {
  if (isDuplicateKeyError(error)) {
    return {
      code: "ACCESS_CODE_DUPLICATE",
      message:
        "This pool already contains the same code or an emergency reserve.",
    };
  }
  const candidate = error as {
    code?: string;
    message?: string;
    issues?: unknown;
  };
  return {
    code: candidate?.code || "ACCESS_CODE_IMPORT_ROW_INVALID",
    message: candidate?.message || "The access-code row is invalid.",
    ...(candidate?.issues ? { details: candidate.issues } : {}),
  };
};

const summarizePools = async (tenantId: string, pools: any[]) => {
  const now = new Date();
  const expiringBefore = new Date(now.getTime() + 7 * 86_400_000);
  const codes = await repository.listPoolSummaryCodes(
    tenantId,
    pools.map((pool) => String(pool._id)),
  );

  return pools.map((pool) => {
    const poolCodes = codes.filter(
      (code) => String(code.pool) === String(pool._id),
    );
    const current = poolCodes.filter((code) =>
      isAccessCodeCurrentlyAvailable(code, now),
    );
    const available = current.filter(
      (code) => code.type === ACCESS_CODE_TYPE.SINGLE_BOOKING,
    ).length;
    const reusable = current.filter(
      (code) => code.type === ACCESS_CODE_TYPE.REUSABLE,
    ).length;
    const emergency = current.filter(
      (code) => code.type === ACCESS_CODE_TYPE.EMERGENCY_RESERVE,
    ).length;
    const expiring = current.filter((code) => {
      const until = code.validUntil ? new Date(code.validUntil) : null;
      return Boolean(
        until &&
          until.getTime() > now.getTime() &&
          until.getTime() <= expiringBefore.getTime(),
      );
    }).length;
    const threshold = Number(pool.lowStockThreshold || 0);
    const severity =
      available === 0
        ? "critical"
        : available <= threshold
          ? "warning"
          : "ok";

    return {
      ...serializeAccessCodePool(pool),
      counts: {
        total: poolCodes.length,
        available,
        reusable,
        expiring,
        emergency,
      },
      totalCount: poolCodes.length,
      availableCount: available,
      reusableCount: reusable,
      expiringCount: expiring,
      emergencyCount: emergency,
      lowStock: severity !== "ok",
      severity,
    };
  });
};

export const accessCodeService = {
  async listPools(
    tenantId: string,
    filters: ListAccessCodePoolsDto,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (filters.locationId) {
      assertLocationIdsWithinWorkspaceScope(
        [filters.locationId],
        allowedLocationIds,
      );
    }
    const pools = await repository.listPools(
      tenantId,
      filters,
      allowedLocationIds,
    );
    return { pools: await summarizePools(tenantId, pools) };
  },

  async createPool(
    tenantId: string,
    input: CreateAccessCodePoolDto,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    assertLocationIdsWithinWorkspaceScope(
      [input.locationId],
      allowedLocationIds,
    );
    const location = await locationRepository.findByIdForTenant(
      tenantId,
      input.locationId,
    );
    if (!location?.isActive) {
      badRequest({
        message: "Studio location is not available.",
        code: "ACCESS_CODE_LOCATION_UNAVAILABLE",
      });
    }

    try {
      const pool = await repository.createPool(tenantId, {
        location: input.locationId,
        name: input.name,
        normalizedName: input.name.trim().toLocaleLowerCase(),
        lowStockThreshold: input.lowStockThreshold,
        createdBy: context.actorId,
        updatedBy: context.actorId,
      });
      await recordAudit({
        tenantId,
        locationId: input.locationId,
        poolId: String(pool._id),
        context,
        action: ACCESS_CODE_AUDIT_ACTION.POOL_CREATED,
        metadata: {
          name: pool.name,
          lowStockThreshold: pool.lowStockThreshold,
        },
      });
      return serializeAccessCodePool(pool);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "An access-code pool with this name already exists.",
          code: "ACCESS_CODE_POOL_NAME_CONFLICT",
        });
      }
      throw error;
    }
  },

  async updatePool(
    tenantId: string,
    input: UpdateAccessCodePoolDto,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const current = await requirePool(
      tenantId,
      input.id,
      allowedLocationIds,
      true,
    );
    try {
      const pool = await repository.updatePool(tenantId, input.id, {
        ...(input.name
          ? {
              name: input.name,
              normalizedName: input.name.trim().toLocaleLowerCase(),
            }
          : {}),
        ...(input.lowStockThreshold !== undefined
          ? { lowStockThreshold: input.lowStockThreshold }
          : {}),
        updatedBy: context.actorId,
      });
      if (!pool) notFound("Access-code pool not found.");

      await recordAudit({
        tenantId,
        locationId: String(pool.location),
        poolId: input.id,
        context,
        action: ACCESS_CODE_AUDIT_ACTION.POOL_UPDATED,
        metadata: {
          before: {
            name: current.name,
            lowStockThreshold: current.lowStockThreshold,
          },
          after: {
            name: pool.name,
            lowStockThreshold: pool.lowStockThreshold,
          },
        },
      });
      return serializeAccessCodePool(pool);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "An access-code pool with this name already exists.",
          code: "ACCESS_CODE_POOL_NAME_CONFLICT",
        });
      }
      throw error;
    }
  },

  async archivePool(
    tenantId: string,
    poolId: string,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const current = await requirePool(
      tenantId,
      poolId,
      allowedLocationIds,
      true,
    );
    const now = new Date();
    const pool = await repository.archivePool(
      tenantId,
      poolId,
      context.actorId,
      now,
    );
    if (!pool) notFound("Access-code pool not found.");
    await repository.retirePoolCodes(
      tenantId,
      poolId,
      context.actorId,
      now,
    );
    await recordAudit({
      tenantId,
      locationId: String(current.location),
      poolId,
      context,
      action: ACCESS_CODE_AUDIT_ACTION.POOL_ARCHIVED,
      metadata: { name: current.name },
    });
    return serializeAccessCodePool(pool);
  },

  async list(
    tenantId: string,
    filters: ListAccessCodesDto,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (filters.locationId) {
      assertLocationIdsWithinWorkspaceScope(
        [filters.locationId],
        allowedLocationIds,
      );
    }
    if (filters.poolId) {
      await requirePool(tenantId, filters.poolId, allowedLocationIds);
    }
    const [items, totalCount] = await repository.listCodes(
      tenantId,
      filters,
      allowedLocationIds,
    );
    return {
      items: items.map((item) => serializeAccessCode(item)),
      totalCount,
      totalPages: Math.ceil(totalCount / filters.limit),
      currentPage: filters.page,
      pageSize: filters.limit,
    };
  },

  async getById(
    tenantId: string,
    codeId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    return serializeAccessCode(
      await requireCode(tenantId, codeId, allowedLocationIds),
    );
  },

  async create(
    tenantId: string,
    input: CreateAccessCodeDto,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    source: "manual" | "import" = ACCESS_CODE_SOURCE.MANUAL,
  ) {
    const pool = await requirePool(
      tenantId,
      input.poolId,
      allowedLocationIds,
      true,
    );
    if (String(input.status || "") === ACCESS_CODE_STATUS.RETIRED) {
      badRequest({
        message: "Create the code as draft, available, or disabled.",
        code: "ACCESS_CODE_CREATE_STATUS_INVALID",
      });
    }

    const verifiedAt = input.programmedAndTested ? new Date() : null;
    assertAvailableCodeIsVerified(input.status, verifiedAt);
    assertValidity(input.validFrom, input.validUntil);
    await assertEmergencySlotAvailable({
      tenantId,
      poolId: input.poolId,
      type: input.type,
      status: input.status,
    });

    const entryCode = normalizeAccessCodeValue(input.code);
    const codeFingerprint = fingerprintAccessCode({
      tenantId,
      poolId: input.poolId,
      entryCode,
    });
    if (
      await repository.findFingerprint(
        tenantId,
        input.poolId,
        codeFingerprint,
      )
    ) {
      conflict({
        message: "This access code already exists in the pool.",
        code: "ACCESS_CODE_DUPLICATE",
      });
    }

    try {
      const code = await repository.createCode(tenantId, {
        location: pool.location,
        pool: pool._id,
        entryCode: encryptAccessCode({
          tenantId,
          poolId: input.poolId,
          entryCode,
        }),
        codeFingerprint,
        codeHint: maskAccessCode(entryCode),
        label: input.label,
        notes: input.notes,
        type: input.type,
        status: input.status,
        source,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        verifiedAt,
        verifiedBy: input.programmedAndTested ? context.actorId : null,
        createdBy: context.actorId,
        updatedBy: context.actorId,
        emergencyReserveKey: emergencyReserveKey({
          tenantId,
          poolId: input.poolId,
          type: input.type,
          status: input.status,
        }),
        // Compatibility fields remain inert because legacy sending is disabled.
        isUsed: false,
        usedCount: 0,
        canBeRepeated: input.type !== ACCESS_CODE_TYPE.SINGLE_BOOKING,
        expiresAt: input.validUntil,
      });
      await recordAudit({
        tenantId,
        locationId: String(pool.location),
        poolId: input.poolId,
        accessCodeId: String(code._id),
        context,
        action:
          source === ACCESS_CODE_SOURCE.IMPORT
            ? ACCESS_CODE_AUDIT_ACTION.CODE_IMPORTED
            : ACCESS_CODE_AUDIT_ACTION.CODE_CREATED,
        metadata: {
          type: input.type,
          status: input.status,
          maskedCode: code.codeHint,
          validFrom: input.validFrom?.toISOString() || null,
          validUntil: input.validUntil?.toISOString() || null,
          verified: Boolean(verifiedAt),
        },
      });
      return serializeAccessCode(code);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        conflict(normalizedError(error));
      }
      throw error;
    }
  },

  async bulkCreate(
    tenantId: string,
    poolId: string,
    rows: unknown[],
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    await requirePool(tenantId, poolId, allowedLocationIds, true);
    const results: Array<Record<string, unknown>> = [];
    let created = 0;
    let failed = 0;

    for (const [index, raw] of rows.entries()) {
      const parsed = bulkAccessCodeRowSchema.safeParse(raw);
      if (!parsed.success) {
        failed += 1;
        results.push({
          index,
          status: "failed",
          error: {
            code: "ACCESS_CODE_IMPORT_ROW_INVALID",
            message: "The access-code row is invalid.",
            details: parsed.error.flatten(),
          },
        });
        continue;
      }
      try {
        const item = await this.create(
          tenantId,
          { poolId, ...parsed.data } as CreateAccessCodeDto,
          context,
          allowedLocationIds,
          ACCESS_CODE_SOURCE.IMPORT,
        );
        created += 1;
        results.push({ index, status: "created", item });
      } catch (error) {
        failed += 1;
        results.push({
          index,
          status: "failed",
          error: normalizedError(error),
        });
      }
    }

    return {
      total: rows.length,
      created,
      failed,
      results,
    };
  },

  async update(
    tenantId: string,
    input: UpdateAccessCodeDto,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const current = await requireCode(
      tenantId,
      input.id,
      allowedLocationIds,
      true,
    );
    if (current.status === ACCESS_CODE_STATUS.RETIRED) {
      conflict({
        message: "A retired access code cannot be changed.",
        code: "ACCESS_CODE_RETIRED",
      });
    }
    // Keep a runtime guard for non-controller callers even though the public
    // validator excludes this lifecycle transition.
    if (String(input.status || "") === ACCESS_CODE_STATUS.RETIRED) {
      badRequest({
        message: "Use the retire action to retire an access code.",
        code: "ACCESS_CODE_RETIRE_ACTION_REQUIRED",
      });
    }

    const poolId = String(current.pool);
    const finalType = input.type ?? current.type;
    const finalStatus = input.status ?? current.status;
    const finalValidFrom =
      input.validFrom === undefined ? current.validFrom : input.validFrom;
    const finalValidUntil =
      input.validUntil === undefined ? current.validUntil : input.validUntil;
    if (input.poolId && input.poolId !== poolId) {
      badRequest({
        message: "An access code cannot be moved to another pool.",
        code: "ACCESS_CODE_POOL_IMMUTABLE",
      });
    }
    const finalVerifiedAt =
      input.programmedAndTested === true
        ? current.verifiedAt || new Date()
        : input.programmedAndTested === false
          ? null
          : current.verifiedAt;
    assertValidity(finalValidFrom, finalValidUntil);
    assertAvailableCodeIsVerified(finalStatus, finalVerifiedAt);
    await assertEmergencySlotAvailable({
      tenantId,
      poolId,
      type: finalType,
      status: finalStatus,
      excludeId: input.id,
    });

    const patch: Record<string, unknown> = {
      ...(input.type ? { type: input.type } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.validFrom !== undefined
        ? { validFrom: input.validFrom }
        : {}),
      ...(input.validUntil !== undefined
        ? {
            validUntil: input.validUntil,
            expiresAt: input.validUntil,
          }
        : {}),
      ...(input.programmedAndTested !== undefined
        ? {
            verifiedAt: finalVerifiedAt,
            verifiedBy: input.programmedAndTested
              ? current.verifiedBy || context.actorId
              : null,
          }
        : {}),
      canBeRepeated: finalType !== ACCESS_CODE_TYPE.SINGLE_BOOKING,
      emergencyReserveKey: emergencyReserveKey({
        tenantId,
        poolId,
        type: finalType,
        status: finalStatus,
      }),
      updatedBy: context.actorId,
    };

    try {
      const code = await repository.updateCode(tenantId, input.id, patch);
      if (!code) notFound("Access code not found.");
      await recordAudit({
        tenantId,
        locationId: String(code.location),
        poolId,
        accessCodeId: input.id,
        context,
        action: ACCESS_CODE_AUDIT_ACTION.CODE_UPDATED,
        metadata: {
          before: {
            type: current.type,
            status: current.status,
            maskedCode: current.codeHint,
            validFrom: current.validFrom?.toISOString() || null,
            validUntil: current.validUntil?.toISOString() || null,
            verified: Boolean(current.verifiedAt),
          },
          after: {
            type: code.type,
            status: code.status,
            maskedCode: code.codeHint,
            validFrom: code.validFrom?.toISOString() || null,
            validUntil: code.validUntil?.toISOString() || null,
            verified: Boolean(code.verifiedAt),
          },
        },
      });
      return serializeAccessCode(code);
    } catch (error) {
      if (isDuplicateKeyError(error)) conflict(normalizedError(error));
      throw error;
    }
  },

  async retire(
    tenantId: string,
    codeId: string,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const current = await requireCode(
      tenantId,
      codeId,
      allowedLocationIds,
    );
    if (current.status === ACCESS_CODE_STATUS.RETIRED) {
      return serializeAccessCode(current);
    }
    const now = new Date();
    const code = await repository.retireCode(
      tenantId,
      codeId,
      context.actorId,
      now,
    );
    if (!code) notFound("Access code not found.");
    await recordAudit({
      tenantId,
      locationId: String(code.location),
      poolId: String(code.pool),
      accessCodeId: codeId,
      context,
      action: ACCESS_CODE_AUDIT_ACTION.CODE_RETIRED,
      metadata: { maskedCode: code.codeHint, previousStatus: current.status },
    });
    return serializeAccessCode(code);
  },

  async reveal(
    tenantId: string,
    codeId: string,
    context: AccessCodeAuditContext,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const code = await requireCode(
      tenantId,
      codeId,
      allowedLocationIds,
      true,
    );
    const poolId = String(code.pool);
    const entryCode = decryptAccessCode({
      tenantId,
      poolId,
      encryptedEntryCode: code.entryCode,
    });
    const revealedAt = new Date();
    // Audit persistence is intentionally fail-closed for secret disclosure.
    await recordAudit({
      tenantId,
      locationId: String(code.location),
      poolId,
      accessCodeId: codeId,
      context,
      action: ACCESS_CODE_AUDIT_ACTION.CODE_REVEALED,
      metadata: { maskedCode: code.codeHint },
    });
    return { id: codeId, code: entryCode, revealedAt: revealedAt.toISOString() };
  },

  async listAlerts(
    tenantId: string,
    locationId: string | undefined,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (locationId) {
      assertLocationIdsWithinWorkspaceScope(
        [locationId],
        allowedLocationIds,
      );
    }
    const pools = await repository.listPools(
      tenantId,
      { locationId, includeArchived: false },
      allowedLocationIds,
    );
    const now = new Date();
    const summaries = await summarizePools(tenantId, pools);

    return {
      generatedAt: now.toISOString(),
      alerts: summaries.map((pool) => {
        const severity = pool.severity;
        return {
          pool,
          singleBookingAvailable: pool.counts.available,
          reusableAvailable: pool.counts.reusable,
          emergencyReserveAvailable: pool.counts.emergency > 0,
          lowStockThreshold: pool.lowStockThreshold,
          severity,
          code:
            severity === "critical"
              ? "ACCESS_CODE_NORMAL_POOL_EXHAUSTED"
              : severity === "warning"
                ? "ACCESS_CODE_LOW_STOCK"
                : null,
        };
      }),
    };
  },

  async listAudit(
    tenantId: string,
    filters: ListAccessCodeAuditDto,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (filters.locationId) {
      assertLocationIdsWithinWorkspaceScope(
        [filters.locationId],
        allowedLocationIds,
      );
    }
    if (filters.poolId) {
      await requirePool(tenantId, filters.poolId, allowedLocationIds);
    }
    if (filters.accessCodeId) {
      await requireCode(
        tenantId,
        filters.accessCodeId,
        allowedLocationIds,
      );
    }
    const [items, totalCount] = await repository.listAuditEvents(
      tenantId,
      filters,
      allowedLocationIds,
    );
    return {
      items: items.map(serializeAccessCodeAuditEvent),
      totalCount,
      totalPages: Math.ceil(totalCount / filters.limit),
      currentPage: filters.page,
      pageSize: filters.limit,
    };
  },
};
