/** Eligibility of a purchased membership, not the locations where it is sold. */
export const membershipAllowsLocation = (
  membership: any,
  locationId?: string | null,
): boolean => {
  const scope = membership?.planSnapshot?.locationScope;
  if (!scope || scope.type === "all") return true;
  if (!locationId) return false;
  if (scope.type === "shared_selected") {
    return (scope.locationIds ?? []).some((id: unknown) => String(id) === String(locationId));
  }
  if (scope.type === "selected") {
    return String(membership.selectedLocation ?? "") === String(locationId);
  }
  return false;
};
