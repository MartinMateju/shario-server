import mongoose from "mongoose";

import { emailTemplateSchema } from "./email-template.schema.js";
import type {
  EmailTemplate as EmailTemplateAttrs,
  EmailTemplateModel,
} from "./email-template.types.js";

export const EmailTemplateModelInstance =
  (mongoose.models.EmailTemplate as EmailTemplateModel | undefined) ||
  mongoose.model<EmailTemplateAttrs, EmailTemplateModel>(
    "EmailTemplate",
    emailTemplateSchema,
  );

export { EmailTemplateModelInstance as EmailTemplate };

export default EmailTemplateModelInstance;