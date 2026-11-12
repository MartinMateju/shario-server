import { describe, expect, it } from "vitest";
import UserModel from "@/modules/user/user.model.js";
import { getCustomerContactEmail, withWorkspaceContact } from "@/modules/user/user.guest-contact.js";
import { serializeCustomer } from "@/modules/user/user.serializers.js";

const guest = {
  _id: "507f1f77bcf86cd799439099",
  firstname: "Guest",
  customId: "G-0123456789abcdefabcd",
  isAccessGranted: false,
  guestContact: { email: "buyer@example.test", locale: "cs" },
};

describe("non-login guest contact", () => {
  it("stores guest contact separately from the authentication email", () => {
    const user = new UserModel({ ...guest, tenant: guest._id });
    expect(user.email).toBeUndefined();
    expect(user.password).toBeUndefined();
    expect(user.guestContact?.email).toBe("buyer@example.test");
    expect(UserModel.schema.path("guestContact").options.select).toBe(false);
  });

  it("shows the buyer contact in workspace customer views without leaking the private object", () => {
    expect(serializeCustomer(guest)).toMatchObject({
      email: "buyer@example.test", isAccessGranted: false, isEmailVerified: false,
    });
    expect(withWorkspaceContact(guest)).toMatchObject({ email: "buyer@example.test" });
    expect(withWorkspaceContact(guest)).not.toHaveProperty("guestContact");
    expect(guest).not.toHaveProperty("email");
  });

  it.each([
    { ...guest, customId: "U-existing" },
    { ...guest, isAccessGranted: true },
  ])("never treats guest contact as a registered account's email", (user) => {
    expect(getCustomerContactEmail(user)).toBe("");
  });
});
