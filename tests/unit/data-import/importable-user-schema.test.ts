import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import UserModel from "@/modules/user/user.model.js";

describe("importable customer schema", () => {
  it("allows a contact-only customer while preserving manual auth validation", async () => {
    const user = new UserModel({
      tenant: new mongoose.Types.ObjectId(),
      firstname: "Madonna",
      lastname: "",
      phone: "",
      customId: "IMP-TEST",
    });
    await expect(user.validate()).resolves.toBeUndefined();
    await expect(
      (
        user as typeof user & {
          matchPassword(value: string): Promise<boolean>;
        }
      ).matchPassword("anything"),
    ).resolves.toBe(false);
    expect(user.email).toBeUndefined();
    expect(user.password).toBeUndefined();
  });

  it("defines partial tenant email and import idempotency indexes", () => {
    const indexes = UserModel.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { tenant: 1, email: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { email: { $type: "string" } },
          }),
        ],
        [
          { tenant: 1, "importMetadata.importKey": 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });
});
