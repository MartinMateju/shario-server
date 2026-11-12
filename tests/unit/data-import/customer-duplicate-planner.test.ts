import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: vi.fn(),
}));

import {
  buildExistingIndexes,
  customerFileIdentityKeys,
  findExistingDuplicate,
  type ExistingCustomer,
} from "@/modules/data-import/services/data-import.service.js";

describe("customer import duplicate planner", () => {
  it("matches external id, email and normalized phone within the current tenant set", () => {
    const user = {
      _id: new mongoose.Types.ObjectId(),
      email: "anna@example.com",
      phone: "+420 777 123 456",
      importMetadata: { externalId: "legacy-1" },
    } as ExistingCustomer;
    const indexes = buildExistingIndexes([user]);

    expect(
      findExistingDuplicate(
        {
          firstname: "Anna",
          lastname: "Novak",
          externalId: "legacy-1",
          email: "anna@example.com",
          phone: "+420777123456",
        },
        indexes,
      ),
    ).toEqual({
      conflict: false,
      duplicate: {
        kind: "externalId",
        existingUserId: user._id,
      },
    });
  });

  it("fails closed when identifiers point to different customers", () => {
    const first = {
      _id: new mongoose.Types.ObjectId(),
      email: "anna@example.com",
    } as ExistingCustomer;
    const second = {
      _id: new mongoose.Types.ObjectId(),
      importMetadata: { externalId: "legacy-1" },
    } as ExistingCustomer;
    const indexes = buildExistingIndexes([first, second]);

    expect(
      findExistingDuplicate(
        {
          firstname: "Anna",
          lastname: "Novak",
          externalId: "legacy-1",
          email: "anna@example.com",
        },
        indexes,
      ),
    ).toEqual({ conflict: true, duplicate: null });
  });

  it("fails closed when a legacy external id is already ambiguous", () => {
    const indexes = buildExistingIndexes([
      {
        _id: new mongoose.Types.ObjectId(),
        importMetadata: { externalId: "legacy-1" },
      } as ExistingCustomer,
      {
        _id: new mongoose.Types.ObjectId(),
        importMetadata: { externalId: "legacy-1" },
      } as ExistingCustomer,
    ]);

    expect(
      findExistingDuplicate(
        {
          firstname: "Anna",
          lastname: "Novak",
          externalId: "legacy-1",
        },
        indexes,
      ),
    ).toEqual({ conflict: true, duplicate: null });
  });

  it("never matches by name alone", () => {
    const indexes = buildExistingIndexes([
      {
        _id: new mongoose.Types.ObjectId(),
        email: "anna@example.com",
      } as ExistingCustomer,
    ]);
    expect(
      findExistingDuplicate({ firstname: "Anna", lastname: "Novak" }, indexes),
    ).toEqual({ conflict: false, duplicate: null });
  });

  it("tracks every available in-file identity instead of only the first", () => {
    expect(
      customerFileIdentityKeys({
        firstname: "Anna",
        lastname: "Novak",
        externalId: "legacy-1",
        email: "anna@example.com",
        phone: "+420777123456",
      }),
    ).toEqual([
      { kind: "externalId", value: "legacy-1" },
      { kind: "email", value: "anna@example.com" },
      { kind: "phone", value: "+420777123456" },
    ]);
  });
});
