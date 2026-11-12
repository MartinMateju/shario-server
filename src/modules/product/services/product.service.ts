import { buildCoursePublicationLocationFilter } from "../product.course-content.js";
import { assertTenantLocationsWithinWorkspaceScope, assertLocationIdsWithinWorkspaceScope, type AllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/location-scope.service.js";
import { assertOpenStudioLocationAvailable } from "../open-studio-location.policy.js";
import { isOpenStudioLocationDuplicateError } from "../open-studio-location-index.js";
import { assertStudioProductLocationAccess, buildProductLocationFilter, getStudioProductLocationId, isStudioProduct } from "../product-location.policy.js";
import { assertVoucherCanBeIssued, normalizeVoucherSettings } from "@/modules/coupon/voucher-policy.js";
import { voucherDesignSchema } from "@/modules/coupon/voucher-design.js";
import { prepareVoucherDesign } from "./voucher-design.service.js";
import { uploadBufferToR2 } from "@/infrastructure/storage/r2.client.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { isCourseBrowsingVisible } from "@/modules/tenants/public-site/tenant-course-visibility.js";
import type { TenantModules } from "@/modules/tenants/tenant.types.js";
import {
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";

import {
  BOOKABLE_PRODUCT_TYPES,
  LEGACY_BOOKING_PRODUCT_TYPE,
  PUBLIC_COURSE_PRODUCT_TYPES,
  PUBLIC_PRODUCT_TYPES,
  PRODUCT_TYPE,
  type ProductType,
} from "../product.constants.js";
import {
  getLegacyCompatibilityTypeForKind,
  normalizeProductOpenStudioBookingMode,
  normalizeProductKindV2,
  PRODUCT_KIND_CONTRACT_VERSION,
  PRODUCT_KIND,
  resolveLegacyProductTypeV2,
  type ProductOpenStudioBookingMode,
  type OpenStudioPolicy,
  type ProductKind,
} from "../product-kind-v2.contract.js";
import {
  createProductRepository,
  type ProductRepository,
} from "@/modules/product/product.repository.js";
import type {
  ProductCatalogDto,
  ProductListFilters,
  ProductPublicDto,
  ProductVoucherCatalogDto,
  UploadedFileLike,
} from "../product.types.js";
import {
  assertValidPdfFile,
  buildCouponTemplateKey,
  resolveProductKindV2,
  resolveProductOpenStudioBookingModeV2,
  resolveOpenStudioPolicy,
  toProductCatalogDto,
  toProductPublicDto,
  toProductVoucherCatalogDto,
} from "../product.utils.js";
import type {
  CreateProductInput,
  UpdateProductInput,
} from "../product.validators.js";
import {
  assertProductKindEntitledForTenant,
  isProductKindEntitledForTenant,
} from "../product-plan-entitlements.js";
import {
  deleteUploadedProductImage,
  uploadProductImage,
  type UploadedProductImage,
} from "./product-image.service.js";
import { productClassCategoryService } from "./product-class-category.service.js";
import { getProductClassCategoryNameKey } from "../product-class-category.utils.js";
import { withProductClassCategoryTransaction } from "../product-class-category.transaction.js";
import { voucherSettingsSchema, openStudioPolicyFieldsSchema } from "../product.validators.js";
import {
  acquireVoucherTenantMutationLock,
  assertVoucherOfferingPublicationAllowed,
  assertVoucherOfferingDeletable,
  countActiveVoucherOfferings,
  getVoucherOfferingDeletionPolicy,
  preserveLegacyVoucherValuesBeforeDeletion,
  resolveVoucherOfferingLimit,
} from "../voucher-offering.policy.js";

type ListProductsServiceFilters = Omit<ProductListFilters, "type" | "types"> & {
  type?: string;
  types?: readonly ProductType[];
};

const bookableProductTypes = new Set<string>(BOOKABLE_PRODUCT_TYPES);

type ProductWrite = Record<string, any> & {
  type?: string;
  kind?: string;
  bookingMode?: string | null;
};

const assertCanonicalProductRules = ({
  kind,
  bookingMode,
  input,
}: {
  kind: ProductKind;
  bookingMode: ProductOpenStudioBookingMode | null;
  input: ProductWrite;
}): void => {
  if (kind === PRODUCT_KIND.MEMBERSHIP) {
    badRequest({
      message: "Memberships must be managed as membership plans.",
      code: "MEMBERSHIP_PLAN_REQUIRED",
    });
  }

  if (kind === PRODUCT_KIND.OPEN_STUDIO && !bookingMode) {
    badRequest({
      message: "Open Studio requires a shared, exclusive, or customer-choice booking mode.",
      code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED",
    });
  }

  if (kind !== PRODUCT_KIND.OPEN_STUDIO && input.bookingMode != null) {
    badRequest({
      message: "Booking mode is only available for Open Studio.",
      code: "PRODUCT_BOOKING_MODE_NOT_ALLOWED",
    });
  }

  if (kind === PRODUCT_KIND.PRIVATE_STUDIO) {
    if (
      Number(input.price ?? 0) !== 0 ||
      Number(input.extraCharge ?? 0) !== 0
    ) {
      badRequest({
        message: "Private Studio is internal and cannot have a price.",
        code: "PRIVATE_STUDIO_NOT_SELLABLE",
      });
    }

    if (input.maxNumberOfParticipants != null) {
      badRequest({
        message: "Private Studio does not expose customer capacity.",
        code: "PRIVATE_STUDIO_CAPACITY_NOT_ALLOWED",
      });
    }
  }
};

const canonicalizeOpenStudioPolicy = ({
  input,
  existing,
  bookingMode,
}: {
  input: ProductWrite;
  existing?: any;
  bookingMode: ProductOpenStudioBookingMode | null;
}): OpenStudioPolicy | null => {
  if (bookingMode !== "customer-choice") {
    if (input.openStudioPolicy != null) {
      badRequest({
        message: "Sharing options are only available for customer-choice Open Studio products.",
        code: "OPEN_STUDIO_POLICY_NOT_ALLOWED",
      });
    }
    return null;
  }

  const policyInput = input.openStudioPolicy;
  if (policyInput != null) {
    const parsed = openStudioPolicyFieldsSchema.partial().safeParse(policyInput);
    if (!parsed.success) {
      badRequest({ message: "Invalid Open Studio sharing options.", code: "INVALID_OPEN_STUDIO_POLICY" });
    }
  }

  const policy = {
    ...resolveOpenStudioPolicy(policyInput === null ? null : existing?.openStudioPolicy),
    ...(policyInput ?? {}),
  };
  if (policy.publicCapacityMode === "activity") policy.publicCapacityLimit = null;
  const result = openStudioPolicyFieldsSchema.safeParse(policy);
  if (!result.success ||
    (policy.publicCapacityMode === "fixed" && policy.publicCapacityLimit == null)) {
    badRequest({
      message: "Public bookings require a positive whole-number capacity and a nonnegative private booking surcharge.",
      code: "INVALID_OPEN_STUDIO_POLICY",
    });
  }
  return policy;
};

/**
 * Persists the canonical V2 kind and a legacy compatibility type together.
 * Historical, ambiguous products may still be deactivated but cannot be
 * silently repurposed into one of the new tenant-facing kinds.
 */
const canonicalizeTenantProductWrite = ({
  input,
  existing,
}: {
  input: ProductWrite;
  existing?: any;
}): ProductWrite => {
  const explicitKind = normalizeProductKindV2(input.kind);
  const existingKind = existing ? resolveProductKindV2(existing) : null;
  const legacyResolution = resolveLegacyProductTypeV2(
    input.type ?? existing?.type,
  );
  const kind =
    explicitKind ??
    existingKind ??
    (legacyResolution.status === "mapped" ? legacyResolution.kind : null);

  if (!existing && String(input.type ?? "") === PRODUCT_TYPE.MEMBERSHIP) {
    badRequest({
      message: "Memberships must be managed as membership plans.",
      code: "MEMBERSHIP_PLAN_REQUIRED",
    });
  }

  if (!kind) {
    if (
      existing &&
      input.isActive === false &&
      input.kind === undefined &&
      input.type === undefined &&
      input.bookingMode === undefined &&
      input.openStudioPolicy === undefined
    ) {
      return input;
    }

    badRequest({
      message: "This legacy product must be reviewed before it can be managed.",
      code: "PRODUCT_KIND_MIGRATION_REQUIRED",
    });
  }

  if (input.type) {
    const supplied = resolveLegacyProductTypeV2(input.type);
    if (supplied.status !== "mapped" || supplied.kind !== kind) {
      badRequest({
        message: "Legacy product type conflicts with product kind.",
        code: "PRODUCT_KIND_TYPE_CONFLICT",
      });
    }
  }

  const type = getLegacyCompatibilityTypeForKind(kind);
  if (!type) {
    assertCanonicalProductRules({ kind, bookingMode: null, input });
    badRequest({
      message: "This product kind cannot be stored in the product catalog.",
      code: "PRODUCT_KIND_UNSUPPORTED",
    });
  }

  if (kind === PRODUCT_KIND.OPEN_STUDIO && input.bookingMode !== undefined &&
    !normalizeProductOpenStudioBookingMode(input.bookingMode)) {
    badRequest({
      message: "Select a valid Open Studio booking mode.",
      code: "INVALID_OPEN_STUDIO_BOOKING_MODE",
    });
  }

  const bookingMode =
    kind === PRODUCT_KIND.OPEN_STUDIO
      ? (normalizeProductOpenStudioBookingMode(input.bookingMode) ??
        (existing
          ? resolveProductOpenStudioBookingModeV2(existing)
          : legacyResolution.status === "mapped"
            ? (legacyResolution.openStudioBookingPolicy?.defaultMode ?? null)
            : null))
      : null;

  assertCanonicalProductRules({
    kind,
    bookingMode,
    input: {
      ...input,
      price: input.price ?? existing?.price,
      extraCharge: input.extraCharge ?? existing?.extraCharge,
      maxNumberOfParticipants:
        input.maxNumberOfParticipants !== undefined
          ? input.maxNumberOfParticipants
          : (existing?.maxNumberOfParticipants ?? null),
    },
  });

  return {
    ...input,
    kind,
    kindContractVersion: PRODUCT_KIND_CONTRACT_VERSION,
    type,
    bookingMode,
    openStudioPolicy: canonicalizeOpenStudioPolicy({ input, existing, bookingMode }),
  };
};

export const isPublicProductTypeEnabled = ({
  modules,
  type,
}: {
  modules?: Partial<TenantModules>;
  type: ProductType | string;
}): boolean => {
  if (modules?.[TENANT_MODULE.PAYMENTS] !== true) return false;

  switch (type) {
    case PRODUCT_TYPE.COURSE:
    case LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE:
      return modules[TENANT_MODULE.COURSES] === true;
    case PRODUCT_TYPE.WORKSHOP:
    case LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP:
    case LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP:
      return modules[TENANT_MODULE.BOOKINGS] === true;
    case PRODUCT_TYPE.GIFT_CARD:
    case PRODUCT_TYPE.COUPON:
      return modules[TENANT_MODULE.VOUCHERS] === true;
    default:
      return false;
  }
};

const getEnabledPublicProductTypes = ({
  coursesOnly,
  modules,
}: {
  coursesOnly?: boolean;
  modules?: Partial<TenantModules>;
}): readonly ProductType[] =>
  (coursesOnly ? PUBLIC_COURSE_PRODUCT_TYPES : PUBLIC_PRODUCT_TYPES).filter(
    (type) => isPublicProductTypeEnabled({ modules, type }),
  );

const filterPublicProductTypesForPlan = ({
  tenant,
  types,
}: {
  tenant: Awaited<ReturnType<typeof getTenantOrThrow>>;
  types: readonly ProductType[];
}): readonly ProductType[] =>
  types.filter((type) => {
    const resolution = resolveLegacyProductTypeV2(type);
    return (
      resolution.status !== "mapped" ||
      isProductKindEntitledForTenant({
        tenant,
        kind: resolution.kind,
      })
    );
  });

const assertPublicProductTypeEnabled = ({
  modules,
  type,
}: {
  modules?: Partial<TenantModules>;
  type: ProductType | string;
}): void => {
  if (isPublicProductTypeEnabled({ modules, type })) return;

  let requiredModules: Array<keyof TenantModules> = [TENANT_MODULE.PAYMENTS];

  if (modules?.[TENANT_MODULE.PAYMENTS] === true) {
    switch (type) {
      case PRODUCT_TYPE.COURSE:
      case LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_COURSE:
        requiredModules = [TENANT_MODULE.COURSES];
        break;
      case PRODUCT_TYPE.WORKSHOP:
      case LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP:
      case LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP:
        requiredModules = [TENANT_MODULE.BOOKINGS];
        break;
      case PRODUCT_TYPE.GIFT_CARD:
      case PRODUCT_TYPE.COUPON:
        requiredModules = [TENANT_MODULE.VOUCHERS];
        break;
    }
  }

  forbidden({
    message: "This product is unavailable for this workspace.",
    code: "TENANT_MODULE_REQUIRED",
    details:
      requiredModules.length === 1
        ? { requiredModule: requiredModules[0] }
        : { requiredModules },
  });
};

const isDuplicateKeyError = (error: unknown): error is { code: number } =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 11000,
  );

const assertRelatedProductBelongsToTenant = async ({
  productRepository,
  productId,
  currentProductId,
}: {
  productRepository: ProductRepository;
  productId?: string | null;
  currentProductId?: string;
}): Promise<void> => {
  if (!productId) return;

  if (currentProductId && productId === currentProductId) {
    badRequest({
      message: "A product cannot reference itself.",
      code: "PRODUCT_SELF_REFERENCE",
    });
  }

  if (!(await productRepository.findById(productId))) {
    badRequest({
      message: "The related product does not exist in this workspace.",
      code: "RELATED_PRODUCT_NOT_FOUND",
    });
  }
};

const prepareVoucherSettings = async ({ input, existing, productRepository, timezone = "UTC" }: {
  timezone?: string;
  input: ProductWrite;
  existing?: any;
  productRepository: ProductRepository;
}): Promise<void> => {
  if (resolveProductKindV2(input) !== PRODUCT_KIND.VOUCHER) {
    if (input.voucherSettings !== undefined) badRequest({ message: "Voucher settings are only available for vouchers.", code: "PRODUCT_VOUCHER_SETTINGS_NOT_ALLOWED" });
    return;
  }
  const settings = input.voucherSettings !== undefined
    ? voucherSettingsSchema.parse(input.voucherSettings)
    : existing?.voucherSettings ?? { version: 1, type: "value", validity: { mode: "months", months: 12 } };
  if (input.voucherSettings !== undefined || !existing) input.voucherSettings = settings;
  try {
    const normalized = normalizeVoucherSettings(settings);
    if ((input.isActive ?? existing?.isActive) !== false) assertVoucherCanBeIssued(normalized, new Date(), timezone);
  } catch (error) {
    badRequest({ message: error instanceof Error ? error.message : "Invalid voucher settings.", code: "VOUCHER_VALIDITY_INVALID" });
  }
  if (settings.type === "experience") {
    const related = settings.experienceProductId ? await productRepository.findById(settings.experienceProductId) : null;
    if (!related || String(related._id) === String(existing?._id) || resolveProductKindV2(related) !== PRODUCT_KIND.CLASS) {
      badRequest({ message: "Choose a course from this workspace for the experience voucher.", code: "VOUCHER_EXPERIENCE_PRODUCT_INVALID" });
    }
  }
  for (const id of settings.eligibleProductIds ?? []) {
    const related = await productRepository.findById(String(id));
    if (!related || String(related._id) === String(existing?._id) || ![PRODUCT_KIND.CLASS, PRODUCT_KIND.OPEN_STUDIO].includes(resolveProductKindV2(related) as any)) {
      badRequest({ message: "Voucher eligibility must reference bookable products in this workspace.", code: "VOUCHER_ELIGIBLE_PRODUCT_INVALID" });
    }
  }
};

const assertTenantManagedProduct = (type: string): void => {
  if (type === PRODUCT_TYPE.SYSTEM) {
    forbidden({
      message: "System products cannot be managed from the workspace catalog.",
      code: "SYSTEM_PRODUCT_IMMUTABLE",
    });
  }
};

const assertProductMoney = (
  amount: number | undefined,
  currency: StudioCommerceCurrency,
  field: "price" | "extraCharge" | "privateBookingSurcharge",
): void => {
  if (amount === undefined) return;

  try {
    toCurrencyMinorUnits(amount, currency);
  } catch (error) {
    badRequest({
      message: `${field} is invalid for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
      details: {
        field,
        currency,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

/** Existing products can be assigned once; moving them would change historical meaning. */
const prepareStudioProductLocation = async ({ tenantId, input, existing, allowedLocationIds = null }: {
  tenantId: string;
  input: ProductWrite;
  existing?: any;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
}): Promise<void> => {
  if (existing) assertStudioProductLocationAccess(existing, allowedLocationIds);
  const existingLocationId = existing ? getStudioProductLocationId(existing) : null;
  if (existingLocationId && isStudioProduct(existing) &&
      (!isStudioProduct(input) || (input.locationId !== undefined && input.locationId !== existingLocationId))) {
    conflict({ code: "PRODUCT_LOCATION_IMMUTABLE", message: "A studio product cannot move to another location. Create a separate product for that location." });
  }
  if (!isStudioProduct(input)) {
    if (input.locationId != null) badRequest({ code: "PRODUCT_LOCATION_NOT_ALLOWED", message: "Only studio products are assigned to a location." });
    if (!existing) input.locationId = null;
    return;
  }
  const locationId = input.locationId !== undefined ? input.locationId : existingLocationId;
  if (!locationId) {
    if (!existing || !isStudioProduct(existing)) badRequest({ code: "PRODUCT_LOCATION_REQUIRED", message: "Select a location for this studio product." });
    return; // Unassigned legacy records remain manageable, but never customer-selectable.
  }
  if (existingLocationId === locationId) return;
  await assertTenantLocationsWithinWorkspaceScope({ tenantId, locationIds: [locationId], allowedLocationIds });
};

export const productService = {
  async listProducts(filters: ListProductsServiceFilters): Promise<{
    products: ProductPublicDto[];
    totalCount: number;
    currentPage: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { tenantId, type, types, ...restFilters } = filters;

    if (filters.locationId) assertLocationIdsWithinWorkspaceScope([filters.locationId], filters.allowedLocationIds ?? null);
    const productRepository = createProductRepository({ tenantId });

    const repositoryFilters: Omit<ProductListFilters, "tenantId"> = {
      ...restFilters,
      type: type as ProductType | undefined,
      types,
    };

    const [products, totalCount] = await Promise.all([
      productRepository.list(repositoryFilters),
      productRepository.count(repositoryFilters),
    ]);

    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);

    return {
      products: products.map(toProductPublicDto),
      totalCount,
      currentPage: page,
      pageSize: limit,
      totalPages: Math.ceil(totalCount / limit),
    };
  },

  async listPublicProducts(params: {
    tenantId: string;
    locationId?: string;
    search?: string;
    page?: number;
    limit?: number;
    coursesOnly?: boolean;
    respectPublicCourseVisibility?: boolean;
  }): Promise<{
    products: ProductCatalogDto[];
    totalCount: number;
    currentPage: number;
    pageSize: number;
    totalPages: number;
  }> {
    const tenant = await getTenantOrThrow(params.tenantId);
    const coursePagesVisible =
      !params.respectPublicCourseVisibility || isCourseBrowsingVisible(tenant);
    const types = filterPublicProductTypesForPlan({
      tenant,
      types: getEnabledPublicProductTypes({
        coursesOnly: params.coursesOnly,
        modules: tenant.modules,
      }),
    }).filter(
      (type) =>
        coursePagesVisible ||
        !PUBLIC_COURSE_PRODUCT_TYPES.includes(
          type as (typeof PUBLIC_COURSE_PRODUCT_TYPES)[number],
        ),
    );
    const page = Math.max(Number(params.page || 1), 1);
    const limit = Math.min(Math.max(Number(params.limit || 50), 1), 100);

    if (types.length === 0) {
      return {
        products: [],
        totalCount: 0,
        currentPage: page,
        pageSize: limit,
        totalPages: 0,
      };
    }

    const result = await this.listProducts({
      tenantId: params.tenantId,
      locationId: params.locationId,
      coursePublicationLocationId: params.locationId,
      assignedStudioOnly: true,
      types,
      isActive: true,
      search: params.search,
      page: params.page,
      limit: params.limit,
    });

    return {
      ...result,
      products: result.products.map((product) => toProductCatalogDto(product)),
    };
  },

  async listPublicVoucherProducts(params: {
    tenantId: string;
    limit?: number;
  }): Promise<ProductVoucherCatalogDto[]> {
    const tenant = await getTenantOrThrow(params.tenantId);
    const types = filterPublicProductTypesForPlan({
      tenant,
      types: getEnabledPublicProductTypes({
        modules: tenant.modules,
      }).filter((type) => type === PRODUCT_TYPE.COUPON),
    });

    if (types.length === 0) return [];

    const result = await this.listProducts({
      tenantId: params.tenantId,
      types,
      isActive: true,
      page: 1,
      limit: Math.min(Math.max(Number(params.limit || 24), 1), 100),
    });

    return result.products
      .filter((product) => {
        if (
          product.type !== PRODUCT_TYPE.COUPON ||
          (!product.voucherTemplate?.trim() && !voucherDesignSchema.safeParse(product.voucherDesign).success) ||
          product.voucherSettings?.type === "experience" ||
          Number(product.price) <= 0
        ) return false;
        try {
          assertVoucherCanBeIssued(normalizeVoucherSettings(product.voucherSettings), new Date(), tenant.settings.timezone || "UTC");
          return true;
        } catch {
          return false;
        }
      })
      .map(toProductVoucherCatalogDto);
  },

  async getPublicProduct(params: {
    tenantId: string;
    locationId?: string;
    productId: string;
    coursesOnly?: boolean;
    respectPublicCourseVisibility?: boolean;
  }): Promise<ProductCatalogDto> {
    const tenant = await getTenantOrThrow(params.tenantId);
    const productRepository = createProductRepository({
      tenantId: params.tenantId,
    });
    const product = await productRepository.findOne(
      {
        _id: params.productId,
        type: {
          $in: params.coursesOnly
            ? PUBLIC_COURSE_PRODUCT_TYPES
            : PUBLIC_PRODUCT_TYPES,
        },
        isActive: true,
        isArchived: { $ne: true },
        $and: [buildProductLocationFilter({ locationId: params.locationId, assignedStudioOnly: true }), buildCoursePublicationLocationFilter(params.locationId)].filter(Boolean),
      },
      { lean: false },
    );

    if (!product) {
      notFound({
        message: "Product not found.",
        code: "PUBLIC_PRODUCT_NOT_FOUND",
      });
    }

    if (
      params.respectPublicCourseVisibility &&
      PUBLIC_COURSE_PRODUCT_TYPES.includes(
        product.type as (typeof PUBLIC_COURSE_PRODUCT_TYPES)[number],
      ) &&
      !isCourseBrowsingVisible(tenant)
    ) {
      notFound({
        message: "Product not found.",
        code: "PUBLIC_PRODUCT_NOT_FOUND",
      });
    }

    assertPublicProductTypeEnabled({
      modules: tenant.modules,
      type: String(product.type),
    });
    assertProductKindEntitledForTenant({
      tenant,
      kind: resolveProductKindV2(product),
    });

    return toProductCatalogDto(product);
  },

  async createProduct(params: {
    tenantId: string;
    allowedLocationIds?: AllowedWorkspaceLocationIds;
    createdBy: string;
    input: CreateProductInput;
    file?: UploadedFileLike;
    image?: UploadedFileLike;
  }): Promise<ProductPublicDto> {
    const productRepository = createProductRepository({
      tenantId: params.tenantId,
    });

    const tenant = await getTenantOrThrow(params.tenantId);
    const tenantCurrency = normalizeStudioCommerceCurrency(
      tenant.settings.currency,
    );
    const currency = normalizeStudioCommerceCurrency(
      params.input.currency ?? tenantCurrency,
    );

    if (currency !== tenantCurrency) {
      badRequest("Product currency must match the workspace currency.");
    }

    assertProductMoney(params.input.price, currency, "price");
    assertProductMoney(params.input.extraCharge, currency, "extraCharge");

    if (params.input.type) {
      assertTenantManagedProduct(String(params.input.type));
    }

    const input = canonicalizeTenantProductWrite({
      input: { ...params.input, currency },
    });

    if (input.courseContent?.locationIds?.length) await assertTenantLocationsWithinWorkspaceScope({ tenantId: params.tenantId, locationIds: input.courseContent.locationIds, allowedLocationIds: params.allowedLocationIds ?? null });
    await prepareStudioProductLocation({ tenantId: params.tenantId, input, allowedLocationIds: params.allowedLocationIds });
    await assertOpenStudioLocationAvailable({ repository: productRepository, input });
    assertProductMoney(input.openStudioPolicy?.privateBookingSurcharge, currency, "privateBookingSurcharge");
    assertTenantManagedProduct(String(input.type));
    assertProductKindEntitledForTenant({
      tenant,
      kind: normalizeProductKindV2(input.kind),
    });

    const classCategory =
      await productClassCategoryService.resolveProductAssignment({
        tenantId: params.tenantId,
        kind: normalizeProductKindV2(input.kind),
        value: params.input.classCategory,
      });
    if (classCategory !== undefined) input.classCategory = classCategory;

    await assertRelatedProductBelongsToTenant({
      productRepository,
      productId: input.couponProduct,
    });

    await prepareVoucherSettings({ input, productRepository, timezone: tenant.settings.timezone });
    if (input.voucherDesign != null) {
      if (input.kind !== PRODUCT_KIND.VOUCHER) badRequest({ code: "PRODUCT_VOUCHER_DESIGN_KIND_INVALID", message: "Voucher designs can only be assigned to voucher offerings." });
      input.voucherDesign = await prepareVoucherDesign(params.tenantId, input.voucherDesign);
    }

    let uploadedImage: UploadedProductImage | undefined;
    let product;

    try {
      if (params.image) {
        uploadedImage = await uploadProductImage({
          tenantId: params.tenantId,
          file: params.image,
        });
        input.imageSrc = uploadedImage.url;
      }

      if (input.kind === PRODUCT_KIND.VOUCHER && params.file) {
        input.voucherTemplate = await this.uploadCouponTemplate({
          file: params.file,
          productName: input.name,
        });
      }

      const classCategoryToClaim = String(input.classCategory ?? "");
      if (input.kind === PRODUCT_KIND.VOUCHER) {
        product = await withProductClassCategoryTransaction(async (session) => {
          const lockedTenant = await acquireVoucherTenantMutationLock(params.tenantId, session);
          const transactionalRepository = createProductRepository({ tenantId: params.tenantId, session });
          await prepareVoucherSettings({ input, productRepository: transactionalRepository, timezone: lockedTenant.settings?.timezone });
          await assertVoucherOfferingPublicationAllowed({ tenantId: params.tenantId, session, tenant: lockedTenant, desired: input });
          return transactionalRepository.create(params.createdBy, input as CreateProductInput);
        });
      } else if (getProductClassCategoryNameKey(classCategoryToClaim)) {
        product = await withProductClassCategoryTransaction(async (session) => {
          input.classCategory =
            await productClassCategoryService.claimProductAssignment(
              params.tenantId,
              classCategoryToClaim,
              session,
            );
          return createProductRepository({
            tenantId: params.tenantId,
            session,
          }).create(params.createdBy, input as CreateProductInput);
        });
      } else {
        product = await productRepository.create(
          params.createdBy,
          input as CreateProductInput,
        );
      }
    } catch (error) {
      if (uploadedImage) {
        await deleteUploadedProductImage({ key: uploadedImage.key });
      }

      if (isDuplicateKeyError(error)) {
        // A same-name race can report the name index before the slot index.
        await assertOpenStudioLocationAvailable({ repository: productRepository, input, forceConflict: isOpenStudioLocationDuplicateError(error) });
      }
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "A product with this name already exists.",
          code: "PRODUCT_NAME_CONFLICT",
        });
      }

      throw error;
    }

    return toProductPublicDto(product);
  },

  async updateProduct(params: {
    tenantId: string;
    allowedLocationIds?: AllowedWorkspaceLocationIds;
    input: UpdateProductInput;
    file?: UploadedFileLike;
    image?: UploadedFileLike;
  }): Promise<ProductPublicDto> {
    const productRepository = createProductRepository({
      tenantId: params.tenantId,
    });

    const tenant = await getTenantOrThrow(params.tenantId);
    const tenantCurrency = normalizeStudioCommerceCurrency(
      tenant.settings.currency,
    );
    const currency = normalizeStudioCommerceCurrency(
      params.input.currency ?? tenantCurrency,
    );

    if (currency !== tenantCurrency) {
      badRequest("Product currency must match the workspace currency.");
    }

    assertProductMoney(params.input.price, currency, "price");
    assertProductMoney(params.input.extraCharge, currency, "extraCharge");

    const existingProduct = await productRepository.findById(params.input.id, {
      lean: false,
    });

    if (!existingProduct) {
      notFound("Product not found.");
    }
    assertStudioProductLocationAccess(existingProduct, params.allowedLocationIds ?? null);
    if (existingProduct.isArchived) conflict({ code: "PRODUCT_ARCHIVED", message: "Archived studio products cannot be edited. Create a new offering instead." });

    const input = canonicalizeTenantProductWrite({
      input: { ...params.input, currency },
      existing: existingProduct,
    });
    if (input.courseContent?.locationIds?.length) await assertTenantLocationsWithinWorkspaceScope({ tenantId: params.tenantId, locationIds: input.courseContent.locationIds, allowedLocationIds: params.allowedLocationIds ?? null });
    await prepareStudioProductLocation({ tenantId: params.tenantId, input, existing: existingProduct, allowedLocationIds: params.allowedLocationIds });
    await assertOpenStudioLocationAvailable({ repository: productRepository, input, existing: existingProduct });
    assertProductMoney(input.openStudioPolicy?.privateBookingSurcharge, currency, "privateBookingSurcharge");
    const effectiveType = String(input.type ?? existingProduct.type);
    const effectiveKind =
      normalizeProductKindV2(input.kind) ??
      resolveProductKindV2(existingProduct);
    const effectiveCapacity =
      input.maxNumberOfParticipants !== undefined
        ? input.maxNumberOfParticipants
        : existingProduct.maxNumberOfParticipants;
    const effectiveIsActive =
      input.isActive !== undefined ? input.isActive : existingProduct.isActive;
    const effectiveLabel = String(
      input.label !== undefined ? input.label : existingProduct.label,
    ).trim();

    const classCategory =
      await productClassCategoryService.resolveProductAssignment({
        tenantId: params.tenantId,
        kind: effectiveKind,
        value: params.input.classCategory,
        existingValue: existingProduct.classCategory,
      });
    if (classCategory !== undefined) input.classCategory = classCategory;

    const requestedClassCategory =
      input.classCategory === undefined
        ? undefined
        : String(input.classCategory);

    if (effectiveIsActive) {
      assertProductKindEntitledForTenant({ tenant, kind: effectiveKind });
    }

    if (
      bookableProductTypes.has(effectiveType) &&
      effectiveIsActive &&
      effectiveCapacity == null
    ) {
      badRequest({
        message: "Bookable products require a participant capacity.",
        code: "PRODUCT_PARTICIPANT_CAPACITY_REQUIRED",
      });
    }

    assertTenantManagedProduct(String(existingProduct.type));
    assertTenantManagedProduct(effectiveType);

    if (effectiveKind === PRODUCT_KIND.VOUCHER && !effectiveLabel) {
      badRequest({
        message: "Voucher products require a label.",
        code: "PRODUCT_VOUCHER_LABEL_REQUIRED",
      });
    }

    await assertRelatedProductBelongsToTenant({
      productRepository,
      productId: input.couponProduct,
      currentProductId: input.id,
    });

    await prepareVoucherSettings({ input, existing: existingProduct, productRepository, timezone: tenant.settings.timezone });
    if (input.voucherDesign != null) {
      if (effectiveKind !== PRODUCT_KIND.VOUCHER) badRequest({ code: "PRODUCT_VOUCHER_DESIGN_KIND_INVALID", message: "Voucher designs can only be assigned to voucher offerings." });
      input.voucherDesign = await prepareVoucherDesign(params.tenantId, input.voucherDesign);
    }
    if (input.voucherDesign === null && existingProduct.voucherDesign && effectiveKind === PRODUCT_KIND.VOUCHER && !String(input.voucherTemplate ?? existingProduct.voucherTemplate ?? "").trim() && !params.file) {
      badRequest({ code: "PRODUCT_VOUCHER_TEMPLATE_REQUIRED", message: "Upload a PDF template before switching this offering from the voucher editor." });
    }

    let uploadedImage: UploadedProductImage | undefined;
    let product;

    try {
      if (params.image) {
        uploadedImage = await uploadProductImage({
          tenantId: params.tenantId,
          file: params.image,
        });
        input.imageSrc = uploadedImage.url;
      }

      if (effectiveKind === PRODUCT_KIND.VOUCHER && params.file) {
        input.voucherTemplate = await this.uploadCouponTemplate({
          file: params.file,
          productName: input.name || "coupon-template",
        });
      }

      product = await withProductClassCategoryTransaction(async (session) => {
        const lockedTenant = await acquireVoucherTenantMutationLock(params.tenantId, session);
        const transactionalRepository = createProductRepository({
          tenantId: params.tenantId,
          session,
        });
        const currentProduct = await transactionalRepository.findById(
          params.input.id,
          { lean: false },
        );
        if (!currentProduct) notFound("Product not found.");
        if (currentProduct.isArchived) conflict({ code: "PRODUCT_ARCHIVED", message: "Archived studio products cannot be edited. Create a new offering instead." });

        await prepareStudioProductLocation({ tenantId: params.tenantId, input, existing: currentProduct, allowedLocationIds: params.allowedLocationIds });
        const currentKind = resolveProductKindV2(currentProduct);
        const desiredKind = normalizeProductKindV2(input.kind) ?? currentKind;
        if (
          desiredKind === PRODUCT_KIND.VOUCHER &&
          input.voucherDesign === null &&
          currentProduct.voucherDesign &&
          !String(input.voucherTemplate ?? currentProduct.voucherTemplate ?? "").trim()
        ) {
          badRequest({
            code: "PRODUCT_VOUCHER_TEMPLATE_REQUIRED",
            message: "Upload a PDF template before switching this offering from the voucher editor.",
          });
        }
        if (lockedTenant) {
          // Re-read active state inside the lock: two updates must not claim a
          // publication slot using a stale pre-transaction product snapshot.
          const desired = { ...input, isActive: input.isActive ?? currentProduct.isActive };
          await prepareVoucherSettings({ input, existing: currentProduct, productRepository: transactionalRepository, timezone: lockedTenant.settings?.timezone });
          await assertVoucherOfferingPublicationAllowed({ tenantId: params.tenantId, session, tenant: lockedTenant, current: currentProduct, desired });
          if (currentKind === PRODUCT_KIND.VOUCHER && desiredKind !== PRODUCT_KIND.VOUCHER) {
            const policy = await getVoucherOfferingDeletionPolicy({ tenantId: params.tenantId, productId: String(currentProduct._id), session });
            if (policy.unexpiredCodeCount || policy.perpetualCodeCount || policy.pendingOrderCount) {
              conflict({ message: "A voucher with outstanding codes or purchases cannot be changed to another product kind. Archive it instead.", code: "VOUCHER_OFFERING_KIND_CHANGE_BLOCKED" });
            }
            await preserveLegacyVoucherValuesBeforeDeletion({ tenantId: params.tenantId, product: currentProduct, session });
            input.voucherSettings = undefined;
            input.voucherDesign = null;
          }
        }
        const currentClassCategory = String(currentProduct.classCategory ?? "");
        const currentCategoryKey =
          getProductClassCategoryNameKey(currentClassCategory);
        let desiredClassCategory =
          desiredKind !== PRODUCT_KIND.CLASS
            ? ""
            : requestedClassCategory !== undefined
              ? requestedClassCategory
              : currentKind === PRODUCT_KIND.CLASS
                ? currentClassCategory
                : "";
        const desiredCategoryKey =
          getProductClassCategoryNameKey(desiredClassCategory);
        const currentAssignmentIsCounted =
          currentKind === PRODUCT_KIND.CLASS && Boolean(currentCategoryKey);
        const desiredAssignmentIsCounted =
          desiredKind === PRODUCT_KIND.CLASS && Boolean(desiredCategoryKey);
        const countedAssignmentChanged =
          currentAssignmentIsCounted !== desiredAssignmentIsCounted ||
          (currentAssignmentIsCounted &&
            desiredAssignmentIsCounted &&
            currentCategoryKey !== desiredCategoryKey);

        if (countedAssignmentChanged && desiredAssignmentIsCounted) {
          desiredClassCategory =
            await productClassCategoryService.claimProductAssignment(
              params.tenantId,
              desiredClassCategory,
              session,
            );
        }
        input.classCategory = desiredClassCategory;

        const updated = await transactionalRepository.update(
          input as UpdateProductInput,
        );
        if (!updated) notFound("Product not found.");

        if (countedAssignmentChanged && currentAssignmentIsCounted) {
          await productClassCategoryService.releaseProductAssignment(
            params.tenantId,
            currentClassCategory,
            session,
          );
        }

        return updated;
      });
    } catch (error) {
      if (uploadedImage) {
        await deleteUploadedProductImage({ key: uploadedImage.key });
      }

      if (isDuplicateKeyError(error)) {
        await assertOpenStudioLocationAvailable({ repository: productRepository, input, existing: existingProduct, forceConflict: isOpenStudioLocationDuplicateError(error) });
      }
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "A product with this name already exists.",
          code: "PRODUCT_NAME_CONFLICT",
        });
      }

      throw error;
    }

    if (!product) {
      if (uploadedImage) {
        await deleteUploadedProductImage({ key: uploadedImage.key });
      }
      notFound("Product not found.");
    }

    if (
      input.maxNumberOfParticipants !== undefined &&
      Number(product.maxNumberOfParticipants ?? 0) >
        Number(existingProduct.maxNumberOfParticipants ?? 0)
    ) {
      const { reconcileWaitlistCapacityForProduct } =
        await import("@/modules/waitlist/waitlist.reconciliation.service.js");
      await reconcileWaitlistCapacityForProduct({
        tenantId: params.tenantId,
        productId: String(product._id),
      }).catch(() => 0);
    }

    return toProductPublicDto(product);
  },

  async getVoucherAllowance(tenantId: string) {
    const tenant = await getTenantOrThrow(tenantId);
    const activeCount = await countActiveVoucherOfferings(tenantId);
    const maxActiveVoucherOfferings = resolveVoucherOfferingLimit(tenant);
    return { activeCount, maxActiveVoucherOfferings, canPublish: maxActiveVoucherOfferings === null || activeCount < maxActiveVoucherOfferings, grandfathered: tenant.voucherQuotaVersion === undefined };
  },

  async getDeletionPolicy(params: { tenantId: string; productId: string; allowedLocationIds?: AllowedWorkspaceLocationIds }) {
    const product = await createProductRepository({ tenantId: params.tenantId }).findById(params.productId);
    if (!product) notFound("Product not found.");
    assertStudioProductLocationAccess(product, params.allowedLocationIds ?? null);
    return getVoucherOfferingDeletionPolicy(params);
  },

  async deleteProduct(params: {
    tenantId: string;
    allowedLocationIds?: AllowedWorkspaceLocationIds;
    productId: string;
    deleteConfirmation?: string;
  }): Promise<ProductPublicDto> {
    const product = await withProductClassCategoryTransaction(
      async (session) => {
        await acquireVoucherTenantMutationLock(params.tenantId, session);
        const transactionalRepository = createProductRepository({
          tenantId: params.tenantId,
          session,
        });
        const currentProduct = await transactionalRepository.findById(
          params.productId,
          { lean: false },
        );
        if (!currentProduct) notFound("Product not found.");

        assertStudioProductLocationAccess(currentProduct, params.allowedLocationIds ?? null);
        assertTenantManagedProduct(String(currentProduct.type));
        // Retain studio product IDs for historical bookings and purchases.
        if (isStudioProduct(currentProduct)) {
          const archived = await transactionalRepository.updateById(params.productId, { $set: { isActive: false, isArchived: true } });
          if (!archived) notFound("Product not found.");
          return archived;
        }
        const policy = await getVoucherOfferingDeletionPolicy({ tenantId: params.tenantId, productId: params.productId, session });
        assertVoucherOfferingDeletable(policy, params.deleteConfirmation);
        await preserveLegacyVoucherValuesBeforeDeletion({ tenantId: params.tenantId, product: currentProduct, session });

        const deleted = await transactionalRepository.delete(params.productId);
        if (!deleted) notFound("Product not found.");

        const currentClassCategory = String(currentProduct.classCategory ?? "");
        if (
          resolveProductKindV2(currentProduct) === PRODUCT_KIND.CLASS &&
          getProductClassCategoryNameKey(currentClassCategory)
        ) {
          await productClassCategoryService.releaseProductAssignment(
            params.tenantId,
            currentClassCategory,
            session,
          );
        }

        return deleted;
      },
    );

    return toProductPublicDto(product);
  },

  async uploadCouponTemplate(params: {
    file: UploadedFileLike;
    productName: string;
  }): Promise<string> {
    const file = assertValidPdfFile(params.file);
    const key = buildCouponTemplateKey(params.productName);

    await uploadBufferToR2({
      key,
      buffer: file.buffer,
      contentType: "application/pdf",
      cacheControl: "public, max-age=31536000, immutable",
    });

    return key;
  },
};
