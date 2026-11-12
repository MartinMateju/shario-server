import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import { TENANT_ROLE } from "@/modules/user/user.constants.js";

import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_CALENDAR_VIEW,
  WORKSPACE_ROLE,
} from "../tenant-access.constants.js";
import TenantMembershipModel from "../tenant-membership.model.js";

const APPLY_FLAG = "--apply";
const shouldApply = process.argv.includes(APPLY_FLAG);
const sampleLimit = 50;

const roleMap = {
  [TENANT_ROLE.OWNER]: WORKSPACE_ROLE.OWNER,
  [TENANT_ROLE.ADMIN]: WORKSPACE_ROLE.ADMIN,
  [TENANT_ROLE.STAFF]: WORKSPACE_ROLE.STAFF,
} as const;

type LegacyInternalUser = {
  _id: mongoose.Types.ObjectId;
  tenant: mongoose.Types.ObjectId;
  tenantRole: keyof typeof roleMap;
};

const buildMembershipInsert = (
  user: LegacyInternalUser,
  now: Date,
) => ({
  tenant: user.tenant,
  user: user._id,
  status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  role: roleMap[user.tenantRole],
  customRole: null,
  locationAccess: {
    mode: LOCATION_ACCESS_MODE.ALL,
    locationIds: [],
  },
  workspaceProfile: {
    jobTitle: "",
    displayName: "",
    calendarColor: "#74869a",
  },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: null,
    defaultCalendarView: WORKSPACE_CALENDAR_VIEW.WEEK,
    weekStartsOn: 1,
    defaultLandingPage: "/app",
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  createdBy: user._id,
  updatedBy: user._id,
  acceptedAt: now,
  createdAt: now,
  updatedAt: now,
});

const run = async (): Promise<void> => {
  await connectDB();

  const users = (await UserModel.collection
    .find(
      {
        tenantRole: {
          $in: [TENANT_ROLE.OWNER, TENANT_ROLE.ADMIN, TENANT_ROLE.STAFF],
        },
      },
      { projection: { tenant: 1, tenantRole: 1 } },
    )
    .toArray()) as LegacyInternalUser[];

  const summary = {
    mode: shouldApply ? "apply" : "dry-run",
    scannedLegacyInternalUsers: users.length,
    existingMemberships: 0,
    membershipsToCreate: 0,
    membershipsCreated: 0,
    tenantsMissingAccessControlVersion: 0,
    tenantsUpdatedWithAccessControlVersion: 0,
    skippedInvalidUsers: 0,
    roleCounts: {
      owner: 0,
      admin: 0,
      staff: 0,
    },
    sampleUserIdsToCreate: [] as string[],
    tenantsWithoutActiveOwner: [] as string[],
  };

  const missingAccessControlVersionFilter = {
    $or: [
      { accessControlVersion: { $exists: false } },
      { accessControlVersion: null },
      { accessControlVersion: { $lt: 0 } },
    ],
  };

  summary.tenantsMissingAccessControlVersion =
    await TenantModel.collection.countDocuments(
      missingAccessControlVersionFilter,
    );

  if (shouldApply && summary.tenantsMissingAccessControlVersion > 0) {
    const result = await TenantModel.collection.updateMany(
      missingAccessControlVersionFilter,
      { $set: { accessControlVersion: 0 } },
    );
    summary.tenantsUpdatedWithAccessControlVersion = result.modifiedCount;
  }

  for (const user of users) {
    if (
      !user._id ||
      !user.tenant ||
      !roleMap[user.tenantRole]
    ) {
      summary.skippedInvalidUsers += 1;
      continue;
    }

    const existing = await TenantMembershipModel.collection.findOne(
      { tenant: user.tenant, user: user._id },
      { projection: { _id: 1 } },
    );

    if (existing) {
      summary.existingMemberships += 1;
      continue;
    }

    summary.membershipsToCreate += 1;
    summary.roleCounts[user.tenantRole] += 1;

    if (summary.sampleUserIdsToCreate.length < sampleLimit) {
      summary.sampleUserIdsToCreate.push(String(user._id));
    }

    if (!shouldApply) continue;

    const now = new Date();
    const result = await TenantMembershipModel.collection.updateOne(
      { tenant: user.tenant, user: user._id },
      { $setOnInsert: buildMembershipInsert(user, now) },
      { upsert: true },
    );

    if (result.upsertedCount > 0) {
      summary.membershipsCreated += 1;
    }
  }

  if (shouldApply) {
    const tenantIds = await UserModel.collection.distinct("tenant", {
      tenantRole: TENANT_ROLE.OWNER,
    });

    for (const tenantId of tenantIds) {
      const activeOwner = await TenantMembershipModel.collection.findOne(
        {
          tenant: tenantId,
          status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
          role: WORKSPACE_ROLE.OWNER,
        },
        { projection: { _id: 1 } },
      );

      if (!activeOwner) {
        summary.tenantsWithoutActiveOwner.push(String(tenantId));
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.skippedInvalidUsers > 0) {
    process.exitCode = 1;
  }

  if (shouldApply && summary.tenantsWithoutActiveOwner.length > 0) {
    process.exitCode = 1;
  }
};

try {
  await run();
} catch (error) {
  console.error("Tenant access migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

