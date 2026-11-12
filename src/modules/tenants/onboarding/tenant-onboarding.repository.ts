import type { ClientSession } from "mongoose";

import { TenantModel } from "../tenant.model.js";
import type { TenantDocument } from "../tenant.types.js";

type RepositoryOptions = {
  session?: ClientSession | null;
};

const onboardingProjection =
  "name status plan modules limits settings onboarding";

export const findTenantForOnboarding = async (
  tenantId: string,
  options: RepositoryOptions = {},
): Promise<TenantDocument | null> => {
  const query = TenantModel.findById(tenantId).select(onboardingProjection);

  if (options.session) {
    query.session(options.session);
  }

  return query.exec();
};

export const updateTenantOnboarding = async (
  tenantId: string,
  patch: Record<string, unknown>,
  options: RepositoryOptions = {},
): Promise<TenantDocument | null> => {
  const query = TenantModel.findByIdAndUpdate(
    tenantId,
    {
      $set: patch,
    },
    {
      returnDocument: "after",
      runValidators: true,
      strict: "throw",
    },
  )
    .select(onboardingProjection);

  if (options.session) {
    query.session(options.session);
  }

  return query.exec();
};
