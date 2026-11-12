import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  REDACTED_LOG_VALUE,
  SENSITIVE_LOG_REDACTION_PATHS,
  getRequestLogPath,
  sanitizeLogArguments,
  sanitizeUrlForLog,
  serializeErrorForLog,
  serializeRequestForLog,
} from "@/shared/logging/request-log-sanitization.js";

describe("request log sanitization", () => {
  it("redacts voucher bearer codes from structured data and error text", () => {
    const output: string[] = [];
    const testLogger = pino({ base: undefined, timestamp: false,
      redact: { paths: SENSITIVE_LOG_REDACTION_PATHS, censor: REDACTED_LOG_VALUE },
      serializers: { err: serializeErrorForLog },
      hooks: { logMethod(args, method) { method.apply(this, sanitizeLogArguments(args)); } },
    }, { write: (chunk: string) => output.push(chunk) });
    testLogger.error({ voucherCode: "CHECKOUT-GIFT-001", purchase: { promoCodesSnapshot: ["PDF-GIFT-002"], promoCode: "WALLET-GIFT-003" }, err: new Error("voucherCode=ERROR-GIFT-004 promo_code=ERROR-GIFT-005") }, "Voucher request failed");
    const serialized = output.join("");
    for (const secret of ["CHECKOUT-GIFT-001", "PDF-GIFT-002", "WALLET-GIFT-003", "ERROR-GIFT-004", "ERROR-GIFT-005"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("Voucher request failed");
    expect(serialized).toContain(REDACTED_LOG_VALUE);
  });
  it.each([
    {
      name: "customer OAuth callback",
      request: {
        method: "GET",
        originalUrl:
          "/auth/customer/social/google/callback?code=provider-code&state=oauth-state",
        params: { provider: "google" },
        query: { code: "provider-code", state: "oauth-state" },
      },
      expected: "/auth/customer/social/:provider/callback",
    },
    {
      name: "Instagram webhook verification",
      request: {
        method: "GET",
        originalUrl:
          "/webhooks/communications/instagram?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=challenge-secret",
        params: {},
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": "verify-secret",
          "hub.challenge": "challenge-secret",
        },
      },
      expected: "/webhooks/communications/instagram",
    },
    {
      name: "public satisfaction bearer route",
      request: {
        method: "POST",
        originalUrl:
          "/communications/satisfaction/8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww",
        params: {
          token: "8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww",
        },
        query: {},
      },
      expected: "/communications/satisfaction/:token",
    },
  ])("uses a query-free route template for $name", ({ request, expected }) => {
    const path = getRequestLogPath(request as any);

    expect(path).toBe(expected);
    expect(path).not.toContain("provider-code");
    expect(path).not.toContain("oauth-state");
    expect(path).not.toContain("verify-secret");
    expect(path).not.toContain("challenge-secret");
    expect(path).not.toContain("8npXFLiq");
  });

  it("redacts a high-entropy bearer segment when no Express route matched", () => {
    const token = "wJalrXUtnFEMI_K7MDENG_bPxRfiCYEXAMPLEKEY";

    expect(
      getRequestLogPath({
        method: "GET",
        originalUrl: `/communications/satisfaction/${token}?score=5`,
        params: {},
        query: { score: "5" },
      } as any),
    ).toBe(`/communications/satisfaction/${REDACTED_LOG_VALUE}`);
  });

  it("allow-lists error metadata and removes credentials from messages and stacks", () => {
    const code = "oauth-code-sensitive";
    const state = "oauth-state-sensitive";
    const satisfactionToken = "8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww";
    const authorization = "Bearer header-token-sensitive";
    const cookie = "customerRefreshToken=cookie-token-sensitive";
    const sessionHandoff = "session-handoff-sensitive";
    const proxySignature = "proxy-signature-sensitive";
    const proxyNonce = "proxy-nonce-sensitive";
    const error = Object.assign(
      new Error(
        `Provider failed at /callback?code=${code}&state=${state}; Authorization: ${authorization}; Cookie: ${cookie}; sessionHandoff=${sessionHandoff}; x-shario-auth-proxy-signature=${proxySignature}; x-shario-auth-proxy-nonce=${proxyNonce}; /communications/satisfaction/${satisfactionToken}`,
      ),
      {
        code: "PROVIDER_FAILURE",
        statusCode: 502,
        details: { accessToken: "provider-access-token-sensitive" },
      },
    );
    const result = serializeErrorForLog(error, {
      method: "GET",
      originalUrl: `/callback?code=${code}&state=${state}`,
      params: {},
      query: { code, state },
      body: { sessionHandoff },
      headers: {
        authorization,
        cookie,
        "x-shario-auth-proxy-signature": proxySignature,
        "x-shario-auth-proxy-nonce": proxyNonce,
      },
    } as any);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      type: "Error",
      errorCode: "PROVIDER_FAILURE",
      statusCode: 502,
    });
    expect(result).not.toHaveProperty("details");
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain("header-token-sensitive");
    expect(serialized).not.toContain("cookie-token-sensitive");
    expect(serialized).not.toContain(sessionHandoff);
    expect(serialized).not.toContain(proxySignature);
    expect(serialized).not.toContain(proxyNonce);
    expect(serialized).not.toContain(satisfactionToken);
    expect(serialized).toContain(REDACTED_LOG_VALUE);

    const untrustedErrorCode = serializeErrorForLog(
      Object.assign(new Error(`code=${code}`), {
        code,
        type: `https://provider.test/callback?code=${code}`,
      }),
    );
    expect(untrustedErrorCode).not.toHaveProperty("errorCode");
    expect(untrustedErrorCode.type).toBe("object");
    expect(JSON.stringify(untrustedErrorCode)).not.toContain(code);
  });

  it("keeps only safe Postmark verification diagnostics through the logging pipeline", () => {
    const output: string[] = [];
    const testLogger = pino(
      {
        base: undefined,
        timestamp: false,
        serializers: { err: serializeErrorForLog },
        hooks: {
          logMethod(args, method) {
            method.apply(this, sanitizeLogArguments(args));
          },
        },
      },
      { write: (chunk: string) => output.push(chunk) },
    );
    testLogger.error({
      err: Object.assign(new Error("Webhook verification failed."), {
        code: "POSTMARK_1364",
        httpStatus: 422,
        verificationResults: [
          {
            triggerType: "Delivery",
            success: false,
            statusCode: 503,
            message: "provider-message-secret",
            url: "https://provider.example/webhook?token=callback-secret",
            token: "provider-token-secret",
            payload: { email: "recipient-private@example.com" },
          },
          { triggerType: "Bounce", success: false, statusCode: 0 },
          {
            triggerType: "Delivery-provider-secret",
            success: true,
            statusCode: 200,
          },
        ],
        details: { token: "details-token-secret" },
      }),
    });

    const serialized = output.join("");
    const result = JSON.parse(serialized).err;
    expect(result.httpStatus).toBe(422);
    expect(result.verificationResults).toEqual([
      { triggerType: "Delivery", success: false, statusCode: 503 },
      { triggerType: "Bounce", success: false, statusCode: 0 },
    ]);
    expect(result).not.toHaveProperty("details");
    for (const secret of [
      "provider-message-secret",
      "provider.example",
      "callback-secret",
      "provider-token-secret",
      "recipient-private@example.com",
      "Delivery-provider-secret",
      "details-token-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("bounds Postmark diagnostics to six known trigger types", () => {
    const triggerTypes = [
      "Delivery",
      "Bounce",
      "SpamComplaint",
      "Open",
      "Click",
      "SubscriptionChange",
    ];
    const verificationResults = triggerTypes.map((triggerType) => ({
      triggerType,
      success: true,
      statusCode: 200,
    }));
    const result = serializeErrorForLog({
      type: "PostmarkRequestError",
      httpStatus: 200,
      verificationResults: [
        ...verificationResults,
        { triggerType: "Delivery", success: false, statusCode: 500 },
      ],
    });

    expect(result.verificationResults).toEqual(verificationResults);
    expect(result.httpStatus).toBe(200);
  });

  it.each([undefined, null, "503", -1, 99, 600, 503.5, NaN, Infinity])(
    "omits invalid Postmark HTTP status %s without coercing it",
    (statusCode) => {
      const result = serializeErrorForLog({
        code: "POSTMARK_1364",
        httpStatus: statusCode,
        verificationResults: [
          { triggerType: "Delivery", success: false, statusCode },
        ],
      });

      expect(result).not.toHaveProperty("httpStatus");
      expect(result).not.toHaveProperty("verificationResults");
    },
  );

  it.each([0, 100, 599])("accepts bounded Postmark HTTP status %s", (statusCode) => {
    const result = serializeErrorForLog({
      code: "POSTMARK_1364",
      httpStatus: statusCode,
      verificationResults: [
        { triggerType: "Delivery", success: false, statusCode },
      ],
    });

    expect(result.httpStatus).toBe(statusCode);
    expect(result.verificationResults).toEqual([
      { triggerType: "Delivery", success: false, statusCode },
    ]);
  });

  it("rejects malformed Postmark verification results and unrelated provider diagnostics", () => {
    const result = serializeErrorForLog({
      code: "POSTMARK_1364",
      verificationResults: [
        null,
        "provider-secret",
        { triggerType: "delivery", success: false, statusCode: 503 },
        { triggerType: "Delivery", success: "false", statusCode: 503 },
        { triggerType: "Delivery", success: 1, statusCode: 200 },
        {
          triggerType: "https://provider.example/secret",
          success: false,
          statusCode: 503,
        },
      ],
    });
    expect(result).not.toHaveProperty("verificationResults");

    const unrelated = serializeErrorForLog({
      code: "OTHER_PROVIDER",
      httpStatus: 422,
      verificationResults: [
        { triggerType: "Delivery", success: false, statusCode: 503 },
      ],
    });
    expect(unrelated).not.toHaveProperty("httpStatus");
    expect(unrelated).not.toHaveProperty("verificationResults");
  });

  it("redacts Postmark provisioning tokens from headers, structured fields and errors", () => {
    const output: string[] = [];
    const testLogger = pino(
      {
        base: undefined,
        timestamp: false,
        redact: {
          paths: SENSITIVE_LOG_REDACTION_PATHS,
          censor: REDACTED_LOG_VALUE,
        },
        serializers: { req: serializeRequestForLog, err: serializeErrorForLog },
        hooks: {
          logMethod(args, method) {
            method.apply(this, sanitizeLogArguments(args));
          },
        },
      },
      { write: (chunk: string) => output.push(chunk) },
    );
    testLogger.error({
      "X-Shario-Postmark-Provisioning-Token": "root-token-secret",
      nested: { "x-shario-postmark-provisioning-token": "nested-token-secret" },
      headers: { "x-shario-postmark-provisioning-token": "header-token-secret" },
      err: new Error("X-Shario-Postmark-Provisioning-Token: message-token-secret"),
    });
    const result = serializeErrorForLog(
      new Error("The provider echoed request-token-secret."),
      { headers: { "x-shario-postmark-provisioning-token": "request-token-secret" } },
    );

    const serialized = `${output.join("")}${JSON.stringify(result)}`;
    for (const secret of [
      "root-token-secret",
      "nested-token-secret",
      "header-token-secret",
      "message-token-secret",
      "request-token-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(REDACTED_LOG_VALUE);
  });

  it("redacts structured credentials, custom-domain handoffs, and direct requests", () => {
    const output: string[] = [];
    const testLogger = pino(
      {
        base: undefined,
        timestamp: false,
        redact: {
          paths: SENSITIVE_LOG_REDACTION_PATHS,
          censor: REDACTED_LOG_VALUE,
        },
        serializers: {
          req: serializeRequestForLog,
          request: serializeRequestForLog,
          err: serializeErrorForLog,
          url: sanitizeUrlForLog,
          originalUrl: sanitizeUrlForLog,
          path: sanitizeUrlForLog,
        },
      },
      {
        write(chunk: string) {
          output.push(chunk);
        },
      },
    );
    const secrets = {
      oauthCode: "oauth-code-sensitive",
      oauthState: "oauth-state-sensitive",
      verifyToken: "webhook-verify-sensitive",
      challenge: "webhook-challenge-sensitive",
      bearer: "Bearer api-access-sensitive",
      cookie: "customerRefreshToken=refresh-sensitive",
      handoff: "custom-domain-handoff-sensitive",
      proxySignature: "custom-domain-signature-sensitive",
      proxyNonce: "custom-domain-nonce-sensitive",
      password: "password-sensitive",
    };

    testLogger.info({
      req: {
        method: "GET",
        originalUrl: `/oauth/callback?code=${secrets.oauthCode}&state=${secrets.oauthState}`,
        params: {},
        query: { code: secrets.oauthCode, state: secrets.oauthState },
        headers: {
          authorization: secrets.bearer,
          cookie: secrets.cookie,
        },
      },
      url: `/oauth/callback?code=${secrets.oauthCode}&state=${secrets.oauthState}`,
      oauth: {
        code: secrets.oauthCode,
        state: secrets.oauthState,
      },
      query: {
        "hub.verify_token": secrets.verifyToken,
        "hub.challenge": secrets.challenge,
      },
      body: {
        sessionHandoff: secrets.handoff,
        password: secrets.password,
      },
      headers: {
        authorization: secrets.bearer,
        cookie: secrets.cookie,
        "x-shario-auth-proxy-origin": "https://studio.example",
        "x-shario-auth-proxy-timestamp": "1785888000",
        "x-shario-auth-proxy-signature": secrets.proxySignature,
        "x-shario-auth-proxy-nonce": secrets.proxyNonce,
      },
    });

    const record = JSON.parse(output.join("")) as Record<string, unknown>;
    const serialized = JSON.stringify(record);
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("studio.example");
    expect(serialized).not.toContain("1785888000");
    expect(record.req).toEqual({
      method: "GET",
      path: "/oauth/callback",
    });
    expect(record.url).toBe("/oauth/callback");
    expect(serialized).toContain(REDACTED_LOG_VALUE);
  });

  it("sanitizes nested URL fields, request user agents, URL userinfo and fragment handoffs", () => {
    const output: string[] = [];
    const testLogger = pino(
      {
        base: undefined,
        timestamp: false,
        redact: {
          paths: SENSITIVE_LOG_REDACTION_PATHS,
          censor: REDACTED_LOG_VALUE,
        },
        serializers: {
          req: serializeRequestForLog,
          err: serializeErrorForLog,
        },
        hooks: {
          logMethod(args, method) {
            method.apply(this, sanitizeLogArguments(args));
          },
        },
      },
      { write: (chunk: string) => output.push(chunk) },
    );
    const handoff = "short-fragment-handoff";
    const password = "database-password-sensitive";
    const request = {
      method: "GET",
      originalUrl: "/health",
      params: {},
      query: {},
      headers: {},
      get: () => `agent callback#sessionHandoff=${handoff}`,
    };

    testLogger.info({
      req: request,
      nested: {
        callbackUrl: `/magic-link/short-secret?code=oauth-code-sensitive`,
      },
      err: new Error(
        `Failed mongodb://service:${password}@db.internal/app; redirect=https://studio.example/callback#sessionHandoff=${handoff}`,
      ),
    });
    testLogger.info({
      msg: `callback?code=message-code-sensitive#sessionHandoff=${handoff}`,
    });

    const serialized = output.join("");
    expect(serialized).not.toContain("short-secret");
    expect(serialized).not.toContain("oauth-code-sensitive");
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(handoff);
    expect(serialized).not.toContain("message-code-sensitive");
    expect(serialized).toContain(REDACTED_LOG_VALUE);
  });
});
