export const METADATA_TAG = {
  COURSE: "course",
  WORKSHOP: "workshop",
} as const;

export type MetadataTag = (typeof METADATA_TAG)[keyof typeof METADATA_TAG];

export const METADATA_TAGS = Object.values(METADATA_TAG);
