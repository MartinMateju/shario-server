import bcrypt from "bcryptjs";

const DEFAULT_SALT_ROUNDS = 12;

/**
 * Hashes a value using bcrypt.
 *
 * @param value - Plain text value to hash.
 * @param saltRounds - Number of bcrypt salt rounds.
 * @returns The hashed value.
 */
export const hashData = async (
    value: string,
    saltRounds: number = DEFAULT_SALT_ROUNDS,
): Promise<string> => {
    if (!value) {
        throw new Error("Value to hash is missing");
    }

    return bcrypt.hash(value, saltRounds);
};

/**
 * Compares a plain text value against a bcrypt hash.
 *
 * @param value - Plain text value.
 * @param hash - Existing bcrypt hash.
 * @returns True if the value matches the hash.
 */
export const verifyHash = async (
    value: string,
    hash: string,
): Promise<boolean> => {
    if (!value || !hash) {
        return false;
    }

    return bcrypt.compare(value, hash);
};