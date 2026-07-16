// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  parseLibraryProfile,
  validateLibraryProfileArchives,
  type LoadedLibraryProfile,
} from "../library/library-profile.js";
import { findBundledLibsDir } from "./build-utils.js";
import { loadStlibFromFile } from "./library-loader.js";

export function loadLibraryProfile(
  profileNameOrPath: string,
  librariesDirectory?: string,
): LoadedLibraryProfile {
  const libsDir = librariesDirectory ?? findBundledLibsDir();
  if (!libsDir) throw new Error("Cannot locate bundled STruCPP libraries");
  const profilePath = isAbsolute(profileNameOrPath)
    ? profileNameOrPath
    : resolve(libsDir, "profiles", `${profileNameOrPath}.json`);
  let raw: string;
  try {
    raw = readFileSync(profilePath, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read library profile ${profileNameOrPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseLibraryProfile(JSON.parse(raw), profilePath);
  const archives = manifest.libraries.map((entry) => {
    const path = resolve(libsDir, entry.path);
    const archive = loadStlibFromFile(path);
    if (archive.manifest.name !== entry.name) {
      throw new Error(
        `${profilePath}: ${entry.path} contains ${archive.manifest.name}, expected ${entry.name}`,
      );
    }
    return archive;
  });
  validateLibraryProfileArchives(manifest, archives);
  return { manifest, archives };
}
