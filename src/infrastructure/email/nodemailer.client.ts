import nodemailer, {
  type SendMailOptions,
  type SentMessageInfo,
  type Transporter,
} from "nodemailer";

let transporter: Transporter<SentMessageInfo> | null = null;

const getDefaultFromName = (): string =>
  process.env.EMAIL_FROM_NAME?.trim() || "shario.io";

const mustEnv = (name: string): string => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Email: missing required env var ${name}`);
  }

  return value;
};

const getAllowSelfSigned = (): boolean => {
  return process.env.EMAIL_ALLOW_SELF_SIGNED === "true";
};

export const getEmailUser = (): string => {
  return mustEnv("EMAIL_USER");
};

export const getEmailTransporter = (): Transporter<SentMessageInfo> => {
  if (transporter) {
    return transporter;
  }

  const user = mustEnv("EMAIL_USER");
  const pass = mustEnv("EMAIL_PASSWORD");

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.EMAIL_PORT || 465),
    secure: process.env.EMAIL_SECURE !== "false",
    connectionTimeout: Number(
      process.env.EMAIL_CONNECTION_TIMEOUT_MS || 20_000,
    ),
    greetingTimeout: Number(
      process.env.EMAIL_GREETING_TIMEOUT_MS || 20_000,
    ),
    socketTimeout: Number(
      process.env.EMAIL_SOCKET_TIMEOUT_MS || 60_000,
    ),
    auth: {
      user,
      pass,
    },
    ...(getAllowSelfSigned()
      ? {
          tls: {
            rejectUnauthorized: false,
          },
        }
      : {}),
  });

  return transporter;
};

export const closeEmailTransporter = (): void => {
  if (!transporter) {
    return;
  }

  transporter.close();
  transporter = null;
};

export type SendEmailParams = SendMailOptions & {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
};

export const sendEmail = async (
  mailOptions: SendEmailParams,
): Promise<SentMessageInfo> => {
  const from =
    mailOptions.from || `${getDefaultFromName()} <${getEmailUser()}>`;

  if (!mailOptions.to) {
    throw new Error("sendEmail: missing 'to'");
  }

  if (!mailOptions.subject) {
    throw new Error("sendEmail: missing 'subject'");
  }

  if (!mailOptions.html && !mailOptions.text) {
    throw new Error("sendEmail: missing 'html' or 'text'");
  }

  return getEmailTransporter().sendMail({
    ...mailOptions,
    from,
  });
};
