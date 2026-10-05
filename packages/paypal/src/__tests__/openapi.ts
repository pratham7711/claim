import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the PayPal REST OpenAPI specs live (a clone of paypal/paypal-rest-api-specifications). */
export const SPEC_DIR =
  process.env.PAYPAL_OPENAPI_DIR ?? join(homedir(), "brain/scratch/2026-10-04/paypal-hackathon/ref/specs/openapi");

type Schema = Record<string, unknown>;

export interface Spec {
  file: string;
  doc: { paths: Record<string, Record<string, Schema>>; components: { schemas: Record<string, Schema>; parameters?: Record<string, Schema> } };
}

export function loadSpec(file: string): Spec | undefined {
  const p = join(SPEC_DIR, file);
  if (!existsSync(p)) return undefined;
  return { file, doc: JSON.parse(readFileSync(p, "utf8")) };
}

/** Finds the operation whose path template matches a concrete path, e.g. /v2/checkout/orders/{id}/capture. */
export function findOperation(spec: Spec, method: string, path: string): { template: string; op: Schema } | undefined {
  for (const [template, ops] of Object.entries(spec.doc.paths)) {
    const re = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`);
    const op = ops[method.toLowerCase()];
    if (op && re.test(path)) return { template, op };
  }
  return undefined;
}

export function requestSchema(op: Schema): Schema | undefined {
  const rb = op.requestBody as { content?: Record<string, { schema?: Schema }> } | undefined;
  return rb?.content?.["application/json"]?.schema;
}

/**
 * A strict subset of JSON Schema validation, enough for PayPal's specs: $ref, allOf, oneOf/anyOf,
 * type, required, enum, pattern, min/maxLength, maxItems, readOnly, and unknown properties (PayPal
 * schemas list every property, so an unlisted one is a typo we want to catch).
 */
export function validate(spec: Spec, schema: Schema, value: unknown, at = "$", opaque: ReadonlySet<string> = new Set()): string[] {
  const s = resolve(spec, schema);
  const errors: string[] = [];
  // Opaque subtrees are documents we forward rather than build (a received webhook event).
  if (opaque.has(at)) return value && typeof value === "object" ? [] : [`${at}: expected an object`];

  for (const key of ["oneOf", "anyOf"] as const) {
    const alts = s[key] as Schema[] | undefined;
    if (alts && !alts.some((alt) => validate(spec, alt, value, at, opaque).length === 0)) errors.push(`${at}: matches no ${key} alternative`);
  }

  const merged = merge(spec, s);
  if (merged.readOnly) errors.push(`${at}: readOnly property sent in a request`);
  if (merged.enum && !(merged.enum as unknown[]).includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);

  const type = merged.type as string | undefined;
  if (type && !typeOk(type, value)) {
    errors.push(`${at}: expected ${type}, got ${Array.isArray(value) ? "array" : typeof value}`);
    return errors;
  }

  if (typeof value === "string") {
    if (typeof merged.minLength === "number" && value.length < merged.minLength) errors.push(`${at}: shorter than ${merged.minLength}`);
    if (typeof merged.maxLength === "number" && value.length > merged.maxLength) errors.push(`${at}: longer than ${merged.maxLength}`);
    for (const p of merged.patterns as string[]) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(p, "u");
      } catch {
        try {
          re = new RegExp(p);
        } catch {
          re = undefined;
        }
      }
      if (!re) errors.push(`${at}: spec pattern ${p} does not compile in JS`);
      else if (!re.test(value)) errors.push(`${at}: ${JSON.stringify(value)} does not match ${p}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof merged.maxItems === "number" && value.length > merged.maxItems) errors.push(`${at}: more than ${merged.maxItems} items`);
    if (typeof merged.minItems === "number" && value.length < merged.minItems) errors.push(`${at}: fewer than ${merged.minItems} items`);
    if (merged.items) value.forEach((v, i) => errors.push(...validate(spec, merged.items as Schema, v, `${at}[${i}]`, opaque)));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of merged.required as string[]) if (!(r in obj)) errors.push(`${at}: missing required "${r}"`);
    const props = merged.properties as Record<string, Schema>;
    const hasProps = Object.keys(props).length > 0;
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validate(spec, props[k]!, v, `${at}.${k}`, opaque));
      else if (hasProps && merged.additionalProperties !== true) errors.push(`${at}: unknown property "${k}"`);
    }
  }
  return errors;
}

function resolve(spec: Spec, s: Schema): Schema {
  let cur = s;
  for (let i = 0; i < 50 && typeof cur.$ref === "string"; i++) {
    const ref = cur.$ref as string;
    const name = ref.replace("#/components/schemas/", "");
    const next = spec.doc.components.schemas[name];
    if (!next) throw new Error(`${spec.file}: unresolved ${ref}`);
    cur = { ...next, ...Object.fromEntries(Object.entries(cur).filter(([k]) => k !== "$ref")) };
  }
  return cur;
}

interface Merged extends Schema {
  required: string[];
  properties: Record<string, Schema>;
  patterns: string[];
}

/** Flattens allOf chains into one view (properties, required, enum, type, length/pattern bounds). */
function merge(spec: Spec, schema: Schema): Merged {
  const s = resolve(spec, schema);
  const out: Merged = { required: [], properties: {}, patterns: [] };
  const parts = [s, ...((s.allOf as Schema[] | undefined) ?? []).map((p) => merge(spec, p))];
  for (const p of parts) {
    out.required.push(...(((p as Merged).required as string[] | undefined) ?? []));
    Object.assign(out.properties, (p.properties as Record<string, Schema> | undefined) ?? {});
    if (typeof p.pattern === "string") out.patterns.push(p.pattern);
    if (Array.isArray((p as Merged).patterns)) out.patterns.push(...(p as Merged).patterns);
    for (const k of ["type", "enum", "minLength", "maxLength", "maxItems", "minItems", "items", "readOnly", "additionalProperties"]) {
      if (p[k] !== undefined && out[k] === undefined) out[k] = p[k];
    }
  }
  out.patterns = [...new Set(out.patterns)];
  return out;
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "array":
      return Array.isArray(v);
    case "object":
      return !!v && typeof v === "object" && !Array.isArray(v);
    default:
      return true;
  }
}
