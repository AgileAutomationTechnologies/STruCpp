// SPDX-License-Identifier: GPL-3.0-or-later
import type { StlibArchive } from "./library-manifest.js";

export interface LibraryProfileEntry {
  name: string;
  path: string;
}

export interface LibraryProfileManifest {
  schemaVersion: 1;
  name: string;
  runtimeProfile?: string;
  coverageCatalog?: string;
  excludedLibraries: string[];
  libraries: LibraryProfileEntry[];
}

export interface LoadedLibraryProfile {
  manifest: LibraryProfileManifest;
  archives: StlibArchive[];
}

export function parseLibraryProfile(
  input: unknown,
  sourceLabel = "library profile",
): LibraryProfileManifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${sourceLabel}: expected an object`);
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error(`${sourceLabel}: schemaVersion must be 1`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`${sourceLabel}: name must be a non-empty string`);
  }
  if (
    !Array.isArray(value.libraries) ||
    !Array.isArray(value.excludedLibraries)
  ) {
    throw new Error(
      `${sourceLabel}: libraries and excludedLibraries must be arrays`,
    );
  }
  const libraries = value.libraries.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).name !== "string" ||
      typeof (entry as Record<string, unknown>).path !== "string"
    ) {
      throw new Error(
        `${sourceLabel}: libraries[${index}] must contain name and path`,
      );
    }
    const objectEntry = entry as Record<string, unknown>;
    return {
      name: objectEntry.name as string,
      path: objectEntry.path as string,
    };
  });
  return {
    schemaVersion: 1,
    name: value.name,
    ...(typeof value.runtimeProfile === "string"
      ? { runtimeProfile: value.runtimeProfile }
      : {}),
    ...(typeof value.coverageCatalog === "string"
      ? { coverageCatalog: value.coverageCatalog }
      : {}),
    excludedLibraries: value.excludedLibraries.map(String),
    libraries,
  };
}

/** Validate locked ordering, dependencies and profile-wide symbol ownership. */
export function validateLibraryProfileArchives(
  profile: LibraryProfileManifest,
  archives: StlibArchive[],
): void {
  if (archives.length !== profile.libraries.length) {
    throw new Error(
      `Library profile ${profile.name}: expected ${profile.libraries.length} archives, got ${archives.length}`,
    );
  }
  const loaded = new Set<string>();
  const symbolOwners = new Map<string, string>();
  const excluded = new Set(
    profile.excludedLibraries.map((name) => name.toUpperCase()),
  );
  for (let index = 0; index < archives.length; index++) {
    const archive = archives[index]!;
    const expected = profile.libraries[index]!.name;
    if (archive.manifest.name !== expected) {
      throw new Error(
        `Library profile ${profile.name}: expected ${expected} at position ${index}, got ${archive.manifest.name}`,
      );
    }
    if (excluded.has(archive.manifest.name.toUpperCase())) {
      throw new Error(
        `Library profile ${profile.name}: excluded library ${archive.manifest.name} is present`,
      );
    }
    for (const dependency of archive.dependencies) {
      if (!loaded.has(dependency.name.toUpperCase())) {
        throw new Error(
          `Library profile ${profile.name}: ${archive.manifest.name} dependency ${dependency.name} is unresolved or ordered after its consumer`,
        );
      }
    }
    const symbols = [
      ...archive.manifest.functions.map((entry) => entry.name),
      ...archive.manifest.functionBlocks.map((entry) => entry.name),
      ...(archive.manifest.interfaces ?? []).map((entry) => entry.name),
      ...archive.manifest.types.map((entry) => entry.name),
      ...(archive.manifest.globals ?? []).map((entry) => entry.name),
    ];
    for (const symbol of symbols) {
      const key = symbol.toUpperCase();
      const previous = symbolOwners.get(key);
      if (previous) {
        throw new Error(
          `Library profile ${profile.name}: duplicate symbol ${symbol} in ${previous} and ${archive.manifest.name}`,
        );
      }
      symbolOwners.set(key, archive.manifest.name);
    }
    loaded.add(archive.manifest.name.toUpperCase());
  }
}
