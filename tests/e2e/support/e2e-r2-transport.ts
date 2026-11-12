import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertE2ETestMode } from "@/config/e2e-mode.js";

/** Replace only the object-storage transport in the isolated E2E process. */
export const installE2ER2Transport = () => {
  assertE2ETestMode();
  if (
    process.env.R2_BUCKET !== "e2e-bucket" ||
    process.env.R2_ACCESS_KEY_ID !== "e2e-access-key"
  ) {
    throw new Error(
      "The E2E storage transport requires isolated dummy credentials.",
    );
  }
  const objects = new Map<string, Buffer>();
  S3Client.prototype.send = async function (
    command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand,
  ) {
    assertE2ETestMode();
    if (command.input.Bucket !== "e2e-bucket" || !command.input.Key) {
      throw new Error(
        "Refusing E2E storage access outside the isolated bucket.",
      );
    }
    const key = command.input.Key;
    if (command instanceof PutObjectCommand) {
      if (!(command.input.Body instanceof Uint8Array))
        throw new Error("E2E storage accepts byte buffers only.");
      objects.set(key, Buffer.from(command.input.Body));
      return { $metadata: { httpStatusCode: 200 }, ETag: '"e2e-object"' };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    }
    if (command instanceof GetObjectCommand) {
      const bytes = objects.get(key);
      if (!bytes)
        throw Object.assign(new Error("No such E2E object"), {
          name: "NoSuchKey",
        });
      return {
        $metadata: { httpStatusCode: 200 },
        Body: Readable.from([bytes]),
        ContentLength: bytes.length,
      };
    }
    // Never fall through to a real provider for an unsupported operation.
    throw new Error("Unsupported E2E storage command.");
  } as typeof S3Client.prototype.send;
};
