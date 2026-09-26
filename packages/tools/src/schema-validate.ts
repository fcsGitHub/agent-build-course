/**
 * 最小 JSON Schema 校验器（覆盖教学工具需要的子集：type/properties/required/items/enum）。
 * 完整 JSON Schema 校验在需要时引入 ajv；此处避免为 4 个课程工具引入大依赖。
 */
import type { JsonValue } from "@agentglass/contracts";

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAgainstSchema(value: unknown, schema: JsonValue): SchemaValidationResult {
  const errors: string[] = [];
  check(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function check(value: unknown, schema: JsonValue, path: string, errors: string[]): void {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: schema 禁止任何值`);
    return;
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return;
  }
  const s = schema as {
    type?: string | string[];
    properties?: Record<string, JsonValue>;
    required?: string[];
    items?: JsonValue;
    enum?: JsonValue[];
    additionalProperties?: boolean;
    minItems?: number;
    maxItems?: number;
  };
  if (s.type != null) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchType(value, t))) {
      errors.push(`${path}: 期望类型 ${types.join("|")}，实际 ${typeName(value)}`);
      return;
    }
  }
  if (s.enum != null && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: 值不在 enum 内`);
  }
  if (typeName(value) === "object" && s.properties) {
    for (const req of s.required ?? []) {
      if ((value as Record<string, unknown>)[req] === undefined) {
        errors.push(`${path}.${req}: 缺少必填属性`);
      }
    }
    for (const [key, sub] of Object.entries(s.properties)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) check(v, sub, `${path}.${key}`, errors);
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!(key in s.properties)) {
          errors.push(`${path}.${key}: 不允许的额外属性`);
        }
      }
    }
  }
  if (typeName(value) === "array" && s.items != null) {
    const arr = value as unknown[];
    if (s.minItems != null && arr.length < s.minItems) errors.push(`${path}: 数组长度 < ${s.minItems}`);
    if (s.maxItems != null && arr.length > s.maxItems) errors.push(`${path}: 数组长度 > ${s.maxItems}`);
    arr.forEach((item, i) => check(item, s.items!, `${path}[${i}]`, errors));
  }
}

function matchType(value: unknown, t: string): boolean {
  switch (t) {
    case "object":
      return typeName(value) === "object";
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
