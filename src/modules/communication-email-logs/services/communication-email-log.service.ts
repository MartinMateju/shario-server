import type { CommunicationEmailLogListFilters } from "../communication-email-log.types.js";
import type { ListCommunicationEmailLogsInput } from "../communication-email-log.validators.js";
import { communicationEmailLogRepository } from "../communication-email-log.repository.js";
import type { AllowedWorkspaceLocationIds } from "@/modules/tenant-access/index.js";

export const communicationEmailLogService = {
  async list(
    tenantId: string,
    input: ListCommunicationEmailLogsInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const filters: CommunicationEmailLogListFilters = {
      tenantId,
      ...input,
      allowedLocationIds,
    };

    const [logs, totalCount] = await Promise.all([
      communicationEmailLogRepository.list(filters),
      communicationEmailLogRepository.count(filters),
    ]);

    const page = input.page;
    const limit = input.limit;
    const totalPages = Math.ceil(totalCount / limit);

    return {
      logs,
      totalCount,
      totalPages,
      currentPage: page,
      pageSize: limit,
    };
  },
};
