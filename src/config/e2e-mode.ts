/**
 * Test-only capabilities must require both switches. This deliberately does
 * not accept development mode, truthy aliases, or a single environment flag.
 */
export const isE2ETestMode = (): boolean =>
  process.env.NODE_ENV === "test" &&
  process.env.E2E_TEST_MODE === "true";

export const assertE2ETestMode = (): void => {
  if (!isE2ETestMode()) {
    throw new Error(
      "E2E test controls are only available when NODE_ENV=test and E2E_TEST_MODE=true.",
    );
  }
};
