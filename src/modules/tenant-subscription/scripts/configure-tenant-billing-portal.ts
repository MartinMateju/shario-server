import "dotenv/config";

import { logger } from "@/config/logger.js";

import { getTenantBillingStripe } from "../services/tenant-subscription.stripe.service.js";
import { upsertTenantBillingPortalConfiguration } from "../tenant-subscription.portal.js";

const optionalUrl = (key: string): string | undefined =>
  process.env[key]?.trim() || undefined;

const main = async (): Promise<void> => {
  const configuration = await upsertTenantBillingPortalConfiguration(
    getTenantBillingStripe(),
    {
      privacyPolicyUrl: optionalUrl(
        "STRIPE_BILLING_PORTAL_PRIVACY_POLICY_URL",
      ),
      termsOfServiceUrl: optionalUrl(
        "STRIPE_BILLING_PORTAL_TERMS_OF_SERVICE_URL",
      ),
    },
  );

  logger.info(
    {
      configurationId: configuration.id,
      livemode: configuration.livemode,
    },
    "Stripe tenant Billing Portal configured.",
  );

  process.stdout.write(
    `\nAdd this value to the matching environment:\n` +
      `STRIPE_BILLING_PORTAL_CONFIGURATION_ID=${configuration.id}\n`,
  );
};

main().catch((error) => {
  logger.fatal(
    { err: error },
    "Stripe tenant Billing Portal setup failed.",
  );
  process.exitCode = 1;
});
