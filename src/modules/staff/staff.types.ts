// staff.types.ts

import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type { staffMemberSchema } from "./staff-member.schema.js";
import type { staffTaskSchema } from "./staff-task.schema.js";
import type {
  EmploymentType,
  StaffRole,
  StaffTaskCategory,
  StaffTaskPriority,
  StaffTaskStatus,
} from "./staff.constants.js";
import type { AllowedWorkspaceLocationIds } from "@/modules/tenant-access/index.js";

export type ObjectIdLike = string | Types.ObjectId;

export type StaffMember = InferSchemaType<typeof staffMemberSchema>;
export type StaffTask = InferSchemaType<typeof staffTaskSchema>;

export type StaffMemberDocument = HydratedDocument<StaffMember>;
export type StaffTaskDocument = HydratedDocument<StaffTask>;

export type TenantScoped = {
  tenantId: ObjectIdLike;
};

export type CurrentUserContext = {
  id: ObjectIdLike;
  tenantId: ObjectIdLike;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
  defaultLocationId?: string | null;
};

export type StaffMemberListFilters = TenantScoped & {
  search?: string;
  role?: StaffRole;
  employmentType?: EmploymentType;
  locationId?: ObjectIdLike;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
  isActive?: boolean;
  isBookable?: boolean;
  visibleOnWebsite?: boolean;
  page?: number;
  limit?: number;
};

export type StaffTaskListFilters = TenantScoped & {
  startDate?: Date;
  endDate?: Date;
  locationId?: ObjectIdLike;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
  status?: StaffTaskStatus;
  priority?: StaffTaskPriority;
  assignedTo?: ObjectIdLike;
  category?: StaffTaskCategory;
  page?: number;
  limit?: number;
};
