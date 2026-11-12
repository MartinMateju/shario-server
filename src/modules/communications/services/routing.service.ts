export type RoutingContext = {
  category?: string;
  channel?: string;
  priority?: string;
  language?: string;
  locationId?: string | null;
  text?: string;
  unmatched?: boolean;
  outsideBusinessHours?: boolean;
};

export type RoutingRule = {
  _id?: unknown;
  id?: unknown;
  enabled?: boolean;
  order?: number;
  matchOperator?: "all" | "any";
  conditions?: {
    categories?: readonly string[];
    channels?: readonly string[];
    priorities?: readonly string[];
    languages?: readonly string[];
    locationIds?: readonly unknown[];
    keywords?: readonly string[];
    unmatchedOnly?: boolean;
    outsideBusinessHours?: boolean;
  };
  action?: {
    assignTo?: unknown;
    assignTeam?: string;
    locationId?: unknown;
    priority?: string | null;
    addTags?: readonly string[];
    notifyOwner?: boolean;
  };
};

export type RoutingDecision = {
  matchedRuleId: string;
  assignedTo: string | null;
  assignedTeam: string;
  locationId: string | null;
  priority: string | null;
  tags: string[];
  notifyOwner: boolean;
};

const valuesInclude = (values: readonly unknown[] | undefined, value: unknown) =>
  !values?.length || values.map(String).includes(String(value ?? ""));

const ruleMatches = (context: RoutingContext, rule: RoutingRule): boolean => {
  if (rule.enabled === false) return false;
  const conditions = rule.conditions ?? {};
  const checks: boolean[] = [];

  if (conditions.categories?.length) checks.push(valuesInclude(conditions.categories, context.category));
  if (conditions.channels?.length) checks.push(valuesInclude(conditions.channels, context.channel));
  if (conditions.priorities?.length) checks.push(valuesInclude(conditions.priorities, context.priority));
  if (conditions.languages?.length) checks.push(valuesInclude(conditions.languages, context.language));
  if (conditions.locationIds?.length) checks.push(valuesInclude(conditions.locationIds, context.locationId));
  if (conditions.unmatchedOnly) checks.push(context.unmatched === true);
  if (conditions.outsideBusinessHours) checks.push(context.outsideBusinessHours === true);
  if (conditions.keywords?.length) {
    const text = String(context.text ?? "").toLocaleLowerCase();
    checks.push(
      conditions.keywords.some((keyword) =>
        text.includes(String(keyword).trim().toLocaleLowerCase()),
      ),
    );
  }

  if (!checks.length) return true;
  return rule.matchOperator === "any" ? checks.some(Boolean) : checks.every(Boolean);
};

export const routeConversation = (
  context: RoutingContext,
  rules: readonly RoutingRule[],
): RoutingDecision | null => {
  const rule = [...rules]
    .sort((left, right) => Number(left.order ?? 100) - Number(right.order ?? 100))
    .find((candidate) => ruleMatches(context, candidate));
  if (!rule) return null;
  const action = rule.action ?? {};
  return {
    matchedRuleId: String(rule._id ?? rule.id ?? ""),
    assignedTo: action.assignTo ? String(action.assignTo) : null,
    assignedTeam: String(action.assignTeam ?? ""),
    locationId: action.locationId ? String(action.locationId) : null,
    priority: action.priority ? String(action.priority) : null,
    tags: [...new Set((action.addTags ?? []).map(String).filter(Boolean))],
    notifyOwner: action.notifyOwner === true,
  };
};

export const selectRoutingRule = routeConversation;

