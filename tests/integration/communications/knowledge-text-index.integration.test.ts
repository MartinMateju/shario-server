import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { knowledgeArticleSchema as modelSchema } from "@/modules/communications/communications.models.js";
import { knowledgeArticleSchema as inputSchema } from "@/modules/communications/communications.validators.js";
import {
  ensureKnowledgeTextIndex,
  KNOWLEDGE_TEXT_INDEX_KEY,
  KNOWLEDGE_TEXT_INDEX_OPTIONS,
  LEGACY_KNOWLEDGE_TEXT_INDEX_NAME,
} from "@/modules/communications/knowledge-text-index.js";

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let databaseNumber = 0;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = await mongoose
    .createConnection(mongo.getUri(), { autoIndex: false })
    .asPromise();
}, 120_000);
afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});

const fixture = async (legacy = true) => {
  const db = connection.useDb(`knowledge-index-${++databaseNumber}`);
  const articles = db.db!.collection("communicationknowledgearticles");
  const Article = db.model(
    "KnowledgeIndexArticle",
    modelSchema,
    articles.collectionName,
  );
  if (legacy) await articles.createIndex(KNOWLEDGE_TEXT_INDEX_KEY);
  await articles.createIndex({ tenantId: 1, slug: 1 }, { unique: true });
  await articles.createIndex(
    { tenantId: 1, status: 1 },
    { name: "knowledge_listing" },
  );
  const tenantId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const payload = {
    type: "link",
    title: "Pravidla samostatné návštěvy",
    summary: "Příchod do ateliéru",
    content: "Samostatné návštěvy ateliéru a pravidla přípravy.",
    language: "cs",
    audience: "customer",
    status: "published",
    aiEnabled: true,
    sourceUrl: "https://www.atelierklei.cz/rady-a-navody/",
    fileUrl: "",
    videoUrl: "",
    locationIds: [],
    targetCourseIds: [],
    targetMembershipIds: [],
    targetOwnerIds: [],
  };
  const record = {
    ...inputSchema.parse(payload),
    tenantId,
    slug: "pravidla-navstevy",
    createdBy: userId,
    updatedBy: userId,
  };
  return { articles, Article, tenantId, record };
};

describe("Knowledge Hub text index startup repair", () => {
  it("reproduces Czech write failure, repairs only the index, then persists/searches published Czech knowledge", async () => {
    const { articles, Article, tenantId, record } = await fixture();
    await expect(Article.create(record)).rejects.toMatchObject({ code: 17262 });
    expect(await articles.countDocuments()).toBe(0);
    await Article.create({
      ...record,
      language: "en",
      slug: "existing-article",
    });
    const before = await articles.find({}).toArray();
    const otherIndexes = (await articles.listIndexes().toArray()).filter(
      ({ name }) => name !== LEGACY_KNOWLEDGE_TEXT_INDEX_NAME,
    );

    await expect(ensureKnowledgeTextIndex(articles)).resolves.toEqual({
      removedLegacyIndexes: [LEGACY_KNOWLEDGE_TEXT_INDEX_NAME],
    });
    expect(await articles.find({}).toArray()).toEqual(before);
    expect(
      (await articles.listIndexes().toArray()).filter(
        ({ name }) => name !== KNOWLEDGE_TEXT_INDEX_OPTIONS.name,
      ),
    ).toEqual(otherIndexes);
    const created = await Article.create(record);
    expect(created.toObject()).toMatchObject({
      language: "cs",
      status: "published",
      audience: "customer",
      aiEnabled: true,
      embeddingStatus: "pending",
    });
    await Article.create({
      ...record,
      tenantId: new mongoose.Types.ObjectId(),
    });
    const filter = {
      tenantId,
      language: "cs",
      status: "published" as const,
      deletedAt: null,
      $text: { $search: "návštěvy" },
    };
    expect(
      (await Article.find(filter).lean()).map((article) => String(article._id)),
    ).toEqual([String(created._id)]);
    expect(await Article.countDocuments(filter)).toBe(1);
    await expect(
      Article.create({ ...record, title: "Duplicate slug" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("is idempotent and supports concurrent startups without dropping the replacement", async () => {
    const { articles, Article, record } = await fixture();
    await Article.create({ ...record, language: "en" });
    const before = await articles.find({}).toArray();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => ensureKnowledgeTextIndex(articles)),
    );
    expect(results.flatMap((result) => result.removedLegacyIndexes)).toEqual([
      LEGACY_KNOWLEDGE_TEXT_INDEX_NAME,
    ]);
    const indexesBefore = await articles.listIndexes().toArray();
    const createIndex = vi.fn<typeof articles.createIndex>(articles.createIndex.bind(articles));
    const dropIndex = vi.fn<typeof articles.dropIndex>(articles.dropIndex.bind(articles));
    await expect(
      ensureKnowledgeTextIndex({
        listIndexes: articles.listIndexes.bind(articles),
        createIndex,
        dropIndex,
      }),
    ).resolves.toEqual({ removedLegacyIndexes: [] });
    expect(createIndex).not.toHaveBeenCalled();
    expect(dropIndex).not.toHaveBeenCalled();
    expect(await articles.listIndexes().toArray()).toEqual(indexesBefore);
    expect(await articles.find({}).toArray()).toEqual(before);
  });

  it.each([
    { name: "unrecognized_text_index" },
    { name: LEGACY_KNOWLEDGE_TEXT_INDEX_NAME, weights: { title: 5 } },
    {
      name: LEGACY_KNOWLEDGE_TEXT_INDEX_NAME,
      language_override: "customLanguage",
    },
    { name: KNOWLEDGE_TEXT_INDEX_OPTIONS.name, default_language: "english" },
  ])("preserves unknown index options and records: %j", async (options) => {
    const { articles, Article, record } = await fixture(false);
    await articles.createIndex(KNOWLEDGE_TEXT_INDEX_KEY, options);
    await Article.create({ ...record, language: "en" });
    const before = await articles.find({}).toArray();
    const indexesBefore = await articles.listIndexes().toArray();
    await expect(ensureKnowledgeTextIndex(articles)).rejects.toThrow(
      "Unexpected Knowledge Hub text index",
    );
    expect(await articles.listIndexes().toArray()).toEqual(indexesBefore);
    expect(await articles.find({}).toArray()).toEqual(before);
  });

  it("propagates a build failure before readiness and safely resumes the interrupted upgrade", async () => {
    const { articles, Article, record } = await fixture();
    await Article.create({ ...record, language: "en" });
    const before = await articles.find({}).toArray();
    const denied = new Error("Index creation denied");
    await expect(
      ensureKnowledgeTextIndex({
        listIndexes: articles.listIndexes.bind(articles),
        dropIndex: articles.dropIndex.bind(articles),
        createIndex: vi.fn().mockRejectedValue(denied),
      }),
    ).rejects.toBe(denied);
    expect(await articles.find({}).toArray()).toEqual(before);
    expect(
      (await articles.listIndexes().toArray()).map(({ name }) => name),
    ).toEqual(["_id_", "tenantId_1_slug_1", "knowledge_listing"]);
    await expect(ensureKnowledgeTextIndex(articles)).resolves.toEqual({
      removedLegacyIndexes: [],
    });
    await expect(
      Article.create({ ...record, slug: "new-czech" }),
    ).resolves.toMatchObject({ language: "cs" });
  });

  it("creates the index for a new database while model initialization keeps all ordinary indexes", async () => {
    const db = connection.useDb(`knowledge-index-${++databaseNumber}`);
    const articles = db.db!.collection("communicationknowledgearticles");
    await ensureKnowledgeTextIndex(articles);
    const schema = modelSchema.clone();
    schema.set("autoIndex", true);
    const Article = db.model(
      "NewKnowledgeArticle",
      schema,
      articles.collectionName,
    );
    await Article.init();
    await ensureKnowledgeTextIndex(articles);
    const indexes = await articles.listIndexes().toArray();
    expect(indexes.filter((index) => index.key._fts === "text")).toEqual([
      expect.objectContaining(KNOWLEDGE_TEXT_INDEX_OPTIONS),
    ]);
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, slug: 1 },
          unique: true,
        }),
        expect.objectContaining({
          key: { tenantId: 1, status: 1, category: 1 },
        }),
      ]),
    );
    expect(await articles.countDocuments()).toBe(0);
  });
});
