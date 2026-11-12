import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { forbidden } from "@/shared/http/httpErrors.js";

export const assertStaffTasksModuleEnabled = async (
  tenantId: string,
): Promise<void> => {
  const enabled = await TenantModel.exists({
    _id: tenantId,
    [`modules.${TENANT_MODULE.STAFF_TASKS}`]: true,
  });
  if (!enabled) {
    forbidden({
      message: "Staff planning is not enabled for this workspace.",
      code: "STAFF_TASKS_MODULE_REQUIRED",
      details: { requiredModule: TENANT_MODULE.STAFF_TASKS },
    });
  }
};

