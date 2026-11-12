import mongoose, { type mongo } from "mongoose";

export const KNOWLEDGE_TEXT_INDEX_KEY = {
  tenantId: 1,
  title: "text",
  summary: "text",
  content: "text",
  transcript: "text",
  tags: "text",
} as const;

export const LEGACY_KNOWLEDGE_TEXT_INDEX_NAME =
  "tenantId_1_title_text_summary_text_content_text_transcript_text_tags_text";

export const KNOWLEDGE_TEXT_INDEX_OPTIONS = {
  name: "knowledge_text_locale_neutral_v1",
  default_language: "none",
  // `language` is the article's UI locale (including unsupported FTS locales
  // such as Czech), not a MongoDB stemming algorithm selector.
  language_override: "textIndexLanguage",
} as const;

type KnowledgeIndex = {
  name?: string;
  key?: Record<string, unknown>;
  weights?: Record<string, unknown>;
  default_language?: string;
  language_override?: string;
  textIndexVersion?: number;
  unique?: boolean;
  sparse?: boolean;
  hidden?: boolean;
  partialFilterExpression?: unknown;
  collation?: { locale?: string };
};
type IndexCollection = Pick<
  mongo.Collection,
  "createIndex" | "listIndexes" | "dropIndex"
>;

const hasMongoCode = (error: unknown, code: number) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === code;

const isExpectedShape = (index: KnowledgeIndex) => {
  const key = index.key ?? {};
  const weights = index.weights ?? {};
  return (
    Object.keys(key).join(",") === "tenantId,_fts,_ftsx" &&
    key.tenantId === 1 &&
    key._fts === "text" &&
    key._ftsx === 1 &&
    Object.keys(weights).length === 5 &&
    ["title", "summary", "content", "transcript", "tags"].every(
      (field) => weights[field] === 1,
    ) &&
    index.textIndexVersion === 3 &&
    !index.unique &&
    !index.sparse &&
    !index.hidden &&
    !index.partialFilterExpression &&
    (!index.collation || index.collation.locale === "simple")
  );
};

const isCanonical = (index: KnowledgeIndex) =>
  index.name === KNOWLEDGE_TEXT_INDEX_OPTIONS.name &&
  index.default_language === KNOWLEDGE_TEXT_INDEX_OPTIONS.default_language &&
  index.language_override === KNOWLEDGE_TEXT_INDEX_OPTIONS.language_override &&
  isExpectedShape(index);

const listIndexes = async (
  collection: IndexCollection,
): Promise<KnowledgeIndex[]> => {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    if (hasMongoCode(error, 26)) return []; // New database: collection absent.
    throw error;
  }
};

/**
 * Awaited before API traffic/readiness. Owns only the Knowledge Hub text index;
 * Mongoose must not auto-create it concurrently with this options upgrade.
 * Mongo permits one text index, so replacing its options requires drop/create.
 * No records or other indexes are modified; an unknown definition fails closed.
 */
export const ensureKnowledgeTextIndex = async (
  articles: IndexCollection | undefined = mongoose.connection.db?.collection(
    "communicationknowledgearticles",
  ),
): Promise<{ removedLegacyIndexes: string[] }> => {
  if (!articles) throw new Error("MongoDB connection is unavailable.");

  const indexes = await listIndexes(articles);
  const relevant = indexes.filter(
    (index) =>
      index.key?._fts === "text" ||
      index.name === LEGACY_KNOWLEDGE_TEXT_INDEX_NAME ||
      index.name === KNOWLEDGE_TEXT_INDEX_OPTIONS.name,
  );
  for (const index of relevant) {
    const isLegacy =
      index.name === LEGACY_KNOWLEDGE_TEXT_INDEX_NAME &&
      index.default_language === "english" &&
      index.language_override === "language" &&
      isExpectedShape(index);
    if (!isCanonical(index) && !isLegacy) {
      throw new Error(
        `Unexpected Knowledge Hub text index ${index.name ?? "(unnamed)"}; review it before replacement.`,
      );
    }
  }
  if (relevant.some(isCanonical)) return { removedLegacyIndexes: [] };

  const removedLegacyIndexes: string[] = [];
  if (
    relevant.some((index) => index.name === LEGACY_KNOWLEDGE_TEXT_INDEX_NAME)
  ) {
    try {
      // Never drop the replacement's distinct name: another API instance may
      // have completed the upgrade since this instance listed indexes.
      await articles.dropIndex(LEGACY_KNOWLEDGE_TEXT_INDEX_NAME);
      removedLegacyIndexes.push(LEGACY_KNOWLEDGE_TEXT_INDEX_NAME);
    } catch (error) {
      if (!hasMongoCode(error, 27)) throw error;
    }
  }
  await articles.createIndex(
    KNOWLEDGE_TEXT_INDEX_KEY,
    KNOWLEDGE_TEXT_INDEX_OPTIONS,
  );
  const finalIndexes = await listIndexes(articles);
  if (
    !finalIndexes.some(isCanonical) ||
    finalIndexes.some(
      (index) => index.name === LEGACY_KNOWLEDGE_TEXT_INDEX_NAME,
    )
  ) {
    throw new Error(
      "The locale-neutral Knowledge Hub text index is not ready.",
    );
  }
  return { removedLegacyIndexes };
};
