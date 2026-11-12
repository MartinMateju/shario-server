// Postmark persists custom webhook headers. This token only acknowledges
// verification probes while its matching setup attempt is active in our DB.
export const POSTMARK_PROVISIONING_TOKEN_HEADER =
  "X-Shario-Postmark-Provisioning-Token";

export const isPostmarkProvisioningAttemptId = (
  value: unknown,
): value is string =>
  typeof value === "string" &&
  value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
