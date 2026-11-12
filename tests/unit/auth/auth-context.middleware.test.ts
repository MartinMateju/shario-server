import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userMocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  select: vi.fn(),
  lean: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: userMocks.findOne,
  },
}));

import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import {
  assertAuthContext,
  getRequestAuthContext,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";

const requestWithContext = (authContext?: "workspace" | "customer"): Request =>
  ({
    userInfo: {
      authContext,
    },
  }) as unknown as Request;

describe("authentication context middleware", () => {
  it("accepts only the matching signed context", () => {
    expect(() =>
      assertAuthContext(
        requestWithContext(AUTH_CONTEXT.CUSTOMER),
        AUTH_CONTEXT.CUSTOMER,
      ),
    ).not.toThrow();

    expect(() =>
      assertAuthContext(
        requestWithContext(AUTH_CONTEXT.CUSTOMER),
        AUTH_CONTEXT.WORKSPACE,
      ),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: "WORKSPACE_SESSION_REQUIRED",
      }),
    );

    expect(() =>
      assertAuthContext(
        requestWithContext(AUTH_CONTEXT.WORKSPACE),
        AUTH_CONTEXT.CUSTOMER,
      ),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: "CUSTOMER_SESSION_REQUIRED",
      }),
    );
  });

  it("treats a request missing verified user information as unauthenticated", () => {
    expect(() => getRequestAuthContext({} as Request)).toThrowError(
      expect.objectContaining({
        statusCode: 401,
        code: "AUTHENTICATION_REQUIRED",
      }),
    );
  });
});

const ACCESS_TOKEN_SECRET =
  "legacy-access-token-context-test-secret-that-is-long-enough";
const USER_ID = "507f1f77bcf86cd799439011";
const TENANT_ID = "507f191e810c19729de860ea";
const SESSION_VERSION = 4;

const createLegacyRequest = (
  claims: Record<string, unknown>,
): AuthenticatedRequest => {
  const token = jwt.sign(
    {
      UserInfo: {
        id: USER_ID,
        email: "legacy@example.test",
        tenant: TENANT_ID,
        sessionVersion: SESSION_VERSION,
        ...claims,
      },
    },
    ACCESS_TOKEN_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "5m",
    },
  );

  return {
    headers: {
      authorization: "Bearer " + token,
    },
  } as AuthenticatedRequest;
};

const verifyLegacyAccessToken = async (
  claims: Record<string, unknown>,
): Promise<AuthenticatedRequest> => {
  const req = createLegacyRequest(claims);
  const next = vi.fn();

  await verifyJWT(req, {} as Response, next);

  expect(next).toHaveBeenCalledOnce();
  expect(userMocks.findOne).toHaveBeenCalledWith({
    _id: USER_ID,
    tenant: TENANT_ID,
  });
  expect(userMocks.select).toHaveBeenCalledWith(
    "+sessionVersion isAccessGranted",
  );

  return req;
};

describe("DB-backed legacy access-token authentication context", () => {
  const previousSecret = process.env.ACCESS_TOKEN_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;

    userMocks.findOne.mockReturnValue({
      select: userMocks.select,
    });
    userMocks.select.mockReturnValue({
      lean: userMocks.lean,
    });
    userMocks.lean.mockReturnValue({
      exec: userMocks.exec,
    });
    userMocks.exec.mockResolvedValue({
      sessionVersion: SESSION_VERSION,
      isAccessGranted: true,
    });
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.ACCESS_TOKEN_SECRET;
    } else {
      process.env.ACCESS_TOKEN_SECRET = previousSecret;
    }
  });

  it("infers a strict pure legacy customer as customer-only", async () => {
    const req = await verifyLegacyAccessToken({
      tenantRole: "customer",
      platformRole: "none",
      membershipId: null,
      workspaceRole: null,
      authorizationVersion: null,
      isAdmin: false,
      isModerator: false,
    });

    expect(req.userInfo?.authContext).toBe(AUTH_CONTEXT.CUSTOMER);
    expect(() => assertAuthContext(req, AUTH_CONTEXT.CUSTOMER)).not.toThrow();
    expect(() => assertAuthContext(req, AUTH_CONTEXT.WORKSPACE)).toThrowError(
      expect.objectContaining({
        code: "WORKSPACE_SESSION_REQUIRED",
      }),
    );
  });

  it("keeps a legacy owner in the workspace context", async () => {
    const req = await verifyLegacyAccessToken({
      tenantRole: "owner",
      platformRole: "none",
      membershipId: "507f1f77bcf86cd799439012",
      workspaceRole: "owner",
      authorizationVersion: 3,
      isAdmin: true,
      isModerator: false,
    });

    expect(req.userInfo?.authContext).toBe(AUTH_CONTEXT.WORKSPACE);
    expect(() => assertAuthContext(req, AUTH_CONTEXT.WORKSPACE)).not.toThrow();
    expect(() => assertAuthContext(req, AUTH_CONTEXT.CUSTOMER)).toThrowError(
      expect.objectContaining({
        code: "CUSTOMER_SESSION_REQUIRED",
      }),
    );
  });

  it.each([
    {
      name: "platform role",
      evidence: {
        platformRole: "admin",
      },
    },
    {
      name: "membership",
      evidence: {
        membershipId: "507f1f77bcf86cd799439012",
      },
    },
    {
      name: "workspace role",
      evidence: {
        workspaceRole: "staff",
      },
    },
    {
      name: "authorization version",
      evidence: {
        authorizationVersion: 0,
      },
    },
    {
      name: "admin flag",
      evidence: {
        isAdmin: true,
      },
    },
    {
      name: "moderator flag",
      evidence: {
        isModerator: true,
      },
    },
  ])(
    "does not reinterpret customer claims with $name evidence",
    async ({ evidence }) => {
      const req = await verifyLegacyAccessToken({
        tenantRole: "customer",
        platformRole: "none",
        membershipId: null,
        workspaceRole: null,
        authorizationVersion: null,
        isAdmin: false,
        isModerator: false,
        ...evidence,
      });

      expect(req.userInfo?.authContext).toBe(AUTH_CONTEXT.WORKSPACE);
      expect(() => assertAuthContext(req, AUTH_CONTEXT.CUSTOMER)).toThrowError(
        expect.objectContaining({
          code: "CUSTOMER_SESSION_REQUIRED",
        }),
      );
    },
  );

  it("rejects context inference when the persisted session generation changed", async () => {
    userMocks.exec.mockResolvedValueOnce({
      sessionVersion: SESSION_VERSION + 1,
      isAccessGranted: true,
    });
    const req = createLegacyRequest({
      tenantRole: "customer",
      platformRole: "none",
      membershipId: null,
      workspaceRole: null,
      authorizationVersion: null,
      isAdmin: false,
      isModerator: false,
    });

    await expect(verifyJWT(req, {} as Response, vi.fn())).rejects.toMatchObject(
      {
        statusCode: 401,
        message: "Access session is no longer valid.",
      },
    );

    expect(req.userInfo).toBeUndefined();
  });
});
