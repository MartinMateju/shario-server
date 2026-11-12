import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { AI_FEATURE, AI_FEEDBACK_RATING } from "@/modules/ai/ai.constants.js";
import {
  AiConversationModel,
  AiFeedbackModel,
  AiMessageModel,
  AiRunModel,
} from "@/modules/ai/ai.models.js";
import {
  buildFeedbackRegressionReport,
  type FeedbackRegressionObservation,
} from "@/modules/ai/services/feedback-regression.service.js";

const argumentValue = (name: string): string => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(
    prefix.length,
  ) || "";
};

const integerArgument = ({
  name,
  defaultValue,
  minimum,
  maximum,
}: {
  name: string;
  defaultValue: number;
  minimum: number;
  maximum: number;
}): number => {
  const raw = argumentValue(name);
  const value = raw ? Number(raw) : defaultValue;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
};

const tenantId = argumentValue("tenant");
if (!mongoose.isValidObjectId(tenantId)) {
  throw new Error("A valid --tenant=<tenant-object-id> is required.");
}

const days = integerArgument({
  name: "days",
  defaultValue: 30,
  minimum: 1,
  maximum: 365,
});
const minimumOccurrences = integerArgument({
  name: "min-occurrences",
  defaultValue: 2,
  minimum: 2,
  maximum: 100,
});
const maximumFeedback = integerArgument({
  name: "max-feedback",
  defaultValue: 5_000,
  minimum: 2,
  maximum: 20_000,
});
const includeRedactedText = process.argv.includes("--include-redacted-text");
const outputArgument = argumentValue("output") ||
  ".ai-evals/feedback-regressions.json";
const reportRoot = resolve(process.cwd(), ".ai-evals");
const outputPath = resolve(process.cwd(), outputArgument);
const relativeOutput = relative(reportRoot, outputPath);
if (
  relativeOutput.startsWith("..") ||
  relativeOutput === "" ||
  relativeOutput.startsWith("/")
) {
  throw new Error("--output must be a file below the local .ai-evals directory.");
}

const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);

type LeanDocument = Record<string, any>;

const run = async (): Promise<void> => {
  await connectDB();

  // Read-only by design: no update, delete, insert or model save is permitted
  // in this workflow. The mandatory tenant predicate is repeated in every
  // collection query rather than relying only on ids from an earlier query.
  const feedbackRows = (await AiFeedbackModel.find({
    tenant: tenantObjectId,
    rating: AI_FEEDBACK_RATING.NOT_HELPFUL,
    run: { $type: "objectId" },
    createdAt: { $gte: since },
  })
    .select("run createdAt")
    .sort({ createdAt: -1 })
    .limit(maximumFeedback)
    .lean()) as LeanDocument[];

  const feedbackByRun = new Map<string, LeanDocument>();
  for (const feedback of feedbackRows) {
    const runId = String(feedback.run || "");
    if (runId && !feedbackByRun.has(runId)) feedbackByRun.set(runId, feedback);
  }
  const runObjectIds = [...feedbackByRun.keys()].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const runs = runObjectIds.length
    ? ((await AiRunModel.find({
        _id: { $in: runObjectIds },
        tenant: tenantObjectId,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
      })
        .select("_id promptVersion provider model")
        .lean()) as LeanDocument[])
    : [];
  const runById = new Map(runs.map((item) => [String(item._id), item]));
  const eligibleRunIds = runs.map((item) => item._id);

  const assistantTurns = eligibleRunIds.length
    ? ((await AiMessageModel.aggregate([
        {
          $match: {
            tenant: tenantObjectId,
            role: "assistant",
            run: { $in: eligibleRunIds },
          },
        },
        {
          $lookup: {
            from: AiMessageModel.collection.name,
            let: {
              conversationId: "$conversation",
              assistantCreatedAt: "$createdAt",
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$tenant", tenantObjectId] },
                      { $eq: ["$conversation", "$$conversationId"] },
                      { $eq: ["$role", "user"] },
                      { $lte: ["$createdAt", "$$assistantCreatedAt"] },
                    ],
                  },
                },
              },
              { $sort: { createdAt: -1, _id: -1 } },
              { $limit: 1 },
              { $project: { content: 1 } },
            ],
            as: "precedingUserTurns",
          },
        },
        { $unwind: "$precedingUserTurns" },
        {
          $project: {
            run: 1,
            conversation: 1,
            content: 1,
            grounding: 1,
            provider: 1,
            model: 1,
            createdAt: 1,
            prompt: "$precedingUserTurns.content",
          },
        },
      ])) as LeanDocument[])
    : [];

  const conversationIds = [
    ...new Set(assistantTurns.map((item) => String(item.conversation || ""))),
  ]
    .filter(mongoose.isValidObjectId)
    .map((id) => new mongoose.Types.ObjectId(id));
  const conversations = conversationIds.length
    ? ((await AiConversationModel.find({
        _id: { $in: conversationIds },
        tenant: tenantObjectId,
      })
        .select("_id locale")
        .lean()) as LeanDocument[])
    : [];
  const localeByConversation = new Map(
    conversations.map((item) => [String(item._id), String(item.locale || "en")]),
  );

  const observations: FeedbackRegressionObservation[] = assistantTurns.flatMap(
    (message) => {
      const runId = String(message.run || "");
      const feedback = feedbackByRun.get(runId);
      const aiRun = runById.get(runId);
      const prompt = String(message.prompt || "").trim();
      if (!feedback || !aiRun || !prompt) return [];
      return [
        {
          tenantId,
          locale:
            localeByConversation.get(String(message.conversation || "")) ||
            "en",
          prompt,
          answer: String(message.content || ""),
          createdAt: feedback.createdAt,
          promptVersion: String(aiRun.promptVersion || ""),
          model: String(message.model || aiRun.model || ""),
          provider: String(message.provider || aiRun.provider || ""),
          groundingStatus: String(message.grounding?.status || ""),
        },
      ];
    },
  );

  const report = buildFeedbackRegressionReport({
    tenantId,
    observations,
    minimumOccurrences,
    includeRedactedText,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log(
    JSON.stringify({
      output: relative(process.cwd(), outputPath),
      lookbackDays: days,
      inspectedNegativeFeedback: feedbackRows.length,
      eligibleAssistantTurns: observations.length,
      repeatedCandidates: report.candidates.length,
      includesRedactedText: includeRedactedText,
    }),
  );
};

try {
  await run();
} catch (error) {
  console.error("AI feedback regression export failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
