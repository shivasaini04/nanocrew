/**
 * Stage 57 — a small JSON-schema subset: enough to say what a worker must hand back, and
 * to check that it did. No dependency, no $ref, no remote schemas — a boss writes these
 * inline, and anything the checker does not understand is refused up front rather than
 * silently ignored at check time.
 */
export interface JsonSchema {
  type?:
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
}

const TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);
const KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'description',
]);

/** What is wrong with a schema, as sentences. Empty means usable. */
export function schemaProblems(s: unknown, path = '$', depth = 0): string[] {
  if (depth > 8) return [`${path}: nested too deep`];
  if (!s || typeof s !== 'object' || Array.isArray(s))
    return [`${path}: must be an object`];
  const o = s as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o))
    if (!KEYS.has(k)) out.push(`${path}: "${k}" is not supported`);
  if (o.type !== undefined && !TYPES.has(String(o.type)))
    out.push(`${path}: unknown type "${String(o.type)}"`);
  if (o.properties !== undefined) {
    if (typeof o.properties !== 'object' || o.properties === null)
      out.push(`${path}.properties: must be an object`);
    else
      for (const [k, v] of Object.entries(o.properties))
        out.push(...schemaProblems(v, `${path}.${k}`, depth + 1));
  }
  if (
    o.required !== undefined &&
    !(
      Array.isArray(o.required) &&
      o.required.every((x) => typeof x === 'string')
    )
  )
    out.push(`${path}.required: must be a list of names`);
  if (o.items !== undefined)
    out.push(...schemaProblems(o.items, `${path}[]`, depth + 1));
  if (o.enum !== undefined && !Array.isArray(o.enum))
    out.push(`${path}.enum: must be a list`);
  return out;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Where a value breaks a schema, as sentences. Empty means it conforms. */
export function validateAgainst(
  value: unknown,
  s: JsonSchema,
  path = '$',
): string[] {
  const out: string[] = [];
  const t = typeOf(value);
  if (s.type) {
    const ok = s.type === t || (s.type === 'number' && t === 'integer');
    if (!ok) return [`${path}: expected ${s.type}, got ${t}`];
  }
  if (
    s.enum &&
    !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  )
    out.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if (t === 'string') {
    const str = value as string;
    if (s.minLength !== undefined && str.length < s.minLength)
      out.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && str.length > s.maxLength)
      out.push(`${path}: longer than ${s.maxLength}`);
  }
  if (t === 'array') {
    const a = value as unknown[];
    if (s.minItems !== undefined && a.length < s.minItems)
      out.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && a.length > s.maxItems)
      out.push(`${path}: more than ${s.maxItems} items`);
    if (s.items)
      a.slice(0, 200).forEach((x, i) =>
        out.push(...validateAgainst(x, s.items!, `${path}[${i}]`)),
      );
  }
  if (t === 'object') {
    const o = value as Record<string, unknown>;
    for (const r of s.required ?? [])
      if (!(r in o) || o[r] === undefined || o[r] === null || o[r] === '')
        out.push(`${path}.${r}: missing`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) {
      if (k in o && o[k] !== undefined && o[k] !== null)
        out.push(...validateAgainst(o[k], sub, `${path}.${k}`));
    }
  }
  return out.slice(0, 20);
}
