export const toOutboundOnlyCommunicationSettings = (
  settings: Record<string, any>,
): Record<string, any> => {
  const value =
    typeof settings.toObject === "function"
      ? settings.toObject()
      : structuredClone(settings);
  value.channels = {
    email: {
      enabled: value.channels?.email?.enabled !== false,
      provider: "postmark",
      inboundEnabled: false,
    },
    inApp: { enabled: value.channels?.inApp?.enabled !== false },
  };
  delete value.inbox;
  delete value.tenantKey;
  delete value.inbound;
  return value;
};
