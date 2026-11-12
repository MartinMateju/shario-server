export const TENANT_STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CANCELED: "canceled",
} as const;

export const TENANT_PLAN = {
  STARTER: "starter",
  PROFESSIONAL: "professional",
  STUDIO_PLUS: "studio_plus",
  ENTERPRISE: "enterprise",
} as const;

export const TENANT_DOMAIN_TYPE = {
  SUBDOMAIN: "subdomain",
  CUSTOM: "custom",
} as const;

export const TENANT_DOMAIN_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  ACTIVE: "active",
  FAILED: "failed",
} as const;

export const TENANT_LANGUAGE = {
  CZ: "CZ",
  EN: "EN",
} as const;

export const TENANT_LANGUAGES = Object.values(TENANT_LANGUAGE);

export const TENANT_MODULE = {
  BOOKINGS: "bookings",
  PAYMENTS: "payments",
  CUSTOMERS: "customers",
  COURSES: "courses",
  MEMBERSHIPS: "memberships",
  CREDITS: "credits",
  VOUCHERS: "vouchers",
  ACCESS_CODES: "access_codes",
  AUTOMATIONS: "automations",
  NEWSLETTER: "newsletter",
  FIRING: "firing",
  INVENTORY: "inventory",
  STAFF_TASKS: "staff_tasks",
  COMMUNICATIONS: "communications",
  AI: "ai",
} as const;

/*
 * Stable workspace-navigation keys shared by the settings API and the client.
 * Overview and Settings are intentionally absent: they are permanent anchors
 * and cannot be hidden by a workspace owner.
 */
export const TENANT_WORKSPACE_NAVIGATION_GROUP = {
  BOOKINGS: "bookings",
  STUDIO: "studio",
  SALES: "sales",
  MESSAGES: "messages",
} as const;

export const TENANT_WORKSPACE_NAVIGATION_ITEM = {
  CALENDAR: "calendar",
  BOOKINGS: "bookings",
  COURSES_EVENTS: "coursesEvents",
  CUSTOMERS: "customers",
  STUDIO_FLOW: "firing",
  INVENTORY: "inventory",
  STAFF_PLANNING: "staffPlanning",
  KNOWLEDGE: "knowledge",
  SALES_OVERVIEW: "sales",
  CUSTOM_ORDERS: "customOrders",
  PRODUCTS: "products",
  INVOICES: "invoices",
  INBOX: "messages",
  AUTOMATIONS: "automations",
  TEMPLATES: "templates",
  REPORTS: "reports",
} as const;

export const TENANT_WORKSPACE_CONFIGURATION_DEFINITION_VERSION = 1;

export const TENANT_WORKSPACE_INTENT_DEFINITION_VERSION = 2;

export const TENANT_WORKSPACE_PRICING_MODE = {
  TIME: "time",
  
  
} as const;

export const TENANT_WORKSPACE_INTENT_ANSWER = {
  SHARED_STUDIO: "sharedStudio",
  CLASSES: "classes",
  FIRING_SERVICES: "firingServices",
  MEMBERSHIPS: "memberships",
  VOUCHERS: "vouchers",
  INVENTORY: "inventory",
} as const;

export const TENANT_WORKSPACE_INTENT_SOURCE = {
  OWNER: "owner",
  LEGACY: "legacy",
} as const;

export const DEFAULT_TENANT_TIMEZONE = "Europe/Prague";
// Backwards-compatible name used throughout the tenant module. The complete
// supported set lives in shared/money so billing and commerce use one source
// of truth.
export { DEFAULT_STUDIO_COMMERCE_CURRENCY as DEFAULT_TENANT_CURRENCY } from "@/shared/money/currency.js";

export const PLATFORM_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "shario.io",
  "www.shario.io",
  "app.shario.io",
  "admin.shario.io",
]);
