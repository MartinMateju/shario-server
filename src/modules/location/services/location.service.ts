import mongoose, { type ClientSession } from "mongoose";

import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import { DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE } from "../location.constants.js";
import { locationRepository } from "../location.repository.js";
import type {
  LocationDocument,
  LocationListFilters,
} from "../location.types.js";
import {
  buildLocationCode,
  normalizeLocationCode,
  slugifyLocation,
} from "../location.utils.js";
import type {
  CreateLocationInput,
  UpdateLocationInput,
} from "../location.validators.js";

type LocationServiceOptions = {
  session?: ClientSession | null;
};
const isDuplicateKeyError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
};

const throwLocationIdentityConflict = (): never => {
  return conflict({
    message: "A studio location with this slug or code already exists.",
    code: "LOCATION_IDENTITY_CONFLICT",
  });
};

const assertLocationCapacity = async (
  tenant: TenantDocument,
  options: LocationServiceOptions = {},
): Promise<void> => {
  const tenantId = String(tenant._id);
  const activeLocations = await locationRepository.countActive(
    tenantId,
    options,
  );
  const locationLimit = Math.max(Number(tenant.limits?.locations || 1), 1);

  if (activeLocations >= locationLimit) {
    conflict({
      message:
        "Your current plan has reached its active studio location limit.",
      code: "LOCATION_LIMIT_REACHED",
      details: {
        activeLocations,
        locationLimit,
        plan: tenant.plan,
        upgradeRequired: true,
      },
    });
  }
};

const lockTenantLocationCapacity = async (
  tenantId: string,
  session: ClientSession,
) => {
  // Serialize admissions before reading the count: distinct location writes
  // otherwise permit snapshot-isolation write skew at the tenant quota.
  const result = await TenantModel.updateOne(
    { _id: tenantId },
    { $inc: { accessControlVersion: 1 } },
    { session },
  ).exec();
  if (!result.matchedCount) notFound("Tenant not found.");
};

const runInTransaction = async <T>(
  task: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();

  try {
    let result: T | undefined;

    await session.withTransaction(async () => {
      result = await task(session);
    });

    if (result === undefined) {
      throw new Error("Location transaction completed without a result.");
    }

    return result;
  } finally {
    await session.endSession();
  }
};

const getAvailableInitialIdentity = async (
  tenantId: string,
  name: string,
  options: LocationServiceOptions = {},
): Promise<{ slug: string; code: string }> => {
  const baseSlug = slugifyLocation(name) || "studio";
  const baseCode = buildLocationCode(baseSlug);

  for (let index = 1; index <= 100; index += 1) {
    const slug = index === 1 ? baseSlug : `${baseSlug}-${index}`;
    const code =
      index === 1 ? baseCode : normalizeLocationCode(`${baseCode}-${index}`);

    const exists = await locationRepository.identityExists(
      tenantId,
      { slug, code },
      options,
    );

    if (!exists) {
      return { slug, code };
    }
  }

  return conflict({
    message: "Could not generate a unique identity for the studio location.",
    code: "LOCATION_IDENTITY_EXHAUSTED",
  });
};

const buildInitialLocationInput = async (
  tenant: TenantDocument,
  options: LocationServiceOptions = {},
): Promise<CreateLocationInput> => {
  const tenantId = String(tenant._id);
  const name = tenant.name.trim();
  const { slug, code } = await getAvailableInitialIdentity(
    tenantId,
    name,
    options,
  );
  const businessDetails = tenant.onboarding?.businessDetails;

  return {
    name,
    slug,
    code,
    address: {
      line1: businessDetails?.address?.trim() || "",
      line2: "",
      city: businessDetails?.city?.trim() || "",
      postalCode: "",
      country: businessDetails?.country?.trim() || "CZ",
    },
    contact: {
      email: "",
      phone: businessDetails?.phone?.trim() || "",
    },
    booking: {
      // Mirror Launch Center workflow selection. Historical onboarding answers
      // are metadata and must not override the tenant's effective modules.
      enabled:
        tenant.modules?.[TENANT_MODULE.BOOKINGS] !== false ||
        tenant.modules?.[TENANT_MODULE.COURSES] === true,
      timezone: tenant.settings?.timezone || "Europe/Prague",
      activitySelectionMode: DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE,
    },
    openingHours: {},
    access: {},
    notes: "",
  };
};

/**
 * Idempotently gives a tenant exactly one active primary location.
 *
 * New tenants use this during onboarding. The same function is also safe for
 * backfilling tenants created before Studio Locations were introduced.
 */
export const ensureTenantPrimaryLocation = async (
  tenant: TenantDocument,
  options: LocationServiceOptions = {},
): Promise<LocationDocument> => {
  const tenantId = String(tenant._id);
  const existingPrimary = await locationRepository.findPrimary(
    tenantId,
    options,
  );

  if (existingPrimary) {
    return existingPrimary;
  }

  const existingActive = await locationRepository.findFirstActive(
    tenantId,
    options,
  );

  if (existingActive) {
    const promoted = await locationRepository.markPrimary(
      tenantId,
      String(existingActive._id),
      options,
    );

    if (!promoted) {
      return notFound(
        "Studio location not found while setting the primary location.",
      );
    }

    return promoted;
  }

  await assertLocationCapacity(tenant, options);
  const input = await buildInitialLocationInput(tenant, options);

  try {
    return await locationRepository.create(tenantId, input, {
      ...options,
      isPrimary: true,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throwLocationIdentityConflict();
    }

    throw error;
  }
};

export const locationService = {
  async list(filters: LocationListFilters) {
    const [locations, total] = await Promise.all([
      locationRepository.list(filters),
      locationRepository.count(filters),
    ]);

    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);

    return {
      locations,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  },

  async getById(
    tenantId: string,
    locationId: string,
    includePrivateAccess = false,
  ) {
    const location = await locationRepository.findByIdForTenant(
      tenantId,
      locationId,
      { includePrivateAccess },
    );

    if (!location) {
      return notFound("Studio location not found.");
    }

    return location;
  },

  async create(tenantId: string, input: CreateLocationInput) {
    try {
      return await runInTransaction(async (session) => {
        await lockTenantLocationCapacity(tenantId, session);
        const tenant = await getTenantOrThrow(tenantId, { session });

        await assertLocationCapacity(tenant, { session });

        const primary = await locationRepository.findPrimary(tenantId, {
          session,
        });

        return locationRepository.create(tenantId, input, {
          session,
          isPrimary: !primary,
        });
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throwLocationIdentityConflict();
      }

      throw error;
    }
  },

  async bootstrap(tenantId: string) {
    try {
      return await runInTransaction(async (session) => {
        await lockTenantLocationCapacity(tenantId, session);
        const tenant = await getTenantOrThrow(tenantId, { session });

        return ensureTenantPrimaryLocation(tenant, { session });
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throwLocationIdentityConflict();
      }

      throw error;
    }
  },

  async update(tenantId: string, input: UpdateLocationInput) {
    try {
      const location = await locationRepository.update(tenantId, input);

      if (!location) {
        return notFound("Studio location not found.");
      }

      return location;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throwLocationIdentityConflict();
      }

      throw error;
    }
  },

  async setPrimary(tenantId: string, locationId: string) {
    return runInTransaction(async (session) => {
      const target = await locationRepository.findByIdForTenant(
        tenantId,
        locationId,
        { session },
      );

      if (!target) {
        return notFound("Studio location not found.");
      }

      if (!target.isActive) {
        badRequest({
          message: "An archived studio location cannot be made primary.",
          code: "LOCATION_ARCHIVED",
        });
      }

      if (target.isPrimary) {
        return target;
      }

      await locationRepository.clearPrimary(tenantId, { session });
      const location = await locationRepository.markPrimary(
        tenantId,
        locationId,
        { session },
      );

      if (!location) {
        return notFound("Studio location not found.");
      }

      return location;
    });
  },

  async activate(tenantId: string, locationId: string) {
    return runInTransaction(async (session) => {
      await lockTenantLocationCapacity(tenantId, session);
      const target = await locationRepository.findByIdForTenant(
        tenantId,
        locationId,
        { session },
      );

      if (!target) {
        return notFound("Studio location not found.");
      }

      if (target.isActive) {
        return target;
      }

      const tenant = await getTenantOrThrow(tenantId, { session });
      await assertLocationCapacity(tenant, { session });

      const activated = await locationRepository.activate(
        tenantId,
        locationId,
        { session },
      );

      if (!activated) {
        return notFound("Studio location not found.");
      }

      const primary = await locationRepository.findPrimary(tenantId, {
        session,
      });

      if (!primary) {
        const promoted = await locationRepository.markPrimary(
          tenantId,
          locationId,
          { session },
        );

        if (!promoted) {
          return notFound("Studio location not found.");
        }

        return promoted;
      }

      return activated;
    });
  },

  async deactivate(tenantId: string, locationId: string) {
    return runInTransaction(async (session) => {
      const target = await locationRepository.findByIdForTenant(
        tenantId,
        locationId,
        { session },
      );

      if (!target) {
        return notFound("Studio location not found.");
      }

      if (!target.isActive) {
        return target;
      }

      const activeLocations = await locationRepository.countActive(tenantId, {
        session,
      });

      if (activeLocations <= 1) {
        conflict({
          message: "The tenant must keep at least one active studio location.",
          code: "LAST_ACTIVE_LOCATION",
        });
      }

      const archived = await locationRepository.archive(tenantId, locationId, {
        session,
      });

      if (!archived) {
        return notFound("Studio location not found.");
      }

      if (target.isPrimary) {
        const replacement = await locationRepository.findFirstActive(tenantId, {
          session,
        });

        if (!replacement) {
          return conflict({
            message: "A replacement primary studio location is required.",
            code: "PRIMARY_LOCATION_REQUIRED",
          });
        }

        await locationRepository.markPrimary(
          tenantId,
          String(replacement._id),
          { session },
        );
      }

      return archived;
    });
  },

  async delete(tenantId: string, locationId: string) {
    return this.deactivate(tenantId, locationId);
  },
};
