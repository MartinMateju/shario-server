import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const transport = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = transport.send;
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: transport.sign,
}));
import {
  getPresignedR2Url,
  getR2ObjectMetadata,
} from "@/infrastructure/storage/r2.client.js";

describe("R2 public delivery signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-access");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("R2_BUCKET", "shario-private-test");
    vi.stubEnv("R2_ENDPOINT", "");
    vi.stubEnv("R2_JURISDICTION", "eu");
    vi.stubEnv("R2_PUBLIC_URL", "https://api.shario.test/media/public");
    transport.send.mockResolvedValue({
      ContentType: "image/png",
      ContentLength: 1234,
      Metadata: { private: "not returned" },
    });
    transport.sign.mockResolvedValue("https://signed.test/object");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses HEAD to obtain only image metadata from the configured private bucket", async () => {
    await expect(getR2ObjectMetadata({ key: "object.png" })).resolves.toEqual({
      contentType: "image/png",
      contentLength: 1234,
    });
    const command = transport.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({
      Bucket: "shario-private-test",
      Key: "object.png",
    });
  });

  it("signs content metadata and a no-store policy together with the exact GET object", async () => {
    await getPresignedR2Url({
      key: "object.png",
      expiresInSeconds: 300,
      responseContentType: "image/png",
      responseContentDisposition: "inline",
      responseCacheControl: "no-store",
    });
    const [, command, options] = transport.sign.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: "shario-private-test",
      Key: "object.png",
      ResponseContentType: "image/png",
      ResponseContentDisposition: "inline",
      ResponseCacheControl: "no-store",
    });
    expect(options).toEqual({ expiresIn: 300 });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("preserves existing private communications signing without public-response overrides", async () => {
    await getPresignedR2Url({
      key: "tenants/tenant/communications/private",
      expiresInSeconds: 2000,
    });
    expect(transport.sign.mock.calls[0][1].input).toEqual({
      Bucket: "shario-private-test",
      Key: "tenants/tenant/communications/private",
    });
    expect(transport.sign.mock.calls[0][2]).toEqual({ expiresIn: 900 });
  });
});
