import { describe, expect, it } from "vitest";

import {
  buildConversationVisibilityFilter,
  canViewRestrictedConversation,
  isWorkspaceWideCommunicationAccess,
} from "@/modules/communications/communication.access.js";
import {
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_A = "507f1f77bcf86cd799439013";
const LOCATION_B = "507f1f77bcf86cd799439014";

describe("communications tenant and conversation visibility", () => {
  it.each([WORKSPACE_ROLE.OWNER, WORKSPACE_ROLE.ADMIN] as const)(
    "gives %s the workspace-wide All conversations view",
    (role) => {
      expect(isWorkspaceWideCommunicationAccess(role)).toBe(true);
      expect(
        buildConversationVisibilityFilter({
          tenantId: TENANT_ID,
          userId: USER_ID,
          role,
          allowedLocationIds: [LOCATION_A],
          view: "all",
        }),
      ).toEqual({ tenantId: TENANT_ID, deletedAt: null });
    },
  );

  it.each([
    WORKSPACE_ROLE.MANAGER,
    WORKSPACE_ROLE.STAFF,
    WORKSPACE_ROLE.VIEWER,
    WORKSPACE_ROLE.CUSTOM,
    null,
  ] as const)("does not treat %s as workspace-wide access", (role) => {
    expect(isWorkspaceWideCommunicationAccess(role)).toBe(false);
  });

  it("always pins the Mongo filter to the authenticated tenant", () => {
    const filter = buildConversationVisibilityFilter({
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: WORKSPACE_ROLE.STAFF,
      allowedLocationIds: [LOCATION_A],
    });

    expect(filter).toMatchObject({
      $and: expect.arrayContaining([
        { tenantId: TENANT_ID, deletedAt: null },
      ]),
    });
    expect(JSON.stringify(filter)).not.toContain("$ne\":\"" + TENANT_ID);
  });

  it("scopes staff to granted locations while retaining directly assigned unlocated work", () => {
    expect(
      buildConversationVisibilityFilter({
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: WORKSPACE_ROLE.STAFF,
        allowedLocationIds: [LOCATION_A, LOCATION_B],
      }),
    ).toEqual({
      $and: [
        { tenantId: TENANT_ID, deletedAt: null },
        {
          $or: [
            { locationId: { $in: [LOCATION_A, LOCATION_B] } },
            { locationId: null, assignedTo: USER_ID },
            { locationId: null, allowedUserIds: USER_ID },
          ],
        },
        {
          $or: [
            { restricted: false },
            { assignedTo: USER_ID },
            { allowedUserIds: USER_ID },
            { createdBy: USER_ID },
          ],
        },
      ],
    });
  });

  it("fails closed for an empty selected-location grant", () => {
    const filter = buildConversationVisibilityFilter({
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: WORKSPACE_ROLE.STAFF,
      allowedLocationIds: [],
    });

    expect(filter).toMatchObject({
      $and: expect.arrayContaining([
        {
          $or: expect.arrayContaining([{ locationId: { $in: [] } }]),
        },
      ]),
    });
  });

  it("lets non-owner staff see a restricted conversation only through its ACL", () => {
    const restricted = {
      restricted: true,
      assignedTo: "someone-else",
      allowedUserIds: [USER_ID],
      createdBy: "someone-else",
    };

    expect(
      canViewRestrictedConversation({
        conversation: restricted,
        userId: USER_ID,
        role: WORKSPACE_ROLE.STAFF,
      }),
    ).toBe(true);
    expect(
      canViewRestrictedConversation({
        conversation: restricted,
        userId: "unrelated-user",
        role: WORKSPACE_ROLE.STAFF,
      }),
    ).toBe(false);
  });

  it("keeps restricted conversations visible to the owner and admin", () => {
    const conversation = {
      restricted: true,
      assignedTo: "someone-else",
      allowedUserIds: [],
    };

    expect(
      canViewRestrictedConversation({
        conversation,
        userId: USER_ID,
        role: WORKSPACE_ROLE.OWNER,
      }),
    ).toBe(true);
    expect(
      canViewRestrictedConversation({
        conversation,
        userId: USER_ID,
        role: WORKSPACE_ROLE.ADMIN,
      }),
    ).toBe(true);
  });

  it("supports responsibility views without weakening tenant or privacy clauses", () => {
    const mine = buildConversationVisibilityFilter({
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: WORKSPACE_ROLE.STAFF,
      allowedLocationIds: null,
      view: "mine",
      includeRestricted: false,
    });

    expect(mine).toEqual({
      $and: [
        { tenantId: TENANT_ID, deletedAt: null },
        { restricted: false },
        { assignedTo: USER_ID },
      ],
    });
  });

  it.each([
    ["unassigned", { assignedTo: null }],
    ["needs_review", { "ai.status": "needs_review" }],
    ["unmatched", { "customerMatch.status": "unmatched" }],
    ["urgent", { priority: "urgent", status: { $ne: "closed" } }],
    ["closed", { status: "closed" }],
  ] as const)("adds the %s view predicate", (view, predicate) => {
    expect(
      buildConversationVisibilityFilter({
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: WORKSPACE_ROLE.OWNER,
        view,
      }),
    ).toEqual({
      $and: [{ tenantId: TENANT_ID, deletedAt: null }, predicate],
    });
  });
});
