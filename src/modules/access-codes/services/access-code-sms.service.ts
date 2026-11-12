type SendAccessCodeSmsInput = {
  phone: string;
  entryCode: string;
  studioName: string;
};

// Provider adapter placeholder. Wire this to shared/sms/gosms.provider.ts.
export const accessCodeSmsService = {
  async sendAccessCodeSms(_input: SendAccessCodeSmsInput): Promise<void> {
    // Intentionally no-op until shared SMS provider is introduced.
  },
};
