// Build a placeholder value that matches a JSON Schema.
//
// The mock uses this for two things: tool-call arguments (built from the
// tool's `parameters` schema) and JSON replies (when a prompt carries a
// ```json fenced schema). It is deliberately small. Rules:
//
//   enum      -> the first enum value
//   string    -> "example"
//   number    -> 1
//   integer   -> 1
//   boolean   -> true
//   null      -> null
//   array     -> one generated item (from `items`)
//   object    -> every key in `properties`, generated recursively
//
// Only `properties` is considered for objects (no `required`,
// `additionalProperties`, `$ref`, `oneOf`/`anyOf`/`allOf`). A `type` list such
// as ["string", "null"] uses the first non-null type. A schema without `type`
// is treated as an object when it has `properties` and as an array when it
// has `items`.

const MAX_DEPTH = 32;

export function schemaInstance(schema, depth = 0) {
  if (!isObject(schema) || depth > MAX_DEPTH) return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (schemaType(schema)) {
    case 'string':
      return 'example';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [schemaInstance(schema.items, depth + 1)];
    case 'object': {
      const out = {};
      const props = isObject(schema.properties) ? schema.properties : {};
      for (const [key, sub] of Object.entries(props)) {
        out[key] = schemaInstance(sub, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

function schemaType(schema) {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((t) => t !== 'null') ?? 'null';
  if (isObject(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return null;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Find the last ```json fenced block in `text` that parses as a JSON Schema
 * object with `properties`. Returns the schema or null.
 */
export function findJsonSchemaBlock(text) {
  const fence = /```json[^\S\n]*\n([\s\S]*?)```/g;
  let found = null;
  for (const match of text.matchAll(fence)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isObject(parsed) && isObject(parsed.properties)) found = parsed;
    } catch {
      // Not JSON: not a schema block. Keep looking.
    }
  }
  return found;
}
