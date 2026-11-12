import { deleteObjectFromR2 } from "@/infrastructure/storage/r2.client.js";
import type { TenantPublicSite } from "@/modules/tenants/tenant.types.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const mediaUrls = (site: TenantPublicSite): Set<string> =>
  new Set(
    [
      site.branding?.logoUrl,
      site.branding?.faviconUrl,
      site.branding?.coverImageUrl,
      site.login?.backgroundImageUrl,
      site.register?.backgroundImageUrl,
      ...(site.customerPortal?.courses?.locations ?? []).map(entry => entry.heroImageUrl),
    ].filter(Boolean),
  );

const ownedKeyFromUrl = ({
  tenantId,
  value,
}: {
  tenantId: string;
  value: string;
}): string | null => {
  const publicBase = process.env.R2_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (!publicBase || !value) return null;

  try {
    const base = new URL(`${publicBase}/`);
    const media = new URL(value);
    if (
      base.protocol !== "https:" ||
      media.origin !== base.origin ||
      !media.pathname.startsWith(base.pathname)
    ) {
      return null;
    }
    const key = decodeURIComponent(media.pathname.slice(base.pathname.length));
    const segments = key.split("/");
    if (
      !key.startsWith(`public-sites/${tenantId}/`) ||
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      return null;
    }
    return key;
  } catch {
    return null;
  }
};

/**
 * Deletes only tenant-owned draft assets that became unreachable after a
 * successful CAS mutation. Published references are always retained.
 * Cleanup is best-effort and never changes the result of a committed edit.
 */
export const cleanupDiscardedPublicSiteMedia = async ({
  tenantId,
  beforeDraft,
  afterDraft,
  published,
}: {
  tenantId: string;
  beforeDraft: TenantPublicSite;
  afterDraft: TenantPublicSite;
  published: TenantPublicSite;
}): Promise<void> => {
  try {
    const versions = await TenantPublicSiteVersionModel.find({
      tenant: tenantId,
    })
      .select(
        "snapshot.branding.logoUrl snapshot.branding.faviconUrl snapshot.branding.coverImageUrl snapshot.login.backgroundImageUrl snapshot.register.backgroundImageUrl snapshot.customerPortal.courses.locations.heroImageUrl",
      )
      .lean()
      .exec();
    const retained = new Set([
      ...mediaUrls(afterDraft),
      ...mediaUrls(published),
      ...versions.flatMap((version) =>
        version.snapshot ? [...mediaUrls(version.snapshot)] : [],
      ),
    ]);
    const candidates = [...mediaUrls(beforeDraft)].filter(
      (url) => !retained.has(url),
    );

    await Promise.all(
      candidates.map(async (url) => {
        const key = ownedKeyFromUrl({ tenantId, value: url });
        if (!key) return;
        await deleteObjectFromR2({ key }).catch(() => undefined);
      }),
    );
  } catch {
    // A cleanup failure must never turn an already committed edit into a 500.
    // If retained references cannot be established, fail closed and delete
    // nothing; a later cleanup pass can safely retry.
  }
};
