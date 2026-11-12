import type {
  ClientSession,
  HydratedDocument,
  InferSchemaType,
  Model,
  Types,
} from "mongoose";

import type { LegacyRole, PlatformRole, TenantRole } from "./user.constants.js";
import { userSchema } from "./user.schema.js";

export type User = InferSchemaType<typeof userSchema>;

export type UserDocument = HydratedDocument<User> & {
  matchPassword(enteredPassword: string): Promise<boolean>;
};

export type UserModel = Model<User>;

export type IdLike = string | Types.ObjectId;
export type TenantId = IdLike;

export type UserFilter = Record<string, unknown>;

export type SortDirection = 1 | -1;

export type UserFindOptions = {
  select?: string | Record<string, string | number | boolean | object>;
  sort?: Record<string, SortDirection>;
  skip?: number;
  limit?: number;
  lean?: boolean;
  includePassword?: boolean;
  includePrivateRoles?: boolean;
  includeGuestContact?: boolean;
};

export type RepositoryContext = {
  tenantId: TenantId;
  session?: ClientSession | null;
};

export type CreateUserInput = {
  firstname: string;
  lastname: string;
  email: string;
  phone?: string;
  password: string;
  /** Legacy opaque identifier. New API callers should let the server create it. */
  customId?: string;
  tenantRole?: TenantRole;
  platformRole?: PlatformRole;
  roles?: LegacyRole[];
};

export type UpdateUserInput = {
  id: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  phone?: string;
};

export type UpdatePasswordInput = {
  id: string;
  currentPass: string;
  newPass: string;
  newPassConfirm: string;
};
