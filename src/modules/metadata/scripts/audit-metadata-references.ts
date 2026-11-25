import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mongo } from "mongoose";
import {
  auditMetadataReferences,
  metadataAuditLimits,
  type MetadataAuditOptions,
} from "../metadata-reference-audit.js";

export function parseMetadataAuditArguments(args: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--database",
    "--uri-env",
    "--output",
    "--details-file",
    "--max-documents",
    "--batch-size",
    "--max-duration-ms",
    "--query-timeout-ms",
    "--detail-limit",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (
      !allowed.has(option) ||
      values.has(option) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("Invalid metadata audit arguments.");
    values.set(option, value);
  }
  const database = values.get("--database");
  const uriEnv = values.get("--uri-env") ?? "MONGO_URI";
  if (
    !database ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(database) ||
    !/^[A-Z_][A-Z0-9_]*$/.test(uriEnv)
  )
    throw new Error(
      "An explicit database and a valid URI environment name are required.",
    );
  const number = (name: string) =>
    values.has(name) ? Number(values.get(name)) : undefined;
  const options: MetadataAuditOptions = {
    maxDocuments: number("--max-documents"),
    batchSize: number("--batch-size"),
    maxDurationMs: number("--max-duration-ms"),
    queryTimeoutMs: number("--query-timeout-ms"),
    detailLimit: number("--detail-limit"),
    includeRestrictedIds: values.has("--details-file"),
  };
  metadataAuditLimits(options);
  const output = values.get("--output");
  const detailsFile = values.get("--details-file");
  if (output && detailsFile && resolve(output) === resolve(detailsFile))
    throw new Error("Summary and restricted details need separate files.");
  return { database, uriEnv, output, detailsFile, options };
}

export async function runMetadataAuditCli(args: string[], env = process.env) {
  let client: mongo.MongoClient | undefined;
  const files: Awaited<ReturnType<typeof open>>[] = [];
  try {
    const options = parseMetadataAuditArguments(args);
    const uri = env[options.uriEnv];
    if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
      throw new Error("Mongo URI is unavailable.");
    // Create new private artifacts only; never follow an existing symlink or
    // overwrite a previous audit. Connection details are never CLI arguments.
    const summaryFile = options.output
      ? await open(options.output, "wx", 0o600)
      : null;
    if (summaryFile) files.push(summaryFile);
    const detailFile = options.detailsFile
      ? await open(options.detailsFile, "wx", 0o600)
      : null;
    if (detailFile) files.push(detailFile);
    client = new mongo.MongoClient(uri, {
      appName: "shario-metadata-reference-audit-read-only",
      maxPoolSize: 2,
      minPoolSize: 0,
      retryReads: false,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      readPreference: "primary",
    });
    await client.connect();
    const result = await auditMetadataReferences(
      client,
      options.database,
      options.options,
    );
    const summary = JSON.stringify(result.summary, null, 2) + "\n";
    if (summaryFile) await summaryFile.writeFile(summary);
    if (detailFile)
      await detailFile.writeFile(
        JSON.stringify(
          {
            schemaVersion: 1,
            classification: "restricted-record-identifiers",
            complete: result.summary.complete,
            truncated: result.summary.restrictedDetailsTruncated,
            details: result.details,
          },
          null,
          2,
        ) + "\n",
      );
    process.stdout.write(summary);
    return result.summary.status === "clean"
      ? 0
      : result.summary.complete
        ? 2
        : 3;
  } catch {
    process.stderr.write(
      "Metadata audit unavailable: verify arguments, output paths, read access and MongoDB snapshot support. No clean result was produced.\n",
    );
    return 1;
  } finally {
    await client?.close().catch(() => {});
    await Promise.allSettled(files.map((file) => file.close()));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runMetadataAuditCli(process.argv.slice(2));
