import { WORKSPACE_ROLE, type WorkspaceRole } from "@/modules/tenant-access/index.js";

type ConversationVisibilityInput = {
  tenantId: string;
  userId: string;
  role?: WorkspaceRole | null;
  allowedLocationIds?: readonly string[] | null;
  view?: "all" | "mine" | "unassigned" | "needs_review" | "unmatched" | "urgent" | "closed";
  includeRestricted?: boolean;
};

const idString = (value: unknown): string => String(value ?? "").trim();

export const isWorkspaceWideCommunicationAccess = (
  role: WorkspaceRole | null | undefined,
): boolean => role === WORKSPACE_ROLE.OWNER || role === WORKSPACE_ROLE.ADMIN;

export const canViewRestrictedConversation = ({
  conversation,
  userId,
  role,
}: {
  conversation: {
    restricted?: boolean;
    assignedTo?: unknown;
    allowedUserIds?: readonly unknown[];
    createdBy?: unknown;
  };
  userId: string;
  role?: WorkspaceRole | null;
}): boolean => {
  if (!conversation.restricted || isWorkspaceWideCommunicationAccess(role)) {
    return true;
  }

  const allowed = new Set(
    (conversation.allowedUserIds ?? []).map(idString).filter(Boolean),
  );

  return (
    allowed.has(userId) ||
    idString(conversation.assignedTo) === userId ||
    idString(conversation.createdBy) === userId
  );
};

/**
 * Builds the mandatory Mongo visibility boundary for the Inbox. Assignment is
 * intentionally separate from visibility: owners/admins always retain the
 * tenant-wide `All conversations` view, while other roles are restricted by
 * their workspace location grants and restricted-conversation ACLs.
 */
export const buildConversationVisibilityFilter = ({
  tenantId,
  userId,
  role,
  allowedLocationIds = null,
  view = "all",
  includeRestricted = true,
}: ConversationVisibilityInput): Record<string, unknown> => {
  const clauses: Record<string, unknown>[] = [
    { tenantId, deletedAt: null },
  ];
  const wideAccess = isWorkspaceWideCommunicationAccess(role);

  if (!wideAccess && allowedLocationIds !== null) {
    clauses.push({
      $or: [
        { locationId: { $in: [...allowedLocationIds] } },
        { locationId: null, assignedTo: userId },
        { locationId: null, allowedUserIds: userId },
      ],
    });
  }

  if (!wideAccess && includeRestricted) {
    clauses.push({
      $or: [
        { restricted: false },
        { assignedTo: userId },
        { allowedUserIds: userId },
        { createdBy: userId },
      ],
    });
  } else if (!includeRestricted) {
    clauses.push({ restricted: false });
  }

  if (view === "mine") clauses.push({ assignedTo: userId });
  if (view === "unassigned") clauses.push({ assignedTo: null });
  if (view === "needs_review") clauses.push({ "ai.status": "needs_review" });
  if (view === "unmatched") clauses.push({ "customerMatch.status": "unmatched" });
  if (view === "urgent") clauses.push({ priority: "urgent", status: { $ne: "closed" } });
  if (view === "closed") clauses.push({ status: "closed" });

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

