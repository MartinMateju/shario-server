export const getStripeConnectWebhookConfigurationError = ({
  nodeEnv,
  webhookSecret,
}: {
  nodeEnv: string;
  webhookSecret?: string | null;
}): string | null => {
  if (nodeEnv !== "production") {
    return null;
  }

  return webhookSecret?.trim()
    ? null
    : "STRIPE_CONNECT_WEBHOOK_SECRET is required in production.";
};

