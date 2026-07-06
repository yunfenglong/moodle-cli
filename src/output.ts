import YAML from "yaml";
import { UsageError } from "./errors.js";

export type OutputFormat = "json" | "yaml" | "table";

export interface OutputOptions {
  format: OutputFormat;
  fields?: string;
}

export function stripEmpty(value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(stripEmpty).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, stripEmpty(child)] as const)
      .filter(([, child]) => child !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function applyFields(data: unknown, fieldsValue?: string): unknown {
  if (!fieldsValue) {
    return data;
  }

  const requested = fieldsValue
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (!requested.length) {
    throw new UsageError("--fields must include at least one field");
  }

  const objects = Array.isArray(data) ? data : [data];
  const firstObject = objects.find(isPlainObject);
  if (!firstObject) {
    throw new UsageError("--fields can only be used with object or object-array output");
  }

  const valid = Object.keys(firstObject);
  const invalid = requested.filter((field) => !valid.includes(field));
  if (invalid.length) {
    throw new UsageError(`Unknown field '${invalid[0]}'. Valid fields: ${valid.join(", ")}`);
  }

  const pick = (item: unknown): unknown => {
    if (!isPlainObject(item)) {
      return item;
    }
    return Object.fromEntries(requested.map((field) => [field, item[field]]));
  };

  return Array.isArray(data) ? data.map(pick) : pick(data);
}

export function serializeStructured(data: unknown, options: OutputOptions): string {
  const filtered = applyFields(data, options.fields);
  const optimized = stripEmpty(filtered);
  const value = optimized === undefined ? null : optimized;
  if (options.format === "yaml") {
    return YAML.stringify(value).trimEnd();
  }
  return JSON.stringify(value);
}

export function errorJson(code: string, message: string, hint?: string): string {
  return JSON.stringify({ error: true, code, message, ...(hint ? { hint } : {}) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
