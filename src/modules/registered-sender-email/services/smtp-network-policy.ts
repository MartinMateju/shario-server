import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_SMTP_PORTS = [25, 465, 587, 2_525] as const;
const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
] as const;

export type SmtpLookupAddress = {
  address: string;
  family: number;
};

export type SmtpDnsLookup = (
  hostname: string,
) => Promise<readonly SmtpLookupAddress[]>;

export type ResolvedSmtpEndpoint = {
  address: string;
  family: number;
  hostname: string;
  servername?: string;
};

export class SmtpEndpointPolicyError extends Error {
  readonly code = "SMTP_ENDPOINT_NOT_ALLOWED";

  constructor(message = "The SMTP endpoint is not allowed.") {
    super(message);
    this.name = "SmtpEndpointPolicyError";
  }
}

const parseAllowedPorts = (): Set<number> => {
  const configured = String(process.env.SMTP_ALLOWED_PORTS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(
      (value) => Number.isInteger(value) && value >= 1 && value <= 65_535,
    );

  return new Set(configured.length > 0 ? configured : DEFAULT_SMTP_PORTS);
};

export const isAllowedSmtpPort = (value: unknown): boolean =>
  Number.isInteger(Number(value)) && parseAllowedPorts().has(Number(value));

export const assertAllowedSmtpPort = (value: unknown): number => {
  const port = Number(value);

  if (!isAllowedSmtpPort(port)) {
    throw new SmtpEndpointPolicyError("The SMTP port is not allowed.");
  }

  return port;
};

const parseIpv4Bytes = (address: string): number[] | null => {
  if (isIP(address) !== 4) return null;

  const bytes = address.split(".").map(Number);

  return bytes.length === 4 && bytes.every((part) => part >= 0 && part <= 255)
    ? bytes
    : null;
};

const isPublicIpv4 = (address: string): boolean => {
  const bytes = parseIpv4Bytes(address);

  if (!bytes) return false;

  const [first, second, third] = bytes;

  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
};

const parseIpv6Value = (input: string): bigint | null => {
  const address = input.toLowerCase().split("%")[0];

  if (isIP(address) !== 6) return null;

  const convertEmbeddedIpv4 = (part: string): string[] => {
    const bytes = parseIpv4Bytes(part);

    if (!bytes) return [part];

    return [
      ((bytes[0] << 8) | bytes[1]).toString(16),
      ((bytes[2] << 8) | bytes[3]).toString(16),
    ];
  };

  const [leftRaw, rightRaw = ""] = address.split("::", 2);
  const left = leftRaw ? leftRaw.split(":").flatMap(convertEmbeddedIpv4) : [];
  const right = rightRaw
    ? rightRaw.split(":").flatMap(convertEmbeddedIpv4)
    : [];
  const missing = 8 - left.length - right.length;
  const groups = address.includes("::")
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;

  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))
  ) {
    return null;
  }

  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
};

const isPublicIpv6 = (address: string): boolean => {
  const value = parseIpv6Value(address);

  if (value === null) return false;

  // IPv4-mapped IPv6 must inherit the embedded IPv4 policy.
  if (value >> 32n === 0xffffn) {
    const ipv4 = Number(value & 0xffff_ffffn);
    return isPublicIpv4(
      [ipv4 >>> 24, (ipv4 >>> 16) & 255, (ipv4 >>> 8) & 255, ipv4 & 255].join(
        ".",
      ),
    );
  }

  // SMTP egress only needs globally routable unicast space (2000::/3).
  if (value >> 125n !== 1n) return false;

  // RFC 3849 documentation prefix 2001:db8::/32.
  if (value >> 96n === 0x20010db8n) return false;

  return true;
};

export const isPublicSmtpAddress = (address: string): boolean => {
  const family = isIP(address);

  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);

  return false;
};

const normalizeSmtpHostname = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

const assertHostnameAllowed = (hostname: string): void => {
  if (!hostname || hostname.length > 253) {
    throw new SmtpEndpointPolicyError();
  }

  if (
    hostname === "localhost" ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new SmtpEndpointPolicyError();
  }
};

const defaultLookup: SmtpDnsLookup = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export const resolvePublicSmtpEndpoint = async ({
  hostname: rawHostname,
  port,
  lookup = defaultLookup,
}: {
  hostname: string;
  port: number;
  lookup?: SmtpDnsLookup;
}): Promise<ResolvedSmtpEndpoint> => {
  const hostname = normalizeSmtpHostname(rawHostname);

  assertAllowedSmtpPort(port);
  assertHostnameAllowed(hostname);

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname);

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicSmtpAddress(address))
  ) {
    throw new SmtpEndpointPolicyError();
  }

  // Prefer IPv4 when both families are approved. Some deployments do not
  // provide IPv6 egress even though the resolver returns AAAA first.
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];

  return {
    address: selected.address,
    family: selected.family,
    hostname,
    ...(literalFamily ? {} : { servername: hostname }),
  };
};

export const resolveConfiguredSmtpEndpoint = async ({
  provider,
  hostname,
  port,
  lookup,
}: {
  provider?: string | null;
  hostname: string;
  port: number;
  lookup?: SmtpDnsLookup;
}): Promise<ResolvedSmtpEndpoint> =>
  resolvePublicSmtpEndpoint({
    hostname: provider === "gmail" ? "smtp.gmail.com" : hostname,
    port,
    lookup,
  });
