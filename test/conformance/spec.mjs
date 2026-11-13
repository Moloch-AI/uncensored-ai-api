// Load openapi.yaml and compile its schemas with Ajv (JSON Schema 2020-12,
// which is what OpenAPI 3.1 uses).

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

export const spec = parse(readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date-time', (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s));

/** Rewrite OpenAPI component refs into refs to one Ajv schema with $id "spec". */
function rewriteRefs(schema) {
  return JSON.parse(JSON.stringify(schema).replaceAll('"#/components/schemas/', '"spec#/$defs/'));
}

ajv.addSchema({ $id: 'spec', $defs: rewriteRefs(spec.components.schemas) });

const compiled = new Map();

/** A validator for a named component schema. */
export function componentValidator(name) {
  const validate = ajv.getSchema(`spec#/$defs/${name}`);
  if (!validate) throw new Error(`no schema ${name} in openapi.yaml`);
  return validate;
}

/** Resolve a response object, following a $ref into components.responses. */
function resolveResponse(response) {
  if (response?.$ref) {
    const name = response.$ref.replace('#/components/responses/', '');
    return spec.components.responses[name];
  }
  return response;
}

export function operation(method, path) {
  const op = spec.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`no operation ${method} ${path} in openapi.yaml`);
  return op;
}

/** The documented response for a status (not falling back to default). */
export function documentedResponse(method, path, status) {
  const response = operation(method, path).responses[String(status)];
  return response ? resolveResponse(response) : undefined;
}

/** A validator for the body schema of a documented response. */
export function responseValidator(method, path, status, mediaType) {
  const key = `${method} ${path} ${status} ${mediaType}`;
  if (compiled.has(key)) return compiled.get(key);
  const response = documentedResponse(method, path, status);
  const schema = response?.content?.[mediaType]?.schema;
  if (!schema) throw new Error(`${key} is not documented in openapi.yaml`);
  const validate = ajv.compile(rewriteRefs(schema));
  compiled.set(key, validate);
  return validate;
}

/** The schema every SSE data payload must match ($defs/event of the stream schema). */
export function streamEventValidator() {
  const schema = documentedResponse('POST', '/chat/completions', 200).content['text/event-stream'].schema;
  return ajv.compile(rewriteRefs(schema.$defs.event));
}

export function formatErrors(validate) {
  return ajv.errorsText(validate.errors, { separator: '\n' });
}
