import type { Request } from "express";
import ipaddr from "ipaddr.js";
import { getVerifiedAuthProxyClientIp } from "@/modules/auth/auth-first-party-proxy.js";

export const verifiedProxyRateLimitKey = (req: Request): string => {
  const clientIp = getVerifiedAuthProxyClientIp(req);
  if (!clientIp) return req.ip || "unknown";
  const address = ipaddr.process(clientIp);
  if (address.kind() === "ipv4") return address.toString();
  // Group IPv6 privacy addresses by /56 instead of allowing every address a
  // fresh budget. The signed wire value remains unchanged for HMAC.
  return `ipv6:${Buffer.from(address.toByteArray().slice(0, 7)).toString("hex")}/56`;
};
