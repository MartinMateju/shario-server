// services/staff-member.service.ts

import { notFound } from "../../../shared/http/httpErrors.js";
import UserModel from "@/modules/user/user.model.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
} from "@/modules/tenant-access/index.js";

import { createStaffRepository } from "../staff.repository.js";
import type { CurrentUserContext } from "../staff.types.js";
import type {
  CreateStaffMemberInput,
  ListStaffMembersInput,
  UpdateStaffMemberInput,
} from "../staff.validators.js";

export const staffMemberService = {
  list(context: CurrentUserContext, input: ListStaffMembersInput) {
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });

    const allowedLocationIds = context.allowedLocationIds ?? null;

    if (input.location) {
      assertLocationIdsWithinWorkspaceScope(
        [input.location],
        allowedLocationIds,
      );
    }

    return staffRepository.listMembers({
      ...input,
      locationId: input.location,
      allowedLocationIds,
    });
  },

  async getById(context: CurrentUserContext, id: string) {
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });

    const staffMember = await staffRepository.findMemberById(id);

    if (!staffMember) {
      notFound("Staff member not found.");
    }

    assertLocationIdsWithinWorkspaceScope(
      (staffMember.locationIds ?? []).map(String),
      context.allowedLocationIds ?? null,
    );

    return staffMember;
  },

  async create(context: CurrentUserContext, input: CreateStaffMemberInput) {
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });

    const allowedLocationIds = context.allowedLocationIds ?? null;

    if (!input.locations.length) {
      assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    }

    await assertTenantLocationsWithinWorkspaceScope({
      tenantId: String(context.tenantId),
      locationIds: input.locations,
      allowedLocationIds,
    });

    if (input.user) {
      const userExists = await UserModel.exists({
        _id: input.user,
        tenant: context.tenantId,
      });

      if (!userExists) {
        notFound("User not found.");
      }
    }

    return staffRepository.createMember(context.id, input);
  },

  async update(
    context: CurrentUserContext,
    id: string,
    input: UpdateStaffMemberInput,
  ) {
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });

    const existing = await staffRepository.findMemberById(id);

    if (!existing) {
      notFound("Staff member not found.");
    }

    if (!existing.locationIds?.length) {
      assertCanAccessAllWorkspaceLocations(context.allowedLocationIds ?? null);
    } else {
      assertLocationIdsWithinWorkspaceScope(
        existing.locationIds.map(String),
        context.allowedLocationIds ?? null,
      );
    }

    if (input.locations) {
      if (!input.locations.length) {
        assertCanAccessAllWorkspaceLocations(
          context.allowedLocationIds ?? null,
        );
      }

      await assertTenantLocationsWithinWorkspaceScope({
        tenantId: String(context.tenantId),
        locationIds: input.locations,
        allowedLocationIds: context.allowedLocationIds ?? null,
      });
    }

    if (input.user) {
      const userExists = await UserModel.exists({
        _id: input.user,
        tenant: context.tenantId,
      });

      if (!userExists) {
        notFound("User not found.");
      }
    }

    const staffMember = await staffRepository.updateMemberById(id, input);

    if (!staffMember) {
      notFound("Staff member not found.");
    }

    return staffMember;
  },

  async delete(context: CurrentUserContext, id: string) {
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });

    const existing = await staffRepository.findMemberById(id);

    if (!existing) {
      notFound("Staff member not found.");
    }

    if (!existing.locationIds?.length) {
      assertCanAccessAllWorkspaceLocations(context.allowedLocationIds ?? null);
    } else {
      assertLocationIdsWithinWorkspaceScope(
        existing.locationIds.map(String),
        context.allowedLocationIds ?? null,
      );
    }

    const result = await staffRepository.deleteMemberById(id);

    if (!result.deletedCount) {
      notFound("Staff member not found.");
    }

    return { message: "Staff member deleted." };
  },
};
