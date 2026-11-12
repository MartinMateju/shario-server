import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requireAnyPermission,
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import {
  getStaffPlanningOverview,
  patchDailyAttention,
  putDailyUpdate,
  putMemberSchedule,
  putMonthlyPriorities,
  putPlanningSettings,
  putWeeklyPlan,
} from "../controllers/staff-planning.controller.js";

const router = Router();

router.use(verifyJWT);
router.use(requireWorkspaceAccess);
router.use(requireTenantModule(TENANT_MODULE.STAFF_TASKS));

const submit = requirePermission(WORKSPACE_PERMISSION.PLANNING_SUBMIT);
const manage = requirePermission(WORKSPACE_PERMISSION.PLANNING_MANAGE);

router.get(
  "/overview",
  requireAnyPermission(
    WORKSPACE_PERMISSION.PLANNING_SUBMIT,
    WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
    WORKSPACE_PERMISSION.PLANNING_MANAGE,
  ),
  getStaffPlanningOverview,
);
router.put("/daily-updates/:date", submit, putDailyUpdate);
router.put("/weekly-plans/:weekStart", submit, putWeeklyPlan);
router.put("/monthly-priorities/:month", manage, putMonthlyPriorities);
router.put("/settings", manage, putPlanningSettings);
router.put("/members/:memberId/schedule", manage, putMemberSchedule);
router.patch("/daily-updates/:id/attention", manage, patchDailyAttention);

export default router;
