#!/usr/bin/env node
/**
 * Normalize the pinned Beckhoff InfoSys crawl into the committed API catalog
 * consumed by the virtual-library generator. The crawl is an input snapshot,
 * never a build-time dependency of the published package.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(
  root,
  "libs/sources/beckhoff-virtual-core/beckhoff-api-catalog.json",
);
const IEC_TYPES = new Set([
  "BOOL",
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
  "SINT",
  "USINT",
  "INT",
  "UINT",
  "DINT",
  "UDINT",
  "LINT",
  "ULINT",
  "REAL",
  "LREAL",
  "TIME",
  "LTIME",
  "DATE",
  "LDATE",
  "TIME_OF_DAY",
  "TOD",
  "LTIME_OF_DAY",
  "LTOD",
  "DATE_AND_TIME",
  "DT",
  "LDATE_AND_TIME",
  "LDT",
  "STRING",
  "WSTRING",
  "CHAR",
  "WCHAR",
  "ANY",
  "ANY_NUM",
  "ANY_INT",
  "ANY_REAL",
  "ANY_BIT",
  "ANY_STRING",
  "ANY_ELEMENTARY",
  "VOID",
]);
const COMPILER_TYPES = new Set(
  [
    "POINTER",
    "REFERENCE",
    "PVOID",
    "PBYTE",
    "PWORD",
    "PDWORD",
    "PLWORD",
    "PSINT",
    "PUSINT",
    "PINT",
    "PUINT",
    "PDINT",
    "PUDINT",
    "PLINT",
    "PULINT",
    "PREAL",
    "PLREAL",
    "PBOOL",
    "T_MAXSTRING",
    "T_Arg",
  ].map((name) => name.toUpperCase()),
);

function repairMojibake(text) {
  return text
    .replace(/(?:Ã.|Â.|â..)+/g, (fragment) =>
      Buffer.from(fragment, "latin1").toString("utf8"),
    )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\r\n/g, "\n");
}

function normalizeDeclaration(block) {
  return repairMojibake(block)
    .replace(/\\_/g, "_")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?([:;,]) ?/g, "$1 ")
    .replace(/:\s*=/g, " :=")
    .replace(/ +\n/g, "\n")
    .trim();
}

function section(markdown, name) {
  const normalized = repairMojibake(markdown);
  const match = normalized.match(
    new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im"),
  );
  return match?.[1] ?? "";
}

function cleanMarkdownCell(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(markdownSection) {
  const lines = markdownSection
    .split("\n")
    .filter((line) => /^\s*\|/.test(line));
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map(cleanMarkdownCell),
  );
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => /^name$/i.test(cell)),
  );
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map((cell) => cell.toLowerCase());
  return rows
    .slice(headerIndex + 1)
    .filter((row) => !row.every((cell) => /^-+$/.test(cell) || cell === ""))
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header, row[index] ?? ""]),
      ),
    )
    .filter((row) => row.name && row.type);
}

function inferPropertyType(name) {
  if (/^b[A-Z_]/.test(name)) return "BOOL";
  if (/^s[A-Z_]/.test(name)) return "STRING";
  if (/^(?:f|lr)[A-Z_]/.test(name)) return "LREAL";
  return "UDINT";
}

function extractApiTables(markdown) {
  const inputs = tableRows(section(markdown, "Inputs"));
  const outputs = tableRows(section(markdown, "Outputs"));
  const inouts = tableRows(section(markdown, "Inouts?|Input/output variables"));
  const propertySection = section(markdown, "Properties");
  const properties = tableRows(propertySection).map((row) => ({
    name: row.name,
    type: row.type,
    access: row.access || "Get",
  }));
  for (const match of propertySection.matchAll(/^\*\*([^*]+)\*\*\s*:/gm)) {
    if (
      !properties.some(
        (property) => property.name.toUpperCase() === match[1].toUpperCase(),
      )
    ) {
      properties.push({
        name: match[1],
        type: inferPropertyType(match[1]),
        access: "Get",
      });
    }
  }
  return { inputs, outputs, inouts, properties };
}

function referencedTypesFromApi(api) {
  const result = new Set();
  for (const row of [
    ...api.inputs,
    ...api.outputs,
    ...api.inouts,
    ...api.properties,
  ]) {
    let type = row.type
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[\\*`]/g, "")
      .replace(/^(?:POINTER|REFERENCE)\s+TO\s+/i, "")
      .trim();
    const arrayElement = type.match(/\bOF\s+([A-Za-z_]\w*)/i)?.[1];
    if (arrayElement) type = arrayElement;
    const name = type.match(/^([A-Za-z_]\w*)/)?.[1];
    if (name && name.toUpperCase() !== "ARRAY") result.add(name);
  }
  return [...result];
}

function declarationsFromMarkdown(markdown) {
  const declarations = [];
  for (const match of repairMojibake(markdown).matchAll(
    /```(?:st|iecst)?\s*\n([\s\S]*?)```/gi,
  )) {
    const value = normalizeDeclaration(match[1]);
    if (
      /\b(?:VAR_(?:INPUT|OUTPUT|IN_OUT|GLOBAL|STAT|TEMP)|METHOD|FUNCTION(?:_BLOCK)?|TYPE|STRUCT|INTERFACE)\b/i.test(
        value,
      )
    ) {
      declarations.push(value);
    }
  }
  return [...new Set(declarations)];
}

function referencedTypes(declarations) {
  const types = new Set();
  for (const declaration of declarations) {
    for (const line of declaration.split("\n")) {
      const declarationLine =
        /;\s*$/.test(line) ||
        /^\s*(?:METHOD|FUNCTION(?:_BLOCK)?|TYPE|INTERFACE)\b/i.test(line);
      if (!declarationLine) continue;
      for (const match of line.matchAll(
        /:\s*(?:POINTER\s+TO\s+|REFERENCE\s+TO\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi,
      )) {
        types.add(match[1]);
      }
      for (const match of line.matchAll(/\bOF\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        types.add(match[1]);
      }
      for (const match of line.matchAll(
        /\b(?:EXTENDS|IMPLEMENTS)\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
      )) {
        types.add(match[1]);
      }
    }
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

function flattenIndex(index) {
  const pages = [];
  for (const [domain, domainEntry] of Object.entries(index.domains)) {
    for (const [library, libraryPages] of Object.entries(
      domainEntry.libraries,
    )) {
      for (const page of libraryPages) pages.push({ ...page, domain, library });
    }
  }
  return pages;
}

function dispositionFor(page, duplicate) {
  if (duplicate) return "duplicate";
  if (page.kinds.includes("topic")) return "topic-only";
  if (page.library === "Tc2_Standard") return "existing-equivalent";
  if (page.library.startsWith("TwinCAT_")) return "compiler-feature";
  return "new-library-symbol";
}

export function generateBeckhoffCatalog(docsPath, outputPath = DEFAULT_OUTPUT) {
  const indexPath = resolve(docsPath, "index.json");
  if (!existsSync(indexPath))
    throw new Error(`Beckhoff index not found: ${indexPath}`);
  const rawIndex = readFileSync(indexPath);
  const index = JSON.parse(rawIndex.toString("utf8"));
  const indexedPages = flattenIndex(index);
  const documentedNames = new Set(
    indexedPages
      .flatMap((page) => page.symbols)
      .map((name) => name.split(".").at(-1).toUpperCase()),
  );
  const seen = new Map();
  const pages = indexedPages.map((page, indexPosition) => {
    const markdownPath = resolve(docsPath, page._md_path);
    if (!existsSync(markdownPath))
      throw new Error(`Indexed page is missing: ${page._md_path}`);
    const markdown = readFileSync(markdownPath, "utf8");
    const declarations = declarationsFromMarkdown(markdown);
    const api = extractApiTables(markdown);
    const identity =
      `${page.library}|${page.kinds.join(",")}|${page.symbols.join(",")}`.toUpperCase();
    const duplicateOf = seen.get(identity);
    const pageId = `${String(indexPosition + 1).padStart(4, "0")}:${page.library}:${page.symbols.join("+")}`;
    if (!duplicateOf) seen.set(identity, pageId);
    return {
      pageId,
      library: page.library,
      domain: page.domain,
      symbols: page.symbols,
      kinds: page.kinds,
      priorityTier: page.priority_tier,
      source: page.source_html_url,
      markdownPath: page._md_path.replaceAll("\\", "/"),
      disposition: dispositionFor(page, duplicateOf),
      ...(duplicateOf ? { duplicateOf } : {}),
      declarations,
      referencedTypes: [
        ...new Set([
          ...referencedTypes(declarations),
          ...referencedTypesFromApi(api),
        ]),
      ].sort((a, b) => a.localeCompare(b)),
      api,
    };
  });

  const allReferences = new Set(pages.flatMap((page) => page.referencedTypes));
  const supportTypes = [...allReferences]
    .map((name) => {
      const upper = name.toUpperCase();
      if (IEC_TYPES.has(upper) || COMPILER_TYPES.has(upper)) {
        return { name, disposition: "compiler-feature" };
      }
      if (documentedNames.has(upper)) {
        return { name, disposition: "new-library-symbol" };
      }
      return { name, disposition: "new-library-symbol", synthesized: true };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const allowed = new Set([
    "new-library-symbol",
    "existing-equivalent",
    "compiler-feature",
    "duplicate",
    "topic-only",
  ]);
  const unclassifiedPages = pages.filter(
    (page) => !allowed.has(page.disposition),
  );
  const unclassifiedTypes = supportTypes.filter(
    (type) => !allowed.has(type.disposition),
  );
  if (
    pages.length !== index.stats.total_pages ||
    unclassifiedPages.length ||
    unclassifiedTypes.length
  ) {
    throw new Error(
      `Incomplete Beckhoff catalog: ${pages.length}/${index.stats.total_pages} pages, ` +
        `${unclassifiedPages.length} unclassified pages, ${unclassifiedTypes.length} unclassified types`,
    );
  }

  const libraryNames = [...new Set(pages.map((page) => page.library))].sort();
  const catalog = {
    schemaVersion: 1,
    profile: "beckhoff-virtual-v1",
    sourceSnapshot: {
      name: index.name,
      schemaVersion: index.schema_version,
      generatedAt: index.generated_at,
      indexSha256: createHash("sha256").update(rawIndex).digest("hex"),
    },
    coverage: {
      indexedPages: pages.length,
      libraryIdentities: libraryNames.length,
      dispositionCounts: Object.fromEntries(
        [...allowed].map((value) => [
          value,
          pages.filter((page) => page.disposition === value).length,
        ]),
      ),
      supportTypeCount: supportTypes.length,
    },
    libraries: libraryNames,
    pages,
    supportTypes,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalog;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const docsPath = process.argv[2];
  if (!docsPath) {
    console.error(
      "Usage: node scripts/generate-beckhoff-catalog.mjs <beckhoff_docs> [output]",
    );
    process.exit(2);
  }
  const catalog = generateBeckhoffCatalog(
    resolve(docsPath),
    process.argv[3] && resolve(process.argv[3]),
  );
  console.log(
    `[beckhoff-catalog] ${catalog.coverage.indexedPages} pages, ` +
      `${catalog.coverage.libraryIdentities} libraries, ${catalog.coverage.supportTypeCount} referenced types`,
  );
}
