import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

const getEncryptionKey = (): Buffer => {
    const secret = process.env.COMMUNICATION_SECRET_KEY || process.env.EMAIL_SECRET_KEY;

    if (!secret) {
        throw new Error("EMAIL_SECRET_KEY is missing");
    }

    return crypto
        .createHash("sha256")
        .update(secret, "utf8")
        .digest()
        .subarray(0, KEY_LENGTH_BYTES);
};

export const encryptEmailPassword = (plainText: string): string => {
    if (!plainText) {
        throw new Error("Plain text value is missing");
    }

    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const key = getEncryptionKey();

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return [
        iv.toString("hex"),
        authTag.toString("hex"),
        encrypted.toString("hex"),
    ].join(":");
};

export const decryptEmailPassword = (encryptedValue: string): string => {
    if (!encryptedValue) {
        throw new Error("Encrypted value is missing");
    }

    const parts = encryptedValue.split(":");

    if (parts.length !== 3) {
        throw new Error("Invalid encrypted value format");
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error("Invalid encrypted value format");
    }

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");

    if (iv.length !== IV_LENGTH_BYTES) {
        throw new Error("Invalid encryption IV length");
    }

    if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
        throw new Error("Invalid encryption auth tag length");
    }

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        getEncryptionKey(),
        iv,
    );

    decipher.setAuthTag(authTag);

    return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]).toString("utf8");
};

/** Generic aliases used for tenant-scoped channel credentials. */
export const encryptSecret = encryptEmailPassword;
export const decryptSecret = decryptEmailPassword;
