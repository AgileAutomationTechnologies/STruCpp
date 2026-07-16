#!/usr/bin/env node
/** Generate deterministic Beckhoff virtual .stlib v2 archives from the catalog. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(
  root,
  "libs/sources/beckhoff-virtual-core/beckhoff-api-catalog.json",
);
const libsDir = resolve(root, "libs");
const beckhoffLibsDir = resolve(libsDir, "beckhoff-virtual");
const profilePath = resolve(root, "libs/profiles/beckhoff-virtual.json");
const simulationCatalogPath = resolve(
  root,
  "libs/sources/beckhoff-virtual-core/beckhoff-simulation-catalog.json",
);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const ELEMENTARY = new Set([
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
]);
const RUNTIME_CAPABILITIES = [
  "beckhoff-virtual-v1",
  "virtual-clock",
  "sandbox-files",
  "ads-symbols",
  "motion-axes",
  "fieldbus-registers",
  "message-endpoints",
  "opcua-nodes",
  "database-tables",
  "diagnostics",
  "fault-injection",
  "beckhoffVirtualTransparentExecutionV1",
];

function libraryId(name) {
  return `beckhoff-${name.toLowerCase().replaceAll("_", "-")}`;
}

function cleanType(raw = "UDINT") {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\\*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseType(rawType, initialValue) {
  let raw = cleanType(rawType).replace(/;.*$/, "").trim();
  let referenceKind;
  const reference = raw.match(/^(POINTER\s+TO|REFERENCE\s+TO|REF_TO)\s+(.+)$/i);
  if (reference) {
    referenceKind = reference[1].toUpperCase().startsWith("POINTER")
      ? "pointer_to"
      : reference[1].toUpperCase() === "REF_TO"
        ? "ref_to"
        : "reference_to";
    raw = reference[2].trim();
  }
  const array = raw.match(/^ARRAY\s*\[([^\]]+)\]\s*OF\s+(.+)$/i);
  if (array) {
    const element = parseType(array[2]);
    const dimensions = array[1].split(",").map((dimension) => {
      const [start, end] = dimension
        .split("..")
        .map((value) => Number.parseInt(value.trim(), 10));
      return {
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : 0,
      };
    });
    return {
      type: `__INLINE_ARRAY_${element.type}`,
      arrayDimensions: dimensions,
      elementTypeName: element.type,
      ...(referenceKind ? { referenceKind } : {}),
      ...(initialValue ? { initialValue } : {}),
    };
  }
  const stringType = raw.match(/^(W?STRING)(?:\(([^)]+)\))?$/i);
  let maxLength;
  if (stringType) {
    raw = stringType[1].toUpperCase();
    if (stringType[2]) {
      const numericLength = Number.parseInt(stringType[2], 10);
      maxLength = Number.isFinite(numericLength)
        ? numericLength
        : stringType[2].trim();
    }
  }
  raw = raw
    .replace(/^CONSTANT\s+/i, "")
    .replace(/\s+AT\s+.+$/i, "")
    .trim();
  if (/^(?:VAR_|END_|METHOD|FUNCTION|STRUCT|INTERFACE)/i.test(raw))
    raw = "UDINT";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) raw = "UDINT";
  return {
    type: raw || "UDINT",
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(referenceKind ? { referenceKind } : {}),
    ...(initialValue ? { initialValue } : {}),
  };
}

function parseVariables(text, direction) {
  const variables = [];
  for (const statement of text.split(";")) {
    const line = statement
      .replace(/\/\/.*$/gm, " ")
      .replace(/\{[^}]*\}/g, " ")
      .trim();
    const match = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([\s\S]+)$/,
    );
    if (!match) continue;
    const defaultSplit = match[2].split(/\s*:=\s*/, 2);
    for (const name of match[1].split(",").map((value) => value.trim())) {
      variables.push({
        name,
        ...parseType(defaultSplit[0], defaultSplit[1]),
        ...(direction ? { direction } : {}),
      });
    }
  }
  return variables;
}

function parseVarBlocks(declarations) {
  const result = { inputs: [], outputs: [], inouts: [] };
  for (const declaration of declarations) {
    for (const match of declaration.matchAll(
      /VAR_(INPUT|OUTPUT|IN_OUT)\b([\s\S]*?)END_VAR/gi,
    )) {
      const key =
        match[1].toUpperCase() === "INPUT"
          ? "inputs"
          : match[1].toUpperCase() === "OUTPUT"
            ? "outputs"
            : "inouts";
      const direction =
        key === "inputs" ? "input" : key === "outputs" ? "output" : "inout";
      result[key].push(...parseVariables(match[2], direction));
    }
  }
  return result;
}

function tableVariables(rows, direction) {
  return rows
    .map((row) => ({
      name: row.name.replace(/[^A-Za-z0-9_]/g, ""),
      ...parseType(row.type),
      direction,
    }))
    .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name));
}

function mergeVariables(primary, fallback) {
  const result = [...primary];
  const names = new Set(primary.map((value) => value.name.toUpperCase()));
  for (const value of fallback) {
    if (!names.has(value.name.toUpperCase())) result.push(value);
  }
  return result;
}

function parseMethod(declaration, fallbackName) {
  const header = declaration.match(
    /\bMETHOD(?:\s+(?:PUBLIC|PRIVATE|PROTECTED))?\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?/i,
  );
  if (!header) return undefined;
  const blocks = parseVarBlocks([declaration]);
  return {
    name: header[1] || fallbackName,
    ...(header[2] ? { returnType: header[2] } : {}),
    parameters: [...blocks.inputs, ...blocks.outputs, ...blocks.inouts],
    visibility: "PUBLIC",
    isAbstract: false,
    isFinal: false,
    isOverride: false,
  };
}

function addUniqueByName(values, value) {
  const existing = values.find(
    (candidate) => candidate.name.toUpperCase() === value.name.toUpperCase(),
  );
  if (!existing) values.push(value);
  return existing ?? value;
}

function collectApis(library) {
  const pages = catalog.pages.filter(
    (page) =>
      page.library === library &&
      ![
        "duplicate",
        "topic-only",
        "compiler-feature",
        "existing-equivalent",
      ].includes(page.disposition),
  );
  const fbs = [];
  const functions = [];
  function getFb(name) {
    return addUniqueByName(fbs, {
      name,
      inputs: [],
      outputs: [],
      inouts: [],
      methods: [],
      properties: [],
      isAbstract: false,
      isFinal: false,
    });
  }
  for (const page of pages) {
    if (page.kinds.includes("function_block")) {
      const fb = getFb(page.symbols[0]);
      const blocks = parseVarBlocks(
        page.declarations.filter(
          (declaration) => !/\bMETHOD\b/i.test(declaration),
        ),
      );
      fb.inputs = mergeVariables(
        fb.inputs,
        blocks.inputs.length > 0
          ? blocks.inputs
          : tableVariables(page.api.inputs, "input"),
      );
      fb.outputs = mergeVariables(
        fb.outputs,
        blocks.outputs.length > 0
          ? blocks.outputs
          : tableVariables(page.api.outputs, "output"),
      );
      fb.inouts = mergeVariables(
        fb.inouts,
        blocks.inouts.length > 0
          ? blocks.inouts
          : tableVariables(page.api.inouts, "inout"),
      );
      for (const property of page.api.properties) {
        const propertyName = property.name.replace(/[^A-Za-z0-9_]/g, "");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(propertyName)) continue;
        addUniqueByName(fb.properties, {
          name: propertyName,
          type: parseType(property.type).type,
          visibility: "PUBLIC",
          readable: /get/i.test(property.access),
          writable: /set/i.test(property.access),
        });
      }
      for (const declaration of page.declarations) {
        const relation = declaration.match(
          /FUNCTION_BLOCK\s+\w+(?:\s+EXTENDS\s+([A-Za-z_]\w*))?(?:\s+IMPLEMENTS\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*))?/i,
        );
        if (relation?.[1]) fb.extends = relation[1];
        if (relation?.[2])
          fb.implements = relation[2].split(",").map((value) => value.trim());
        const method = parseMethod(declaration);
        if (method) addUniqueByName(fb.methods, method);
      }
    }
    if (page.kinds.includes("method")) {
      const parts = page.symbols[0].split(".");
      const methodName = parts.pop();
      const fb = getFb(parts.join(".") || "FB_VirtualMethodOwner");
      const declaration = page.declarations.find((value) =>
        /\bMETHOD\b/i.test(value),
      );
      const method = declaration && parseMethod(declaration, methodName);
      if (method) addUniqueByName(fb.methods, method);
    }
    if (page.kinds.includes("function")) {
      const functionName = page.symbols[0];
      const declaration =
        page.declarations.find((value) =>
          new RegExp(
            `\\bFUNCTION\\s+${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "i",
          ).test(value),
        ) ??
        page.declarations.find((value) =>
          /\bVAR_(?:INPUT|OUTPUT|IN_OUT)\b/i.test(value),
        );
      const header = declaration?.match(
        /\bFUNCTION\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)/i,
      );
      const blocks = parseVarBlocks(declaration ? [declaration] : []);
      const outputReturn = page.api.outputs.find(
        (row) => row.name.toUpperCase() === functionName.toUpperCase(),
      );
      addUniqueByName(functions, {
        name: functionName,
        returnType:
          header?.[2] ?? parseType(outputReturn?.type ?? "UDINT").type,
        parameters: [
          ...(blocks.inputs.length > 0
            ? blocks.inputs
            : tableVariables(page.api.inputs, "input")),
          ...([...blocks.outputs, ...blocks.inouts].length > 0
            ? [...blocks.outputs, ...blocks.inouts]
            : tableVariables(
                page.api.outputs.filter(
                  (row) =>
                    row.name.toUpperCase() !== functionName.toUpperCase(),
                ),
                "output",
              )),
        ],
      });
    }
  }
  return { fbs, functions };
}

const callableTypeNames = new Set();
for (const page of catalog.pages) {
  if (page.kinds.includes("function_block")) {
    callableTypeNames.add(page.symbols[0].toUpperCase());
  }
  if (page.kinds.includes("method")) {
    callableTypeNames.add(
      page.symbols[0].split(".").slice(0, -1).join(".").toUpperCase(),
    );
  }
}

function documentedTypes() {
  const types = new Map();
  for (const page of catalog.pages) {
    const preferredKind = ["struct", "enum", "type"].find((kind) =>
      page.kinds.includes(kind),
    );
    const typeKindIndex = preferredKind
      ? page.kinds.indexOf(preferredKind)
      : -1;
    if (typeKindIndex < 0) continue;
    if (
      [
        "duplicate",
        "topic-only",
        "compiler-feature",
        "existing-equivalent",
      ].includes(page.disposition)
    )
      continue;
    const documentedKind = page.kinds[typeKindIndex];
    const name = (page.symbols[typeKindIndex] ?? page.symbols.at(-1))
      .split(".")
      .at(-1);
    const key = name.toUpperCase();
    if (types.has(key)) continue;
    if (documentedKind === "enum") {
      const members = [];
      for (const declaration of page.declarations) {
        const body = declaration.match(/\(([\s\S]*?)\)/)?.[1] ?? "";
        for (const match of body.matchAll(
          /([A-Za-z_]\w*)\s*(?::=\s*([^,\n]+))?\s*(?:,|$)/g,
        )) {
          if (
            !members.some(
              (member) => member.name.toUpperCase() === match[1].toUpperCase(),
            )
          ) {
            members.push({
              name: match[1],
              ...(match[2] ? { value: match[2].trim() } : {}),
            });
          }
        }
      }
      types.set(key, {
        name,
        kind: "enum",
        baseType: "DINT",
        enumMembers: members.length
          ? members
          : [{ name: "Unknown", value: "0" }],
      });
    } else if (documentedKind === "struct") {
      const fields = [];
      for (const declaration of page.declarations) {
        const body = declaration.match(
          /\bSTRUCT\b([\s\S]*?)\bEND_STRUCT\b/i,
        )?.[1];
        if (body) fields.push(...parseVariables(body));
      }
      if (
        name.toUpperCase() === "AXIS_REF" &&
        !fields.some((field) => field.name.toUpperCase() === "ADS")
      ) {
        fields.push({ name: "ADS", type: "UDINT" });
      }
      types.set(key, { name, kind: "struct", fields });
    } else {
      let definition = { baseType: "UDINT" };
      for (const declaration of page.declarations) {
        const alias = declaration.match(
          new RegExp(`\\bTYPE\\s+${name}\\s*:\\s*([^;\\n]+)`, "i"),
        );
        if (alias) {
          const parsed = parseType(alias[1]);
          definition = {
            baseType: parsed.elementTypeName ?? parsed.type,
            ...(parsed.arrayDimensions
              ? { arrayDimensions: parsed.arrayDimensions }
              : {}),
            ...(parsed.elementTypeName
              ? { elementTypeName: parsed.elementTypeName }
              : {}),
            ...(parsed.referenceKind
              ? { referenceKind: parsed.referenceKind }
              : {}),
            ...(parsed.maxLength !== undefined
              ? { maxLength: parsed.maxLength }
              : {}),
          };
        }
      }
      types.set(key, { name, kind: "alias", ...definition });
    }
  }
  for (const support of catalog.supportTypes) {
    const key = support.name.toUpperCase();
    if (
      ELEMENTARY.has(key) ||
      key === "VOID" ||
      key === "ARRAY" ||
      callableTypeNames.has(key)
    )
      continue;
    if (!types.has(key))
      types.set(key, { name: support.name, kind: "alias", baseType: "UDINT" });
  }
  types.set("AXIS_REF", {
    name: "AXIS_REF",
    kind: "struct",
    fields: [
      { name: "ADS", type: "UDINT" },
      { name: "Position", type: "LREAL" },
      { name: "Velocity", type: "LREAL" },
      { name: "Acceleration", type: "LREAL" },
      { name: "Enabled", type: "BOOL" },
      { name: "Error", type: "BOOL" },
      { name: "ErrorID", type: "UDINT" },
    ],
  });
  types.set("T_MAXSTRING", {
    name: "T_MaxString",
    kind: "alias",
    baseType: "STRING",
    maxLength: 255,
  });
  types.set("T_AMSNETID", {
    name: "T_AmsNetId",
    kind: "alias",
    baseType: "STRING",
    maxLength: 23,
  });
  types.set("T_IPV4ADDR", {
    name: "T_IPv4Addr",
    kind: "alias",
    baseType: "STRING",
    maxLength: 15,
  });
  types.set("FLOAT", { name: "FLOAT", kind: "alias", baseType: "REAL" });
  let addedSupportType = true;
  while (addedSupportType) {
    addedSupportType = false;
    for (const type of [...types.values()]) {
      const references = [
        ...(type.fields ?? []).flatMap((field) => [
          field.type,
          field.elementTypeName,
        ]),
        type.baseType,
        type.elementTypeName,
      ].filter(Boolean);
      for (const reference of references) {
        const referenceKey = reference.toUpperCase();
        if (
          ELEMENTARY.has(referenceKey) ||
          callableTypeNames.has(referenceKey) ||
          types.has(referenceKey) ||
          referenceKey.startsWith("__INLINE_ARRAY_")
        )
          continue;
        types.set(referenceKey, {
          name: reference,
          kind: "alias",
          baseType: "UDINT",
        });
        addedSupportType = true;
      }
    }
  }
  for (const library of catalog.libraries) {
    const api = collectApis(library);
    const references = [
      ...api.fbs.flatMap((fb) => [
        ...fb.inputs.map((entry) => entry.elementTypeName ?? entry.type),
        ...fb.outputs.map((entry) => entry.elementTypeName ?? entry.type),
        ...fb.inouts.map((entry) => entry.elementTypeName ?? entry.type),
        ...fb.methods.flatMap((method) => [
          method.returnType,
          ...method.parameters.map(
            (entry) => entry.elementTypeName ?? entry.type,
          ),
        ]),
        ...fb.properties.map((property) => property.type),
        fb.extends,
        ...(fb.implements ?? []),
      ]),
      ...api.functions.flatMap((fn) => [
        fn.returnType,
        ...fn.parameters.map((entry) => entry.elementTypeName ?? entry.type),
      ]),
    ].filter(Boolean);
    for (const reference of references) {
      const referenceKey = reference.toUpperCase();
      if (
        ELEMENTARY.has(referenceKey) ||
        callableTypeNames.has(referenceKey) ||
        types.has(referenceKey) ||
        referenceKey.startsWith("__INLINE_ARRAY_")
      )
        continue;
      types.set(referenceKey, {
        name: reference,
        kind: "alias",
        baseType: "UDINT",
      });
    }
  }
  return [...types.values()];
}

const allTypes = documentedTypes();
const canonicalTypes = new Map(
  allTypes.map((type) => [type.name.toUpperCase(), type.name]),
);
const enumTypes = new Set(
  allTypes
    .filter((type) => type.kind === "enum")
    .map((type) => type.name.toUpperCase()),
);
const structTypes = new Set(
  allTypes
    .filter((type) => type.kind === "struct")
    .map((type) => type.name.toUpperCase()),
);
const interfaces = allTypes
  .filter((type) => /^(?:I_|ITF_)/i.test(type.name))
  .map((type) => ({ name: type.name, methods: [] }));
const interfaceNames = new Set(
  interfaces.map((entry) => entry.name.toUpperCase()),
);
function sortTypesByValueDependencies(types) {
  const byName = new Map(types.map((type) => [type.name.toUpperCase(), type]));
  const result = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(type) {
    const key = type.name.toUpperCase();
    if (visited.has(key) || visiting.has(key)) return;
    visiting.add(key);
    const references = [
      ...(type.fields ?? []).flatMap((field) => [
        field.type,
        field.elementTypeName,
      ]),
      type.baseType,
      type.elementTypeName,
    ].filter(Boolean);
    for (const reference of references) {
      const dependency = byName.get(reference.toUpperCase());
      if (dependency) visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
    result.push(type);
  }
  for (const type of types) visit(type);
  return result;
}
const coreTypes = sortTypesByValueDependencies(
  allTypes.filter((type) => !interfaceNames.has(type.name.toUpperCase())),
);

function canonical(name) {
  return canonicalTypes.get(name.toUpperCase()) ?? name;
}

function cppPrimitive(type) {
  const upper = type.toUpperCase();
  if (upper === "STRING") return "IEC_STRING";
  if (upper === "WSTRING") return "IEC_WSTRING";
  if (ELEMENTARY.has(upper)) return `IEC_${upper}`;
  if (callableTypeNames.has(upper)) return "IEC_UDINT";
  if (enumTypes.has(upper)) return `IEC_${canonical(type)}`;
  return canonical(type);
}

function cppType(variable) {
  let type;
  if (variable.arrayDimensions?.length && variable.elementTypeName) {
    const dimensions = variable.arrayDimensions
      .map((dimension) => `${dimension.start}, ${dimension.end}`)
      .join(", ");
    type = `Array${variable.arrayDimensions.length}D<${cppPrimitive(variable.elementTypeName)}, ${dimensions}>`;
  } else {
    const declaredLength = Number.isInteger(variable.maxLength)
      ? variable.maxLength
      : 254;
    type =
      variable.maxLength !== undefined &&
      variable.type.toUpperCase() === "STRING"
        ? `IECStringVar<${declaredLength}>`
        : variable.maxLength !== undefined &&
            variable.type.toUpperCase() === "WSTRING"
          ? `IECWStringVar<${declaredLength}>`
          : cppPrimitive(variable.type);
  }
  if (variable.referenceKind) {
    const upper = variable.type.toUpperCase();
    const raw =
      variable.arrayDimensions?.length && variable.elementTypeName
        ? type
        : upper === "STRING"
          ? "IECString<254>"
          : upper === "WSTRING"
            ? "IECWString<254>"
            : ELEMENTARY.has(upper)
              ? `${upper}_t`
              : callableTypeNames.has(upper)
                ? "UDINT_t"
                : canonical(variable.type);
    const wrapper =
      variable.referenceKind === "pointer_to"
        ? "IEC_Ptr"
        : variable.referenceKind === "ref_to"
          ? "IEC_REF_TO"
          : "IEC_REFERENCE_TO";
    type = `${wrapper}<${raw}>`;
  }
  return type;
}

function coreTypeHeader(type) {
  if (type.kind === "enum") {
    const members = type.enumMembers.map((member, index) => {
      const numeric = /^[-+]?\d+$/.test(member.value ?? "")
        ? member.value
        : String(index);
      return `    ${member.name} = ${numeric}`;
    });
    return `enum class ${type.name} : DINT_t {\n${members.join(",\n")}\n};\nusing IEC_${type.name} = IEC_ENUM<${type.name}>;`;
  }
  if (type.kind === "struct") {
    const fields = type.fields.map(
      (field) => `    ${cppType(field)} ${field.name}{};`,
    );
    return `struct ${type.name} {\n${fields.join("\n")}\n};`;
  }
  if (type.arrayDimensions?.length && type.elementTypeName) {
    const dimensions = type.arrayDimensions
      .map((dimension) => `${dimension.start}, ${dimension.end}`)
      .join(", ");
    return `using ${type.name} = Array${type.arrayDimensions.length}D<${cppPrimitive(type.elementTypeName)}, ${dimensions}>;`;
  }
  if (
    type.maxLength !== undefined &&
    type.baseType?.toUpperCase() === "STRING"
  ) {
    return `using ${type.name} = IECStringVar<${Number.isInteger(type.maxLength) ? type.maxLength : 254}>;`;
  }
  if (
    type.maxLength !== undefined &&
    type.baseType?.toUpperCase() === "WSTRING"
  ) {
    return `using ${type.name} = IECWStringVar<${Number.isInteger(type.maxLength) ? type.maxLength : 254}>;`;
  }
  return `using ${type.name} = ${cppPrimitive(type.baseType ?? "UDINT")};`;
}

function referencedTypeDeps(entries) {
  const names = new Set();
  for (const entry of entries) {
    const name = entry.elementTypeName ?? entry.type;
    if (
      !ELEMENTARY.has(name.toUpperCase()) &&
      canonicalTypes.has(name.toUpperCase())
    )
      names.add(canonical(name).toUpperCase());
  }
  return [...names].map((name) => ({ library: "beckhoff-virtual-core", name }));
}

const RESOURCE_NAME =
  /(?:path|file|name|netid|port|address|addr|index|group|id|handle|topic|url|host|node|table|database|device|channel|register|endpoint)/i;
const PAYLOAD_NAME =
  /(?:value|data|content|payload|message|record|text|buffer)/i;

function isScalar(variable) {
  const upper = variable.type.toUpperCase();
  return (
    ELEMENTARY.has(upper) &&
    !variable.arrayDimensions &&
    !variable.referenceKind
  );
}

function virtualOperation(fb, library) {
  const name = fb.name.toLowerCase();
  if (fb.inouts.some((field) => field.type.toUpperCase() === "AXIS_REF"))
    return "Connect";
  if (/(?:delete|remove|unlink|rmdir)/.test(name)) return "Remove";
  if (/(?:write|create|send|publish|upload|insert|append|store)/.test(name))
    return "Write";
  if (/(?:connect|login|subscribe|listen|open)/.test(name)) {
    return /file/i.test(library + fb.name) ? "Read" : "Connect";
  }
  if (/(?:read|receive|download|query|select|exists|check|fetch)/.test(name))
    return "Read";
  return "None";
}

function resourceKeyExpression(fb, library) {
  const axis = fb.inouts.find(
    (field) => field.type.toUpperCase() === "AXIS_REF",
  );
  if (axis) {
    return `beckhoff_virtual::axisResourceKey(static_cast<std::uint32_t>(${axis.name}.ADS))`;
  }
  const handle = fb.inputs.find((input) =>
    /^(?:hFile|hHandle|nHandle)$/i.test(input.name),
  );
  if (handle) {
    return `beckhoff_virtual::environment().resourceForHandle(static_cast<std::uint32_t>(${handle.name}))`;
  }
  const candidates = fb.inputs
    .filter(
      (input) =>
        RESOURCE_NAME.test(input.name) &&
        !input.arrayDimensions &&
        !input.referenceKind &&
        !/^e[A-Z_]/.test(input.name) &&
        !structTypes.has(input.type.toUpperCase()) &&
        !enumTypes.has(input.type.toUpperCase()) &&
        !callableTypeNames.has(input.type.toUpperCase()),
    )
    .slice(0, 4);
  if (candidates.length > 0) {
    return `beckhoff_virtual::joinResourceKey({${candidates.map((input) => `beckhoff_virtual::resourceKey(${input.name})`).join(", ")}})`;
  }
  return JSON.stringify(`${library}.${fb.name}`);
}

function payloadCandidate(variables) {
  return variables.find(
    (variable) => isScalar(variable) && PAYLOAD_NAME.test(variable.name),
  );
}

function fieldByName(fields, name) {
  if (!name) return undefined;
  return fields.find((field) => field.name === name);
}

function resourceKeyDescriptor(fb, library) {
  const axis = fb.inouts.find(
    (field) => field.type.toUpperCase() === "AXIS_REF",
  );
  if (axis) return { kind: "axisAds", input: axis.name };
  const handle = fb.inputs.find((input) =>
    /^(?:hFile|hHandle|nHandle)$/i.test(input.name),
  );
  if (handle) return { kind: "handle", input: handle.name };
  const inputs = fb.inputs
    .filter(
      (input) =>
        RESOURCE_NAME.test(input.name) &&
        !input.arrayDimensions &&
        !input.referenceKind &&
        !/^e[A-Z_]/.test(input.name) &&
        !structTypes.has(input.type.toUpperCase()) &&
        !enumTypes.has(input.type.toUpperCase()) &&
        !callableTypeNames.has(input.type.toUpperCase()),
    )
    .slice(0, 4)
    .map((input) => input.name);
  return inputs.length > 0
    ? { kind: "inputs", inputs }
    : { kind: "instance", value: `${library}.${fb.name}` };
}

function motionAction(name) {
  if (/^MC_Power$/i.test(name)) return "power";
  if (/reset/i.test(name)) return "reset";
  if (/(?:stop|halt|abort)/i.test(name)) return "stop";
  if (/absolute/i.test(name)) return "moveAbsolute";
  if (/(?:relative|additive)/i.test(name)) return "moveRelative";
  if (/velocity/i.test(name)) return "velocity";
  return "observe";
}

function describeFunctionBlock(fb, library) {
  const operation = virtualOperation(fb, library);
  const trigger =
    fb.inputs.find((input) =>
      /^(?:b)?(?:execute|start|read|write|trigger|request|connect|send)$/i.test(
        input.name,
      ),
    ) ??
    (operation !== "None"
      ? fb.inputs.find((input) => /^(?:b)?enable$/i.test(input.name))
      : undefined);
  const busy = fb.outputs.find(
    (output) =>
      /busy/i.test(output.name) && output.type.toUpperCase() === "BOOL",
  );
  const done = fb.outputs.find(
    (output) =>
      /(?:done|valid|complete|connected|ack|status)/i.test(output.name) &&
      output.type.toUpperCase() === "BOOL",
  );
  const error = fb.outputs.find(
    (output) =>
      /error$/i.test(output.name) && output.type.toUpperCase() === "BOOL",
  );
  const errorId = fb.outputs.find((output) =>
    /(?:error.*id|err.*id)/i.test(output.name),
  );
  const axis = fb.inouts.find(
    (field) => field.type.toUpperCase() === "AXIS_REF",
  );
  const payloadInput = payloadCandidate(fb.inputs);
  const payloadOutput = payloadCandidate(fb.outputs);
  const handleOutput = fb.outputs.find((output) =>
    /^(?:hFile|hHandle|nHandle)$/i.test(output.name),
  );
  const countOutput = fb.outputs.find((output) =>
    /^(?:cbRead|cbWrite|nBytesRead|nBytesWritten)$/i.test(output.name),
  );
  const countInput = fb.inputs.find((input) =>
    /^(?:cbReadLen|cbWriteLen|nLength|nSize)$/i.test(input.name),
  );
  const eofOutput = fb.outputs.find((output) =>
    /^(?:bEOF|EOF)$/i.test(output.name),
  );
  const family = axis
    ? "motion-axis"
    : operation !== "None"
      ? `${library.toLowerCase()}-resource`
      : trigger
        ? `${library.toLowerCase()}-state-machine`
        : `${library.toLowerCase()}-deterministic`;
  return {
    target: `${library}.${fb.name}`,
    callableKind: "functionBlock",
    behavior: axis || operation !== "None" ? "resource" : trigger ? "stateful" : "pure",
    family,
    ...(trigger
      ? {
          trigger: {
            input: trigger.name,
            mode: /^MC_Power$/i.test(fb.name) ? "level" : "rising",
            ...(busy ? { busy: busy.name } : {}),
            ...(done ? { done: done.name } : {}),
            ...(error ? { error: error.name } : {}),
            ...(errorId ? { errorId: errorId.name } : {}),
            latencyScans: 1,
          },
        }
      : {}),
    ...(axis || operation !== "None"
      ? {
          resource: {
            operation,
            key: resourceKeyDescriptor(fb, library),
            ...(payloadInput ? { payloadInput: payloadInput.name } : {}),
            ...(payloadOutput ? { payloadOutput: payloadOutput.name } : {}),
            ...(handleOutput ? { handleOutput: handleOutput.name } : {}),
            ...(countInput ? { countInput: countInput.name } : {}),
            ...(countOutput ? { countOutput: countOutput.name } : {}),
            ...(eofOutput ? { eofOutput: eofOutput.name } : {}),
          },
        }
      : {}),
    ...(axis
      ? {
          motion: {
            axis: axis.name,
            action: motionAction(fb.name),
            ...(fb.inputs.find((field) => /^position$/i.test(field.name))
              ? { positionInput: fb.inputs.find((field) => /^position$/i.test(field.name)).name }
              : {}),
            ...(fb.inputs.find((field) => /^distance$/i.test(field.name))
              ? { distanceInput: fb.inputs.find((field) => /^distance$/i.test(field.name)).name }
              : {}),
            ...(fb.inputs.find((field) => /^velocity$/i.test(field.name))
              ? { velocityInput: fb.inputs.find((field) => /^velocity$/i.test(field.name)).name }
              : {}),
          },
        }
      : {}),
  };
}

function buildSimulationCatalog() {
  const descriptors = [];
  for (const library of catalog.libraries.filter(
    (name) => name !== "Tc2_Standard" && !name.startsWith("TwinCAT_"),
  )) {
    const { fbs, functions } = collectApis(library);
    for (const fb of fbs) {
      descriptors.push(describeFunctionBlock(fb, library));
      for (const method of fb.methods) {
        descriptors.push({
          target: `${library}.${fb.name}.${method.name}`,
          callableKind: "method",
          behavior: "stateful",
          family: `${library.toLowerCase()}-method`,
        });
      }
      for (const property of fb.properties) {
        descriptors.push({
          target: `${library}.${fb.name}.${property.name}`,
          callableKind: "property",
          behavior: "stateful",
          family: `${library.toLowerCase()}-property`,
          propertyAccess: {
            readable: property.readable,
            writable: property.writable,
          },
        });
      }
    }
    for (const fn of functions) {
      descriptors.push({
        target: `${library}.${fn.name}`,
        callableKind: "function",
        behavior: "pure",
        family: `${library.toLowerCase()}-deterministic`,
      });
    }
  }
  descriptors.sort((left, right) => left.target.localeCompare(right.target));
  const supportTypes = allTypes
    .map((type) => ({ name: type.name, disposition: "virtual-runtime-type" }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    profile: "beckhoff-virtual-v1",
    capability: "beckhoffVirtualTransparentExecutionV1",
    defaultLatencyScans: 1,
    descriptors,
    supportTypes,
  };
}

function expectedSimulationTargets() {
  const targets = [];
  for (const library of catalog.libraries.filter(
    (name) => name !== "Tc2_Standard" && !name.startsWith("TwinCAT_"),
  )) {
    const { fbs, functions } = collectApis(library);
    for (const fb of fbs) {
      targets.push(`${library}.${fb.name}`);
      targets.push(...fb.methods.map((method) => `${library}.${fb.name}.${method.name}`));
      targets.push(...fb.properties.map((property) => `${library}.${fb.name}.${property.name}`));
    }
    targets.push(...functions.map((fn) => `${library}.${fn.name}`));
  }
  return targets.sort();
}

function loadSimulationCatalog() {
  if (process.argv.includes("--refresh-simulation-catalog")) {
    const generated = buildSimulationCatalog();
    writeFileSync(simulationCatalogPath, `${JSON.stringify(generated, null, 2)}\n`);
    return generated;
  }
  if (!existsSync(simulationCatalogPath)) {
    throw new Error(
      `Missing committed simulation catalog: ${simulationCatalogPath}. Run this script with --refresh-simulation-catalog.`,
    );
  }
  return JSON.parse(readFileSync(simulationCatalogPath, "utf8"));
}

const simulationCatalog = loadSimulationCatalog();
const simulationDescriptorByTarget = new Map(
  simulationCatalog.descriptors.map((descriptor) => [descriptor.target, descriptor]),
);
const expectedTargets = expectedSimulationTargets();
const missingTargets = expectedTargets.filter(
  (target) => !simulationDescriptorByTarget.has(target),
);
const unexpectedTargets = simulationCatalog.descriptors
  .map((descriptor) => descriptor.target)
  .filter((target) => !expectedTargets.includes(target));
const missingSupportTypes = allTypes.filter(
  (type) => !simulationCatalog.supportTypes.some(
    (support) => support.name.toUpperCase() === type.name.toUpperCase() && support.disposition,
  ),
);
if (missingTargets.length || unexpectedTargets.length || missingSupportTypes.length) {
  throw new Error(
    `Beckhoff simulation catalog coverage mismatch: missing=${missingTargets.join(",")}; unexpected=${unexpectedTargets.join(",")}; supportTypes=${missingSupportTypes.map((type) => type.name).join(",")}`,
  );
}

function resourceKeyExpressionFromDescriptor(resource) {
  if (!resource) return 'std::string()';
  const key = resource.key;
  if (key.kind === "axisAds") {
    return `beckhoff_virtual::axisResourceKey(static_cast<std::uint32_t>(${key.input}.ADS))`;
  }
  if (key.kind === "handle") {
    return `beckhoff_virtual::environment().resourceForHandle(static_cast<std::uint32_t>(${key.input}))`;
  }
  if (key.kind === "inputs") {
    return `beckhoff_virtual::joinResourceKey({${key.inputs.map((input) => `beckhoff_virtual::resourceKey(${input})`).join(", ")}})`;
  }
  return JSON.stringify(key.value);
}

function fbHeader(fb, library) {
  const fields = [...fb.inputs, ...fb.outputs, ...fb.inouts];
  const bases = [fb.extends, ...(fb.implements ?? [])]
    .filter(Boolean)
    .map((base) => `public ${base}`);
  const lines = [
    `class ${fb.name}${bases.length ? ` : ${bases.join(", ")}` : ""} {`,
    "public:",
  ];
  for (const field of fields)
    lines.push(`    ${cppType(field)} ${field.name}{};`);
  for (const property of fb.properties)
    lines.push(
      `    ${cppPrimitive(property.type)} __property_${property.name}{};`,
    );
  const descriptor = simulationDescriptorByTarget.get(`${library}.${fb.name}`);
  if (!descriptor) throw new Error(`Missing simulation descriptor for ${library}.${fb.name}`);
  const operation = descriptor.resource?.operation ?? "None";
  const trigger = fieldByName(fb.inputs, descriptor.trigger?.input);
  const busy = fieldByName(fb.outputs, descriptor.trigger?.busy);
  const done = fieldByName(fb.outputs, descriptor.trigger?.done);
  const error = fieldByName(fb.outputs, descriptor.trigger?.error);
  const errorId = fieldByName(fb.outputs, descriptor.trigger?.errorId);
  const axis = fieldByName(fb.inouts, descriptor.motion?.axis);
  const targetPosition = fieldByName(fb.inputs, descriptor.motion?.positionInput);
  const targetDistance = fieldByName(fb.inputs, descriptor.motion?.distanceInput);
  const targetVelocity = fieldByName(fb.inputs, descriptor.motion?.velocityInput);
  const payloadInput = fieldByName(fb.inputs, descriptor.resource?.payloadInput);
  const payloadOutput = fieldByName(fb.outputs, descriptor.resource?.payloadOutput);
  const handleOutput = fieldByName(fb.outputs, descriptor.resource?.handleOutput);
  const countOutput = fieldByName(fb.outputs, descriptor.resource?.countOutput);
  const countInput = fieldByName(fb.inputs, descriptor.resource?.countInput);
  const eofOutput = fieldByName(fb.outputs, descriptor.resource?.eofOutput);
  const resourceKey = resourceKeyExpressionFromDescriptor(descriptor.resource);
  lines.push("    bool __virtualPreviousTrigger = false;");
  lines.push("    bool __virtualPending = false;");
  lines.push("    std::uint32_t __virtualDelayScans = 0;");
  lines.push("    std::uint32_t __virtualErrorId = 0;");
  lines.push("    IEC_BOOL ENO = true;");
  lines.push("    void operator()() {");
  lines.push(`        const std::string __resourceKey = ${resourceKey};`);
  if (axis) {
    lines.push(
      `        auto& __axisState = beckhoff_virtual::environment().axis(static_cast<std::uint32_t>(${axis.name}.ADS));`,
    );
    lines.push(
      `        ${axis.name}.Position = __axisState.position;`,
    );
    lines.push(
      `        ${axis.name}.Velocity = __axisState.velocity;`,
    );
    lines.push(
      `        ${axis.name}.Acceleration = __axisState.acceleration;`,
    );
    lines.push(
      `        ${axis.name}.Enabled = __axisState.enabled;`,
    );
    lines.push(`        ${axis.name}.Error = __axisState.error;`);
    lines.push(
      `        ${axis.name}.ErrorID = __axisState.errorId;`,
    );
  }
  if (trigger) {
    lines.push(
      `        const bool __trigger = static_cast<bool>(${trigger.name});`,
    );
    if (done) lines.push(`        ${done.name} = false;`);
    if (error) lines.push(`        ${error.name} = false;`);
    lines.push("        if (__trigger && !__virtualPreviousTrigger) {");
    lines.push(
      `            const auto __outcome = beckhoff_virtual::environment().beginResourceCall("${library}.${fb.name}", __resourceKey, beckhoff_virtual::ResourceOperation::${operation});`,
    );
    lines.push("            __virtualDelayScans = __outcome.delayScans;");
    lines.push("            __virtualErrorId = __outcome.errorId;");
    if (busy) lines.push(`            ${busy.name} = true;`);
    lines.push("            __virtualPending = true;");
    lines.push("        } else if (__virtualPending) {");
    lines.push("            if (__virtualDelayScans > 0) {");
    lines.push("                --__virtualDelayScans;");
    lines.push("            } else {");
    if (busy) lines.push(`            ${busy.name} = false;`);
    if (error)
      lines.push(`                ${error.name} = (__virtualErrorId != 0);`);
    if (errorId && !enumTypes.has(errorId.type.toUpperCase())) {
      lines.push(`                ${errorId.name} = __virtualErrorId;`);
    }
    if (done)
      lines.push(`                ${done.name} = (__virtualErrorId == 0);`);
    if (operation === "Write" && payloadInput) {
      lines.push(
        `                if (__virtualErrorId == 0) beckhoff_virtual::environment().writePayload(__resourceKey, beckhoff_virtual::payload(${payloadInput.name}));`,
      );
    }
    if (operation === "Read" && payloadOutput) {
      lines.push("                if (__virtualErrorId == 0) {");
      lines.push(
        "                    const auto* __payload = beckhoff_virtual::environment().readPayload(__resourceKey);",
      );
      lines.push(
        `                    if (__payload) beckhoff_virtual::assignPayload(${payloadOutput.name}, *__payload);`,
      );
      lines.push("                }");
    }
    if (handleOutput) {
      lines.push(
        `                if (__virtualErrorId == 0) ${handleOutput.name} = beckhoff_virtual::environment().handleForResource(__resourceKey);`,
      );
    }
    if (countOutput && countInput) {
      lines.push(
        `                if (__virtualErrorId == 0) ${countOutput.name} = ${countInput.name};`,
      );
    }
    if (eofOutput) {
      lines.push(
        `                if (__virtualErrorId == 0) ${eofOutput.name} = true;`,
      );
    }
    if (axis && targetPosition)
      lines.push(
        `                if (__virtualErrorId == 0) ${axis.name}.Position = ${targetPosition.name};`,
      );
    if (axis && targetDistance)
      lines.push(
        `                if (__virtualErrorId == 0) ${axis.name}.Position = static_cast<double>(${axis.name}.Position) + static_cast<double>(${targetDistance.name});`,
      );
    if (axis && targetVelocity)
      lines.push(
        `                if (__virtualErrorId == 0) ${axis.name}.Velocity = ${targetVelocity.name};`,
      );
    if (axis && descriptor.motion?.action === "stop")
      lines.push(
        `                if (__virtualErrorId == 0) ${axis.name}.Velocity = 0.0;`,
      );
    if (axis && descriptor.motion?.action === "reset") {
      lines.push(
        `                if (__virtualErrorId == 0) { ${axis.name}.Error = false; ${axis.name}.ErrorID = 0; }`,
      );
    }
    if (axis && descriptor.motion?.action === "power") {
      lines.push(
        `                if (__virtualErrorId == 0) ${axis.name}.Enabled = __trigger;`,
      );
    }
    if (axis) {
      lines.push(
        "                if (__virtualErrorId == 0) {",
      );
      lines.push(
        `                    __axisState.position = static_cast<double>(${axis.name}.Position);`,
      );
      lines.push(
        `                    __axisState.velocity = static_cast<double>(${axis.name}.Velocity);`,
      );
      lines.push(
        `                    __axisState.acceleration = static_cast<double>(${axis.name}.Acceleration);`,
      );
      lines.push(
        `                    __axisState.enabled = static_cast<bool>(${axis.name}.Enabled);`,
      );
      lines.push(
        `                    __axisState.error = static_cast<bool>(${axis.name}.Error);`,
      );
      lines.push(
        `                    __axisState.errorId = static_cast<std::uint32_t>(${axis.name}.ErrorID);`,
      );
      lines.push("                }");
    }
    lines.push("            __virtualPending = false;");
    lines.push("            }");
    lines.push("        }");
    lines.push("        __virtualPreviousTrigger = __trigger;");
    if (axis && descriptor.motion?.action === "power") {
      lines.push("        if (!__trigger) {");
      lines.push(`            ${axis.name}.Enabled = false;`);
      if (done) lines.push(`            ${done.name} = false;`);
      lines.push(
        "            __axisState.enabled = false;",
      );
      lines.push("        }");
    }
  } else {
    for (const output of fb.outputs) {
      const exact = fb.inputs.find(
        (input) =>
          input.type.toUpperCase() === output.type.toUpperCase() &&
          input.name.replace(/^[a-z]/i, "").toUpperCase() ===
            output.name.replace(/^[a-z]/i, "").toUpperCase(),
      );
      const fallback = fb.inputs.find(
        (input) =>
          input.type.toUpperCase() === output.type.toUpperCase() &&
          isScalar(input),
      );
      const source = exact ?? fallback;
      if (source && isScalar(output))
        lines.push(`        ${output.name} = ${source.name};`);
    }
  }
  lines.push("    }");
  for (const method of fb.methods) {
    const parameters = method.parameters.map((parameter) => {
      const suffix = parameter.direction === "input" ? "" : "&";
      return `${cppType(parameter)}${suffix} ${parameter.name}`;
    });
    const returnType = method.returnType
      ? cppPrimitive(method.returnType)
      : "void";
    lines.push(
      `    virtual ${returnType} ${method.name}(${parameters.join(", ")}) {`,
    );
    lines.push(
      `        const auto __outcome = beckhoff_virtual::environment().beginCall("${library}.${fb.name}.${method.name}");`,
    );
    for (const parameter of method.parameters.filter(
      (parameter) => parameter.direction !== "input",
    )) {
      lines.push(`        ${parameter.name} = {};`);
    }
    if (method.returnType?.toUpperCase() === "BOOL") {
      lines.push("        return __outcome.errorId == 0;");
    } else if (method.returnType) lines.push("        return {};");
    lines.push("    }");
  }
  for (const property of fb.properties) {
    const type = cppPrimitive(property.type);
    if (property.readable)
      lines.push(
        `    virtual ${type} get_${property.name}() const { return __property_${property.name}; }`,
      );
    if (property.writable)
      lines.push(
        `    virtual void set_${property.name}(${type} value) { __property_${property.name} = value; }`,
      );
  }
  lines.push(`    virtual ~${fb.name}() = default;`, "};");
  return lines.join("\n");
}

function functionHeader(fn) {
  const parameters = fn.parameters.map((parameter) => {
    const suffix = parameter.direction === "input" ? "" : "&";
    return `${cppType(parameter)}${suffix} ${parameter.name}`;
  });
  const passthrough = fn.parameters.find(
    (parameter) =>
      parameter.direction === "input" &&
      parameter.type.toUpperCase() === fn.returnType.toUpperCase(),
  );
  return `inline ${cppPrimitive(fn.returnType)} ${fn.name}(${parameters.join(", ")}) { return ${passthrough ? passthrough.name : "{}"}; }`;
}

function buildCoreArchive() {
  const typeChunks = coreTypes.map((type) => ({
    name: type.name.toUpperCase(),
    kind: "type",
    header: coreTypeHeader(type),
    cpp: "",
    deps: [],
  }));
  const interfaceChunks = interfaces.map((entry) => ({
    name: entry.name.toUpperCase(),
    kind: "type",
    header: `class ${entry.name} { public: virtual ~${entry.name}() = default; };`,
    cpp: "",
    deps: [],
  }));
  return {
    formatVersion: 2,
    manifest: {
      name: "beckhoff-virtual-core",
      displayName: "Beckhoff Virtual Core",
      version: "1.0.0",
      description:
        "Deterministic offline runtime types and services for Beckhoff compatibility tests.",
      namespace: "beckhoff_virtual",
      functions: [],
      functionBlocks: [],
      interfaces,
      types: coreTypes,
      headers: ["beckhoff_virtual.hpp"],
      isBuiltin: true,
      runtimeCapabilities: RUNTIME_CAPABILITIES,
      simulationDescriptors: [],
    },
    chunks: [...typeChunks, ...interfaceChunks],
    dependencies: [],
  };
}

function buildLibraryArchive(library) {
  const { fbs, functions } = collectApis(library);
  const id = libraryId(library);
  const chunks = [];
  const sortedFbs = [...fbs].sort(
    (left, right) =>
      Number(Boolean(left.extends)) - Number(Boolean(right.extends)),
  );
  for (const fb of sortedFbs) {
    const members = [
      ...fb.inputs,
      ...fb.outputs,
      ...fb.inouts,
      ...fb.methods.flatMap((method) => method.parameters),
    ];
    const typeDeps = referencedTypeDeps(members);
    for (const method of fb.methods) {
      if (
        method.returnType &&
        canonicalTypes.has(method.returnType.toUpperCase())
      ) {
        typeDeps.push({
          library: "beckhoff-virtual-core",
          name: canonical(method.returnType).toUpperCase(),
        });
      }
    }
    for (const property of fb.properties) {
      if (canonicalTypes.has(property.type.toUpperCase())) {
        typeDeps.push({
          library: "beckhoff-virtual-core",
          name: canonical(property.type).toUpperCase(),
        });
      }
    }
    if (fb.extends)
      typeDeps.push({ library: id, name: fb.extends.toUpperCase() });
    for (const iface of fb.implements ?? [])
      typeDeps.push({
        library: "beckhoff-virtual-core",
        name: iface.toUpperCase(),
      });
    chunks.push({
      name: fb.name.toUpperCase(),
      kind: "functionBlock",
      header: fbHeader(fb, library),
      cpp: "",
      deps: typeDeps,
    });
  }
  for (const fn of functions) {
    chunks.push({
      name: fn.name.toUpperCase(),
      kind: "function",
      header: functionHeader(fn),
      cpp: "",
      deps: referencedTypeDeps([...fn.parameters, { type: fn.returnType }]),
    });
  }
  return {
    formatVersion: 2,
    manifest: {
      name: id,
      displayName: `${library} (Virtual)`,
      version: "1.0.0",
      description: `Deterministic offline compatibility surface for ${library}.`,
      namespace: id.replaceAll("-", "_"),
      functions,
      functionBlocks: fbs,
      interfaces: [],
      types: [],
      headers: [],
      isBuiltin: true,
      runtimeCapabilities: [
        "beckhoff-virtual-v1",
        "beckhoffVirtualTransparentExecutionV1",
      ],
      simulationDescriptors: simulationCatalog.descriptors.filter(
        (descriptor) => descriptor.target.startsWith(`${library}.`),
      ),
    },
    chunks,
    dependencies: [{ name: "beckhoff-virtual-core", version: "1.0.0" }],
  };
}

export function generateBeckhoffVirtualLibraries() {
  mkdirSync(libsDir, { recursive: true });
  mkdirSync(dirname(profilePath), { recursive: true });
  const core = buildCoreArchive();
  mkdirSync(beckhoffLibsDir, { recursive: true });
  const generatedArchives = [core];
  const vendorLibraries = catalog.libraries.filter(
    (name) => name !== "Tc2_Standard" && !name.startsWith("TwinCAT_"),
  );
  const archiveNames = [];
  for (const library of vendorLibraries) {
    const archive = buildLibraryArchive(library);
    generatedArchives.push(archive);
    archiveNames.push(archive.manifest.name);
    writeFileSync(
      resolve(beckhoffLibsDir, `${archive.manifest.name}.stlib`),
      `${JSON.stringify(archive, null, 2)}\n`,
    );
  }
  writeFileSync(
    resolve(beckhoffLibsDir, "beckhoff-virtual-core.stlib"),
    `${JSON.stringify(core, null, 2)}\n`,
  );
  const simulationIdentity = `beckhoff-transparent:${createHash("sha256")
    .update("beckhoff-virtual-runtime-v2\0")
    .update(readFileSync(catalogPath))
    .update("\0")
    .update(readFileSync(simulationCatalogPath))
    .update("\0")
    .update(JSON.stringify(generatedArchives))
    .digest("hex")}`;
  const profile = {
    schemaVersion: 1,
    name: "beckhoff-virtual",
    runtimeProfile: "beckhoff-virtual-v1",
    coverageCatalog:
      "../sources/beckhoff-virtual-core/beckhoff-api-catalog.json",
    simulationCatalog:
      "../sources/beckhoff-virtual-core/beckhoff-simulation-catalog.json",
    simulationIdentity,
    capabilities: ["beckhoffVirtualTransparentExecutionV1"],
    excludedLibraries: ["additional-function-blocks"],
    libraries: [
      { name: "iec-standard-fb", path: "iec-standard-fb.stlib" },
      {
        name: "beckhoff-virtual-core",
        path: "beckhoff-virtual/beckhoff-virtual-core.stlib",
      },
      ...archiveNames.map((name) => ({
        name,
        path: `beckhoff-virtual/${name}.stlib`,
      })),
    ],
  };
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  return { archiveCount: archiveNames.length + 2, profile };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = generateBeckhoffVirtualLibraries();
  console.log(
    `[beckhoff-virtual] generated ${result.archiveCount} profile archives`,
  );
}
