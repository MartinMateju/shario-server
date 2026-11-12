import type { MoneyCredit } from "./money-credit.types.js";
import { toObjectId } from "@/shared/helpers/helper.js";

export const buildMoneyCreditUserQuery = (
  tenantId: string,
  userId: string,
) => ({
  tenant: toObjectId(tenantId),
  user: toObjectId(userId),
} satisfies Partial<MoneyCredit>);