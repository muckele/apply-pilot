export type JobDiscoveryPreferences = {
  targetSearches: string[];
  location: string;
  limitPerQuery: number;
  remoteOnly: boolean;
  scoreImported: boolean;
};

type SavedDiscoveryPreference =
  | JobDiscoveryPreferences
  | null
  | undefined;

type DiscoveryProfile =
  | {
      preferredRoles?: string[] | null;
      preferredLocations?: string[] | null;
      location?: string | null;
    }
  | null
  | undefined;

function normalizeStrings(values?: readonly string[] | null) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
}

export function resolveInitialJobDiscoveryPreferences({
  savedPreference,
  profile
}: {
  savedPreference: SavedDiscoveryPreference;
  profile: DiscoveryProfile;
}): JobDiscoveryPreferences {
  if (savedPreference) {
    return {
      targetSearches: normalizeStrings(
        savedPreference.targetSearches
      ).slice(0, 16),
      location: savedPreference.location.trim(),
      limitPerQuery: savedPreference.limitPerQuery,
      remoteOnly: savedPreference.remoteOnly,
      scoreImported: savedPreference.scoreImported
    };
  }

  const preferredRoles = normalizeStrings(
    profile?.preferredRoles
  ).slice(0, 16);

  const preferredLocations = normalizeStrings(
    profile?.preferredLocations
  );

  return {
    targetSearches: preferredRoles,
    location:
      preferredLocations[0] ??
      profile?.location?.trim() ??
      "",
    limitPerQuery: 8,
    remoteOnly: false,
    scoreImported: false
  };
}

export function resolveDiscoveryQueries({
  suppliedQueries,
  savedPreference,
  profilePreferredRoles
}: {
  suppliedQueries?: string[];
  savedPreference?:
    | Pick<JobDiscoveryPreferences, "targetSearches">
    | null;
  profilePreferredRoles?: string[] | null;
}) {
  if (suppliedQueries !== undefined) {
    return normalizeStrings(suppliedQueries).slice(0, 16);
  }

  if (savedPreference) {
    return normalizeStrings(
      savedPreference.targetSearches
    ).slice(0, 16);
  }

  return normalizeStrings(profilePreferredRoles).slice(0, 16);
}

export function resolveDiscoveryLocation({
  suppliedLocation,
  savedPreference,
  profile
}: {
  suppliedLocation?: string;
  savedPreference?:
    | Pick<JobDiscoveryPreferences, "location">
    | null;
  profile: DiscoveryProfile;
}) {
  if (suppliedLocation !== undefined) {
    return suppliedLocation.trim();
  }

  if (savedPreference) {
    return savedPreference.location.trim();
  }

  const preferredLocations = normalizeStrings(
    profile?.preferredLocations
  );

  return (
    preferredLocations[0] ??
    profile?.location?.trim() ??
    ""
  );
}
