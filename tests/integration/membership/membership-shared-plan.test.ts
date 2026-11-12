import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/membership/services/membership-notification.service.js", () => ({ enqueueMembershipNotification: vi.fn() }));
import Location from "@/modules/location/location.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import Product from "@/modules/product/product.model.js";
import Plan from "@/modules/membership/membership-plan.model.js";
import Version from "@/modules/membership/membership-plan-version.model.js";
import Membership from "@/modules/membership/user-membership.model.js";
import Balance from "@/modules/membership/membership-entitlement-balance.schema.js";
import Ledger from "@/modules/membership/membership-entitlement-ledger.schema.js";
import Audit from "@/modules/membership/membership-audit-event.schema.js";
import { membershipPlanService } from "@/modules/membership/services/membership-plan.service.js";
import { userMembershipService } from "@/modules/membership/services/user-membership.service.js";
import { redeemMembershipEntitlement } from "@/modules/membership/services/membership-entitlement.service.js";
import { createMembershipPlanSchema, assignMembershipSchema } from "@/modules/membership/membership.validators.js";

const ids = Object.fromEntries(["tenant", "otherTenant", "grohova", "vaclavska", "otherLocation", "member", "otherMember", "course", "foreignCourse", "voucher"].map((key) => [key, new mongoose.Types.ObjectId()]));
const tenantId = String(ids.tenant);
const modelList = [Tenant, Location, User, Product, Plan, Version, Membership, Balance, Ledger, Audit];
let db: MongoMemoryReplSet;
const planInput = (overrides = {}) => createMembershipPlanSchema.parse({
  name: "Klei Profi", prices: [{ currency: "CZK", amountMinor: 460000 }],
  billing: { type: "recurring", interval: "month", intervalCount: 1 },
  locationScope: { type: "shared_selected", locationIds: [String(ids.grohova), String(ids.vaclavska)] },
  benefits: [{ key: "studio_hours", label: "Hours", type: "allowance", unit: "minute", quantity: 1800, usageScope: "open_studio", memberOnly: true, rolloverPercent: 25 }],
  ...overrides,
});

describe("membership shared-location plan integration", () => {
  beforeAll(async () => {
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Promise.all(modelList.map((model: any) => model.init()));
  }, 60000);
  afterAll(async () => { await mongoose.disconnect(); await db?.stop(); });
  beforeEach(async () => {
    await Promise.all(modelList.map((model: any) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({ _id: ids.tenant, name: "Klei", slug: "klei", settings: { currency: "CZK", publicDefaultLanguage: "cs", supportedPublicLanguages: ["cs", "en"] } } as any);
    await Location.collection.insertMany([ids.grohova, ids.vaclavska, ids.otherLocation].map((_id) => ({ _id, tenant: ids.tenant, name: String(_id), slug: String(_id), code: String(_id), isActive: true })));
    await User.collection.insertOne({ _id: ids.member, tenant: ids.tenant, firstname: "Test", lastname: "Member", email: "member@example.test" });
    await Product.collection.insertMany([
      { _id: ids.course, tenant: ids.tenant, type: "course", name: "Course" },
      { _id: ids.foreignCourse, tenant: ids.otherTenant, type: "course", name: "Foreign course" },
      { _id: ids.voucher, tenant: ids.tenant, type: "gift-card", name: "Voucher" },
    ]);
  });

  it("creates a draft, publishes and assigns one pool, then consumes it at both locations", async () => {
    const plan = await membershipPlanService.create(tenantId, planInput());
    expect(plan.status).toBe("draft");
    expect(plan.publishedVersion).toBeNull();
    await membershipPlanService.publish(tenantId, plan.id);
    const membership = await userMembershipService.assign(tenantId, assignMembershipSchema.parse({ planId: plan.id, userId: String(ids.member), currency: "CZK", reason: "complimentary" }));
    expect(membership.selectedLocationId).toBeNull();
    expect(await Balance.countDocuments({ membership: membership.id })).toBe(1);
    for (const [index, location] of [ids.grohova, ids.vaclavska].entries()) {
      await redeemMembershipEntitlement({
        tenantId, userId: String(ids.member), benefitKey: "studio_hours", quantity: 90,
        locationId: String(location), reference: { type: "booking", id: `visit-${index}` }, idempotencyKey: `shared-studio-visit-${index}`,
        bookingContext: { productKind: "open_studio", bookingMode: "public", participantCount: 1, durationMinutes: 90 },
      });
    }
    expect((await Balance.findOne({ membership: membership.id }))?.available).toBe(1620);
    await expect(redeemMembershipEntitlement({ tenantId, userId: String(ids.member), benefitKey: "studio_hours", quantity: 60, locationId: String(ids.otherLocation), reference: { type: "booking", id: "outside" }, idempotencyKey: "outside-shared-studios" })).rejects.toMatchObject({ code: "MEMBERSHIP_LOCATION_NOT_ALLOWED" });
    const refreshed = await userMembershipService.detail(tenantId, membership.id);
    expect(refreshed.planSnapshot.locationScope.type).toBe("shared_selected");
  });

  it("rejects a billing-only edit that would invalidate existing rollover", async () => {
    const plan = await membershipPlanService.create(tenantId, planInput());
    await expect(membershipPlanService.update(tenantId, { id: plan.id, billing: { type: "fixed", durationDays: 30 } })).rejects.toThrow();
    const unchanged = await membershipPlanService.get(tenantId, plan.id);
    expect(unchanged.draftVersion.billing.type).toBe("recurring");
  });

  it("persists translations through drafts, publishing, assignment and duplication without changing existing snapshots", async () => {
    const translations = { en: { name: "Pro membership", description: "Studio time", terms: "Member only" } };
    const benefitTranslations = { en: { label: "Thirty studio hours" } };
    const initial = planInput();
    const plan = await membershipPlanService.create(tenantId, planInput({ translations, benefits: initial.benefits.map((benefit) => ({ ...benefit, translations: benefitTranslations })) }));
    expect(plan.draftVersion.translations).toEqual(translations);
    expect(plan.draftVersion.sourceLanguage).toBe("cs");
    expect(plan.draftVersion.benefits[0].translations).toEqual(benefitTranslations);
    const published = await membershipPlanService.publish(tenantId, plan.id);
    const membership = await userMembershipService.assign(tenantId, assignMembershipSchema.parse({ planId: plan.id, userId: String(ids.member), currency: "CZK", reason: "complimentary" }));
    expect(membership.planSnapshot.translations).toEqual(translations);
    expect(membership.planSnapshot.sourceLanguage).toBe("cs");
    expect(membership.planSnapshot.benefits[0].translations).toEqual(benefitTranslations);

    const edited = await membershipPlanService.update(tenantId, { id: plan.id, translations: { en: { ...translations.en, name: "New draft name" } } });
    expect(edited.draftVersion.translations.en.name).toBe("New draft name");
    expect(edited.draftVersion.benefits[0].translations).toEqual(benefitTranslations);
    expect(edited.publishedVersion.translations).toEqual(translations);
    expect((await userMembershipService.detail(tenantId, membership.id)).planSnapshot.translations).toEqual(translations);
    const duplicated = await membershipPlanService.duplicate(tenantId, plan.id, "Copy");
    expect(duplicated.draftVersion.translations).toEqual(edited.draftVersion.translations);
    expect(duplicated.draftVersion.sourceLanguage).toBe("cs");
    expect(duplicated.draftVersion.benefits[0].translations).toEqual(benefitTranslations);
    await expect(Version.updateOne({ _id: published.publishedVersion.id }, { $set: { "translations.en.name": "Overwrite" } })).rejects.toThrow();
  });

  it("retains disabled-language translations on unrelated edits and duplication but rejects new content for them", async () => {
    const translations = { en: { name: "Pro membership" } };
    const plan = await membershipPlanService.create(tenantId, planInput({ translations }));
    await Tenant.updateOne({ _id: ids.tenant }, { $set: { "settings.supportedPublicLanguages": ["cs", "de"] } });
    const edited = await membershipPlanService.update(tenantId, { id: plan.id, description: "Updated base text" });
    expect(edited.draftVersion.translations).toEqual(translations);
    expect((await membershipPlanService.duplicate(tenantId, plan.id, "Copy")).draftVersion.translations).toEqual(translations);
    await expect(membershipPlanService.update(tenantId, { id: plan.id, translations: { en: { name: "Changed" } } })).rejects.toMatchObject({ code: "MEMBERSHIP_TRANSLATION_LANGUAGE_NOT_ENABLED" });
    const cleared = await membershipPlanService.update(tenantId, { id: plan.id, translations: {} });
    expect(cleared.draftVersion.translations).toEqual({});
  });

  it("prevents publishing a plan without the studio's primary-currency price", async () => {
    const plan = await membershipPlanService.create(tenantId, planInput({ prices: [{ currency: "EUR", amountMinor: 18000 }] }));
    await expect(membershipPlanService.publish(tenantId, plan.id)).rejects.toMatchObject({ code: "MEMBERSHIP_PRIMARY_CURRENCY_PRICE_REQUIRED" });
    expect((await membershipPlanService.get(tenantId, plan.id)).status).toBe("draft");
  });

  it("retains the old base-language content when the tenant switches primary language", async () => {
    const input = planInput({ name: "Členství Profi", description: "Popis členství", terms: "Podmínky", translations: { en: { name: "Pro membership" } } });
    input.benefits[0].label = "Hodiny tvorby";
    const plan = await membershipPlanService.create(tenantId, input);
    await Tenant.updateOne({ _id: ids.tenant }, { $set: { "settings.publicDefaultLanguage": "en", "settings.supportedPublicLanguages": ["en", "de"] } });
    const translations = { cs: { name: input.name, description: input.description, terms: input.terms } };
    const benefits = input.benefits.map((benefit) => ({ ...benefit, label: "Studio hours", translations: { cs: { label: benefit.label } } }));
    const edited = await membershipPlanService.update(tenantId, { id: plan.id, sourceLanguage: "en", name: "Pro membership", description: "Membership description", terms: "Terms", translations, benefits });
    expect(edited.draftVersion).toMatchObject({ sourceLanguage: "en", name: "Pro membership", translations });
    expect(edited.draftVersion.benefits[0].translations.cs.label).toBe("Hodiny tvorby");
    await expect(membershipPlanService.update(tenantId, { id: plan.id, translations: { cs: { name: "New disabled-language text" } } })).rejects.toMatchObject({ code: "MEMBERSHIP_TRANSLATION_LANGUAGE_NOT_ENABLED" });
    expect((await membershipPlanService.publish(tenantId, plan.id)).publishedVersion.sourceLanguage).toBe("en");
  });

  it.each(["foreignCourse", "voucher"])("rejects a selected %s for the course discount", async (key) => {
    const benefits = [{ key: "course_discount", label: "Course discount", type: "percentage", appliesTo: "products", productScope: "courses", memberOnly: true, percentageBps: 1000, eligibleProductIds: [String(ids[key])] }];
    await expect(membershipPlanService.create(tenantId, planInput({ benefits }))).rejects.toMatchObject({ code: "MEMBERSHIP_COURSE_SELECTION_INVALID" });
    expect(await Plan.countDocuments()).toBe(0);
  });

  it("requires staff access to every location in a shared pool", async () => {
    await expect(membershipPlanService.create(tenantId, planInput(), [String(ids.grohova)])).rejects.toThrow();
    expect(await Plan.countDocuments()).toBe(0);
  });
});
