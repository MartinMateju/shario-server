import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const originalNodeEnv =
  process.env.NODE_ENV;
const originalDevelopmentRoot =
  process.env.DEVELOPMENT_ROOT_DOMAIN;
const originalServerUrl =
  process.env.SERVER_URL;
const originalCookieDomains =
  process.env.AUTH_COOKIE_DOMAINS;

const loadCookieOptions = async ({
  nodeEnv,
  developmentRoot,
  serverUrl,
  cookieDomains,
}: {
  nodeEnv: "development" | "production";
  developmentRoot?: string;
  serverUrl?: string;
  cookieDomains?: string;
}) => {
  vi.resetModules();
  process.env.NODE_ENV = nodeEnv;

  if (developmentRoot === undefined) {
    delete process.env.DEVELOPMENT_ROOT_DOMAIN;
  } else {
    process.env.DEVELOPMENT_ROOT_DOMAIN =
      developmentRoot;
  }

  if (serverUrl === undefined) {
    delete process.env.SERVER_URL;
  } else {
    process.env.SERVER_URL =
      serverUrl;
  }

  if (cookieDomains === undefined) {
    delete process.env.AUTH_COOKIE_DOMAINS;
  } else {
    process.env.AUTH_COOKIE_DOMAINS =
      cookieDomains;
  }

  return import(
    "@/modules/auth/auth.utils.js"
  );
};

afterEach(() => {
  vi.resetModules();

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV =
      originalNodeEnv;
  }

  if (
    originalDevelopmentRoot ===
    undefined
  ) {
    delete process.env.DEVELOPMENT_ROOT_DOMAIN;
  } else {
    process.env.DEVELOPMENT_ROOT_DOMAIN =
      originalDevelopmentRoot;
  }

  if (originalServerUrl === undefined) {
    delete process.env.SERVER_URL;
  } else {
    process.env.SERVER_URL =
      originalServerUrl;
  }

  if (
    originalCookieDomains === undefined
  ) {
    delete process.env.AUTH_COOKIE_DOMAINS;
  } else {
    process.env.AUTH_COOKIE_DOMAINS =
      originalCookieDomains;
  }
});

describe("refresh cookie topology", () => {
  it("keeps shario.localhost registration sessions usable with the legacy localhost root setting", async () => {
    const {
      getRefreshCookieOptions,
      getClearRefreshCookieOptions,
      getRefreshCookieCleanupOptions,
    } = await loadCookieOptions({
      nodeEnv: "development",
      developmentRoot: "localhost",
      serverUrl:
        "http://api.shario.localhost:4000",
    });

    const origin =
      "http://studio-olivka.shario.localhost:3000";

    expect(
      getRefreshCookieOptions(origin),
    ).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    expect(
      getClearRefreshCookieOptions(origin),
    ).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    expect(
      getRefreshCookieOptions(origin),
    ).not.toHaveProperty("domain");
    expect(
      getRefreshCookieCleanupOptions(
        origin,
      ).map(
        (options) => options.domain,
      ),
    ).toEqual([
      undefined,
      ".shario.localhost",
    ]);
  });

  it("retains the explicit cross-site fallback for legacy flat localhost origins", async () => {
    const {
      getRefreshCookieOptions,
    } = await loadCookieOptions({
      nodeEnv: "development",
      developmentRoot: "localhost",
      serverUrl:
        "http://api.shario.localhost:4000",
    });

    expect(
      getRefreshCookieOptions(
        "http://studio-olivka.localhost:3000",
      ),
    ).toMatchObject({
      secure: true,
      sameSite: "none",
    });
  });

  it("does not weaken production custom-domain cookie requirements", async () => {
    const {
      getRefreshCookieOptions,
      getRefreshCookieCleanupOptions,
    } = await loadCookieOptions({
      nodeEnv: "production",
      developmentRoot: "localhost",
      serverUrl:
        "https://api.shario.io",
    });

    expect(
      getRefreshCookieOptions(
        "https://studio-olivka.shario.io",
      ),
    ).toMatchObject({
      secure: true,
      sameSite: "lax",
    });
    expect(
      getRefreshCookieOptions(
        "https://olivka.example",
      ),
    ).toMatchObject({
      secure: true,
      sameSite: "none",
    });
    expect(
      getRefreshCookieOptions(
        "https://olivka.example",
        { firstPartyProxy: true },
      ),
    ).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(
      getRefreshCookieOptions(
        "https://olivka.example",
        { firstPartyProxy: true },
      ),
    ).not.toHaveProperty("domain");
    expect(
      getRefreshCookieCleanupOptions(
        "https://olivka.example",
      ).map(
        (options) => options.domain,
      ),
    ).toEqual([
      undefined,
      ".shario.io",
    ]);
  });

  it("never derives a cleanup domain from an arbitrary tenant origin or unrelated configuration", async () => {
    const {
      getRefreshCookieCleanupOptions,
    } = await loadCookieOptions({
      nodeEnv: "production",
      serverUrl:
        "https://api.shario.io",
      cookieDomains:
        "evil.example,shario.io",
    });

    const options =
      getRefreshCookieCleanupOptions(
        "https://tenant.evil.example",
      );

    expect(options).toHaveLength(2);
    expect(options).toContainEqual(
      expect.objectContaining({
        domain: ".shario.io",
      }),
    );
    expect(options).not.toContainEqual(
      expect.objectContaining({
        domain: ".evil.example",
      }),
    );
  });

  it("does not send an inapplicable shario.localhost Domain cleanup from a plain localhost API", async () => {
    const {
      getRefreshCookieCleanupOptions,
    } = await loadCookieOptions({
      nodeEnv: "development",
      developmentRoot:
        "shario.localhost",
      serverUrl:
        "http://localhost:4000",
    });

    expect(
      getRefreshCookieCleanupOptions(
        "http://studio-olivie.shario.localhost:3000",
      ).map(
        (options) => options.domain,
      ),
    ).toEqual([undefined]);
  });
});
