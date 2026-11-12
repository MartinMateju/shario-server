import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  resolveCustomerIdentity,
} from "@/modules/auth/social/customer-social.service.js";
import CustomerSocialIdentityModel from "@/modules/auth/social/customer-social-identity.schema.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const describeMongoIntegration =
  process.env.RUN_MONGO_INTEGRATION_TESTS === "true"
    ? describe
    : describe.skip;

const profile = (email: string, subject = "google-subject") => ({
  provider: "google" as const,
  subject,
  email,
  emailVerified: true as const,
  firstname: "Martin",
  lastname: "Mateju",
});

describeMongoIntegration(
  "customer social identity linkage",
  () => {
    beforeAll(async () => {
      await connectTestDatabase();
      await Promise.all([
        UserModel.syncIndexes(),
        CustomerSocialIdentityModel.syncIndexes(),
        TenantMembershipModel.syncIndexes(),
      ]);
    });
    beforeEach(clearTestDatabase);
    afterAll(disconnectTestDatabase);

    it("links a verified identity to an existing customer without workspace access", async () => {
      const tenant = await TenantModel.create({
        name: "Studio Olivka",
        slug: "studio-olivka",
      });
      const customer = await UserModel.create({
        tenant: tenant._id,
        firstname: "Martin",
        lastname: "Mateju",
        email: "martin@example.test",
        password: "customer-password-123",
        customId: "U-CUSTOMER-1",
        tenantRole: "customer",
        platformRole: "none",
        isAccessGranted: true,
      });

      const resolved = await resolveCustomerIdentity({
        tenantId: String(tenant._id),
        profile: profile(customer.email),
      });
      const identity = await CustomerSocialIdentityModel.findOne({
        tenant: tenant._id,
        provider: "google",
        subject: "google-subject",
      }).lean();

      expect(String(resolved._id)).toBe(String(customer._id));
      expect(String(identity?.user)).toBe(String(customer._id));
    });

    it("links an owner identity only to explicit customer mode without changing workspace membership", async () => {
      const tenant = await TenantModel.create({
        name: "Studio Olivka",
        slug: "studio-olivka",
      });
      const owner = await UserModel.create({
        tenant: tenant._id,
        firstname: "Studio",
        lastname: "Owner",
        email: "owner@example.test",
        password: "workspace-password-123",
        customId: "U-OWNER-1",
        tenantRole: "owner",
        platformRole: "none",
        isAccessGranted: true,
      });
      const membership = await TenantMembershipModel.create({
        tenant: tenant._id,
        user: owner._id,
        status: "active",
        role: "owner",
        createdBy: owner._id,
        updatedBy: owner._id,
      });

      const resolved = await resolveCustomerIdentity({
        tenantId: String(tenant._id),
        profile: profile(owner.email),
      });
      const reloadedMembership = await TenantMembershipModel.findById(
        membership._id,
      ).lean();

      expect(String(resolved._id)).toBe(String(owner._id));
      expect(
        await CustomerSocialIdentityModel.countDocuments(),
      ).toBe(1);
      expect(reloadedMembership).toMatchObject({
        status: "active",
        role: "owner",
      });
    });

    it("claims the generated guest course customer while preserving its id and history", async () => {
      const tenant = await TenantModel.create({
        name: "Studio Olivka",
        slug: "studio-olivka",
      });
      const guest = await UserModel.create({
        tenant: tenant._id,
        firstname: "Course",
        lastname: "Guest",
        email: "guest@example.test",
        password: "unguessable-guest-password",
        customId: "G-0123456789abcdefabcd",
        tenantRole: "customer",
        platformRole: "none",
        isAccessGranted: false,
      });

      const resolved = await resolveCustomerIdentity({
        tenantId: String(tenant._id),
        profile: profile(guest.email, "guest-google-subject"),
      });
      const reloaded = await UserModel.findById(guest._id).lean();

      expect(String(resolved._id)).toBe(String(guest._id));
      expect(reloaded?.isAccessGranted).toBe(true);
      expect(reloaded?.isEmailVerified).toBe(true);
    });

    it("does not reactivate an ordinary suspended customer", async () => {
      const tenant = await TenantModel.create({
        name: "Studio Olivka",
        slug: "studio-olivka",
      });
      const suspended = await UserModel.create({
        tenant: tenant._id,
        firstname: "Suspended",
        lastname: "Customer",
        email: "suspended@example.test",
        password: "customer-password-123",
        customId: "U-SUSPENDED-1",
        tenantRole: "customer",
        platformRole: "none",
        isAccessGranted: false,
      });

      await expect(
        resolveCustomerIdentity({
          tenantId: String(tenant._id),
          profile: profile(suspended.email),
        }),
      ).rejects.toMatchObject({
        code: "CUSTOMER_SOCIAL_ACCOUNT_DISABLED",
      });
    });
  },
);
