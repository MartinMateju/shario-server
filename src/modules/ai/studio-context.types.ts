import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/index.js";

export const STUDIO_CONTEXT_VERSION = "studio-context-v1";

export const STUDIO_CONTEXT_PROFILE = {
  CORE: "core",
  FULL: "full",
} as const;

export type StudioContextProfile =
  (typeof STUDIO_CONTEXT_PROFILE)[keyof typeof STUDIO_CONTEXT_PROFILE];

export type StudioContextBuildInput = {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  locationId?: string | null;
  timezone?: string | null;
  now?: Date;
  profile?: StudioContextProfile;
};

export type StudioContextCoverageEntry = {
  source: string;
  reason: string;
};

export type StudioContextCoverage = {
  available: string[];
  omitted: StudioContextCoverageEntry[];
  unavailable: StudioContextCoverageEntry[];
  complete: boolean;
  budget?: {
    maxSerializedCharacters: number;
    serializedCharacters: number;
    truncated: boolean;
  };
};

export type StudioContextSnapshot = Record<string, any> & {
  contextVersion: string;
  profile: StudioContextProfile;
  generatedAt: string;
  coverage: StudioContextCoverage;
};
