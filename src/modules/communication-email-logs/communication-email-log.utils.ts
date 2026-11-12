export const normalizeRecipientEmail = (email: string): string => {
  return email.trim().toLowerCase();
};

export const normalizeEmailLogBody = (body?: string, htmlContent?: string) => {
  return {
    body: body || htmlContent || "",
    htmlContent: htmlContent || body || "",
  };
};
