export const WORKSPACE_PERMISSION = {
  WORKSPACE_VIEW: "workspace.view",
  WORKSPACE_UPDATE: "workspace.update",
  WORKSPACE_CONFIGURATION_MANAGE: "workspace.configuration.manage",
  WORKSPACE_PUBLISH: "workspace.publish",
  WORKSPACE_OWNERSHIP_TRANSFER: "workspace.ownership.transfer",
  WORKSPACE_DELETE: "workspace.delete",

  TEAM_VIEW: "team.view",
  TEAM_MANAGE: "team.manage",
  ROLES_VIEW: "roles.view",
  ROLES_MANAGE: "roles.manage",

  LOCATIONS_VIEW: "locations.view",
  LOCATIONS_MANAGE: "locations.manage",

  BOOKINGS_VIEW: "bookings.view",
  BOOKINGS_CREATE: "bookings.create",
  BOOKINGS_UPDATE: "bookings.update",
  BOOKINGS_CANCEL: "bookings.cancel",
  BOOKINGS_REFUND: "bookings.refund",
  BOOKINGS_IMPORT: "bookings.import",

  ACCESS_CODES_VIEW: "access_codes.view",
  ACCESS_CODES_MANAGE: "access_codes.manage",
  ACCESS_CODES_REVEAL: "access_codes.reveal",
  ACCESS_CODES_IMPORT: "access_codes.import",
  ACCESS_CODES_AUDIT_VIEW: "access_codes.audit.view",

  CUSTOMERS_VIEW: "customers.view",
  CUSTOMERS_MANAGE: "customers.manage",
  CUSTOMERS_EXPORT: "customers.export",
  CUSTOMERS_IMPORT: "customers.import",

  PRODUCTS_VIEW: "products.view",
  PRODUCTS_MANAGE: "products.manage",
  PRODUCTS_IMPORT: "products.import",
  COURSES_VIEW: "courses.view",
  COURSES_MANAGE: "courses.manage",
  MEMBERSHIPS_VIEW: "memberships.view",
  MEMBERSHIPS_MANAGE: "memberships.manage",
  MEMBERSHIPS_IMPORT: "memberships.import",

  ORDERS_VIEW: "orders.view",
  ORDERS_MANAGE: "orders.manage",
  PAYMENTS_VIEW: "payments.view",
  PAYMENTS_REFUND: "payments.refund",
  PAYMENTS_CONNECT_MANAGE: "payments.connect.manage",
  INVOICES_VIEW: "invoices.view",
  INVOICES_CREATE: "invoices.create",
  INVOICES_FINALIZE: "invoices.finalize",
  INVOICES_SEND: "invoices.send",
  INVOICES_CREDIT: "invoices.credit",
  INVOICES_EXPORT: "invoices.export",
  INVOICES_PAYMENTS_MANAGE: "invoices.payments.manage",
  CREDITS_VIEW: "credits.view",
  CREDITS_MANAGE: "credits.manage",
  CREDITS_IMPORT: "credits.import",
  VOUCHERS_VIEW: "vouchers.view",
  VOUCHERS_MANAGE: "vouchers.manage",
  VOUCHERS_IMPORT: "vouchers.import",

  DATA_IMPORTS_ROLLBACK: "data-imports.rollback",

  INVENTORY_VIEW: "inventory.view",
  INVENTORY_MANAGE: "inventory.manage",
  TASKS_VIEW: "tasks.view",
  TASKS_MANAGE: "tasks.manage",
  PLANNING_SUBMIT: "planning.submit",
  PLANNING_TEAM_VIEW: "planning.team.view",
  PLANNING_MANAGE: "planning.manage",

  COMMUNICATIONS_VIEW: "communications.view",
  COMMUNICATIONS_MANAGE: "communications.manage",
  COMMUNICATIONS_SEND: "communications.send",
  COMMUNICATIONS_ASSIGN: "communications.assign",
  COMMUNICATIONS_SETTINGS_MANAGE: "communications.settings.manage",
  COMMUNICATIONS_AUDIT_VIEW: "communications.audit.view",

  AI_USE: "ai.use",
  AI_SETTINGS_MANAGE: "ai.settings.manage",
  AI_AUDIT_VIEW: "ai.audit.view",
  KNOWLEDGE_VIEW: "knowledge.view",
  KNOWLEDGE_MANAGE: "knowledge.manage",
  KNOWLEDGE_PUBLISH: "knowledge.publish",
  REPORTS_VIEW: "reports.view",
  REPORTS_EXPORT: "reports.export",

  SUBSCRIPTION_VIEW: "subscription.view",
  SUBSCRIPTION_MANAGE: "subscription.manage",
} as const;

/** Backwards-compatible tenant-facing name used by route integrations. */
export const TENANT_PERMISSION = WORKSPACE_PERMISSION;

export type WorkspacePermission =
  (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION];

export const ALL_WORKSPACE_PERMISSIONS = Object.freeze(
  Object.values(WORKSPACE_PERMISSION),
) as readonly WorkspacePermission[];

const permissionSet = new Set<string>(ALL_WORKSPACE_PERMISSIONS);

export const isWorkspacePermission = (
  value: unknown,
): value is WorkspacePermission => {
  return typeof value === "string" && permissionSet.has(value);
};

/**
 * These capabilities must remain attached to the immutable owner role.
 * They cannot be assigned to a tenant-created custom role.
 */
export const OWNER_ONLY_PERMISSIONS = Object.freeze([
  WORKSPACE_PERMISSION.WORKSPACE_PUBLISH,
  WORKSPACE_PERMISSION.WORKSPACE_OWNERSHIP_TRANSFER,
  WORKSPACE_PERMISSION.WORKSPACE_DELETE,
  WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE,
]) as readonly WorkspacePermission[];

/**
 * A custom role cannot administer the authorization system itself. This
 * prevents a user from creating or assigning a second role with greater
 * privileges than the first one.
 */
export const RESERVED_CUSTOM_ROLE_PERMISSIONS = Object.freeze([
  ...OWNER_ONLY_PERMISSIONS,
  WORKSPACE_PERMISSION.TEAM_MANAGE,
  WORKSPACE_PERMISSION.ROLES_MANAGE,
  WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
]) as readonly WorkspacePermission[];

const reservedCustomPermissionSet = new Set<string>(
  RESERVED_CUSTOM_ROLE_PERMISSIONS,
);

export const isReservedCustomRolePermission = (
  permission: WorkspacePermission,
): boolean => reservedCustomPermissionSet.has(permission);

export const WORKSPACE_PERMISSION_CATALOG = Object.freeze(
  ALL_WORKSPACE_PERMISSIONS.map((key) => ({
    key,
    category: key.split(".")[0],
    ownerOnly: OWNER_ONLY_PERMISSIONS.includes(key),
    reservedForCustomRoles: RESERVED_CUSTOM_ROLE_PERMISSIONS.includes(key),
  })),
);
