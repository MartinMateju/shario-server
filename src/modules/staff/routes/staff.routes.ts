import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import {
  createStaffMember,
  deleteStaffMember,
  getStaffMemberById,
  getStaffMembers,
  updateStaffMember,
} from "../controllers/staff-member.controller.js";
import {
  createStaffTask,
  deleteStaffTask,
  getStaffTasks,
  updateStaffTask,
} from "../controllers/staff-task.controller.js";

const router = express.Router();

router.use(verifyJWT);

const manageOperationalStaff = requirePermission(
  WORKSPACE_PERMISSION.COURSES_MANAGE,
);
const viewOperationalStaff = requirePermission(WORKSPACE_PERMISSION.TEAM_VIEW);
const viewTasks = requirePermission(WORKSPACE_PERMISSION.TASKS_VIEW);
const manageTasks = requirePermission(WORKSPACE_PERMISSION.TASKS_MANAGE);
const staffTasksModule = requireTenantModule(TENANT_MODULE.STAFF_TASKS);

router
  .route("/members")
  .get(viewOperationalStaff, getStaffMembers)
  .post(manageOperationalStaff, createStaffMember);

router
  .route("/members/:id")
  .get(viewOperationalStaff, getStaffMemberById)
  .patch(manageOperationalStaff, updateStaffMember)
  .delete(manageOperationalStaff, deleteStaffMember);

router
  .route("/tasks")
  .get(staffTasksModule, viewTasks, getStaffTasks)
  .post(staffTasksModule, manageTasks, createStaffTask);

router
  .route("/tasks/:id")
  .patch(staffTasksModule, manageTasks, updateStaffTask)
  .delete(staffTasksModule, manageTasks, deleteStaffTask);

export default router;
