import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  updateUser: vi.fn(),
  findTenant: vi.fn(),
  ensureUserMemberNumber: vi.fn(),
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.findUser, findOneAndUpdate: mocks.updateUser },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findById: mocks.findTenant },
}));
vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  ensureUserMemberNumber: mocks.ensureUserMemberNumber,
}));

import {
  getCurrentAccount,
  updateCurrentAccountProfile,
  updateCurrentCustomerPreferences,
} from "@/modules/account/account.service.js";
import { PORTAL_APPEARANCE_COLOR_KEYS } from "@/shared/appearance/portal-appearance.js";

const tenantId = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";
const user = {
  _id: userId,
  tenant: tenantId,
  firstname: "Alena",
  lastname: "Novak",
  email: "alena@example.test",
  customId: "U-42",
  memberNumber: 42,
  customerDefaultLanguage: "cs",
};
const query = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

describe("customer preference persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTenant.mockReturnValue(
      query({
        settings: {
          publicDefaultLanguage: "cs",
          supportedPublicLanguages: ["cs", "en"],
        },
      }),
    );
    mocks.findUser.mockReturnValue(query(user));
    mocks.updateUser.mockReturnValue(query(user));
  });

  it("saves a personal palette atomically for the signed-in tenant and user without changing language or other palette fields", async () => {
    mocks.updateUser.mockReturnValue(
      query({
        ...user,
        portalAppearance: {
          backgroundColor: "#112233",
          textColor: "#FAFAFA",
          headerBackgroundColor: "#445566",
        },
      }),
    );
    const result = await updateCurrentCustomerPreferences({
      tenantId,
      userId,
      input: {
        portalAppearance: { backgroundColor: "#112233", textColor: "#FAFAFA" },
      },
    });
    expect(mocks.updateUser).toHaveBeenCalledWith(
      { _id: userId, tenant: tenantId },
      {
        $set: {
          "portalAppearance.backgroundColor": "#112233",
          "portalAppearance.textColor": "#FAFAFA",
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    expect(result.portalAppearance).toMatchObject({
      backgroundColor: "#112233",
      textColor: "#FAFAFA",
      headerBackgroundColor: "#445566",
    });
    expect(result.customerDefaultLanguage).toBe("cs");
    expect(mocks.findTenant).not.toHaveBeenCalled();
  });

  it("resets every personal color to inheritance without changing the studio configuration", async () => {
    const portalAppearance = Object.fromEntries(
      PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [key, ""]),
    );
    mocks.updateUser.mockReturnValue(query({ ...user, portalAppearance }));
    const result = await updateCurrentCustomerPreferences({
      tenantId,
      userId,
      input: { portalAppearance },
    });
    expect(result.portalAppearance).toEqual(portalAppearance);
    expect(mocks.updateUser.mock.calls[0][1].$set).toEqual(
      Object.fromEntries(
        PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [
          `portalAppearance.${key}`,
          "",
        ]),
      ),
    );
    expect(mocks.findTenant).not.toHaveBeenCalled();
  });

  it("uses both tenant and customer filters when a personal palette belongs to another account", async () => {
    mocks.updateUser.mockReturnValue(query(null));
    await expect(
      updateCurrentCustomerPreferences({
        tenantId,
        userId,
        input: { portalAppearance: { backgroundColor: "#112233" } },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.updateUser.mock.calls[0][0]).toEqual({
      _id: userId,
      tenant: tenantId,
    });
  });

  it("reads personal preferences only for the current account and fills missing legacy fields with inheritance", async () => {
    mocks.findUser.mockReturnValue(
      query({ ...user, portalAppearance: { textColor: "#aabbcc" } }),
    );
    const result = await getCurrentAccount({ tenantId, userId });
    expect(mocks.findUser).toHaveBeenCalledWith({
      _id: userId,
      tenant: tenantId,
    });
    expect(result.portalAppearance).toEqual({
      ...Object.fromEntries(
        PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [key, ""]),
      ),
      textColor: "#AABBCC",
    });
    expect(mocks.findUser.mock.results[0].value.select).toHaveBeenCalledWith(
      expect.stringContaining("+portalAppearance"),
    );
  });

  it.each(["cs", "en"] as const)(
    "saves an available language %s with tenant and user scope and a narrow atomic update",
    async (locale) => {
      mocks.updateUser.mockReturnValue(
        query({ ...user, customerDefaultLanguage: locale }),
      );
      const result = await updateCurrentCustomerPreferences({
        tenantId,
        userId,
        input: { defaultLanguage: locale },
      });

      expect(mocks.findTenant).toHaveBeenCalledWith(tenantId);
      expect(mocks.updateUser).toHaveBeenCalledWith(
        { _id: userId, tenant: tenantId },
        { $set: { customerDefaultLanguage: locale } },
        { returnDocument: "after", runValidators: true },
      );
      expect(result).toMatchObject({
        id: userId,
        customerDefaultLanguage: locale,
        firstname: "Alena",
        memberNumber: 42,
      });
      expect(mocks.ensureUserMemberNumber).not.toHaveBeenCalled();
    },
  );

  it("resets to studio default without materializing the current primary language", async () => {
    mocks.updateUser.mockReturnValue(
      query({ ...user, customerDefaultLanguage: null }),
    );
    const result = await updateCurrentCustomerPreferences({
      tenantId,
      userId,
      input: { defaultLanguage: null },
    });
    expect(result.customerDefaultLanguage).toBeNull();
    expect(mocks.updateUser).toHaveBeenCalledWith(
      { _id: userId, tenant: tenantId },
      { $set: { customerDefaultLanguage: null } },
      { returnDocument: "after", runValidators: true },
    );
    expect(mocks.findTenant).not.toHaveBeenCalled();
  });

  it("rejects a registry language that the studio does not offer without writing", async () => {
    await expect(
      updateCurrentCustomerPreferences({
        tenantId,
        userId,
        input: { defaultLanguage: "de" },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOMER_LANGUAGE_UNAVAILABLE",
    });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("honors historical CZ settings as the studio's language", async () => {
    mocks.findTenant.mockReturnValue(
      query({ settings: { defaultLanguage: "CZ" } }),
    );
    await expect(
      updateCurrentCustomerPreferences({
        tenantId,
        userId,
        input: { defaultLanguage: "cs" },
      }),
    ).resolves.toMatchObject({ customerDefaultLanguage: "cs" });
  });

  it("cannot update another tenant's account when the scoped user does not exist", async () => {
    mocks.updateUser.mockReturnValue(query(null));
    await expect(
      updateCurrentCustomerPreferences({
        tenantId,
        userId,
        input: { defaultLanguage: "cs" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.updateUser.mock.calls[0][0]).toEqual({
      _id: userId,
      tenant: tenantId,
    });
  });

  it("does not write for a missing studio", async () => {
    mocks.findTenant.mockReturnValue(query(null));
    await expect(
      updateCurrentCustomerPreferences({
        tenantId,
        userId,
        input: { defaultLanguage: "cs" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("reads null for legacy accounts and retains stored choices if a studio removes that language", async () => {
    mocks.findUser.mockReturnValueOnce(
      query({ ...user, customerDefaultLanguage: undefined }),
    );
    expect(
      (await getCurrentAccount({ tenantId, userId })).customerDefaultLanguage,
    ).toBeNull();

    mocks.findTenant.mockReturnValue(
      query({
        settings: {
          publicDefaultLanguage: "en",
          supportedPublicLanguages: ["en"],
        },
      }),
    );
    expect(
      (await getCurrentAccount({ tenantId, userId })).customerDefaultLanguage,
    ).toBe("cs");
    expect(mocks.findTenant).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("keeps the preference on unrelated profile edits and selects it for subsequent reads", async () => {
    const document = { ...user, save: vi.fn(), toObject: vi.fn() };
    document.toObject.mockImplementation(() => document);
    const accountQuery = query(document);
    mocks.findUser.mockReturnValue(accountQuery);
    const result = await updateCurrentAccountProfile({
      tenantId,
      userId,
      input: { firstname: "Alice" },
    });
    expect(document.customerDefaultLanguage).toBe("cs");
    expect(document.save).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      firstname: "Alice",
      customerDefaultLanguage: "cs",
    });
    expect(accountQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("customerDefaultLanguage"),
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
