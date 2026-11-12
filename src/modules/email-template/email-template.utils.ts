import { extractEmailTemplateVariables } from "./email-template.rendering.js";

export const extractTemplateVariables = extractEmailTemplateVariables;

export const normalizeTemplateContent = (input: {
  subject?: string;
  htmlContent?: string;
  body?: string;
  headerHtml?: string;
  footerHtml?: string;
  contentVariants?: Partial<
    Record<"cs" | "en", { subject?: string; htmlContent?: string; body?: string }>
  >;
}): string[] => {
  return extractTemplateVariables(
    input.subject,
    input.htmlContent,
    input.body,
    input.headerHtml,
    input.footerHtml,
    ...Object.values(input.contentVariants ?? {}).flatMap((variant) => [
      variant?.subject,
      variant?.htmlContent,
      variant?.body,
    ]),
  );
};
