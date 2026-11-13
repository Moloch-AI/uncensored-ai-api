// Request validation for POST /chat/completions, with 422 messages in the
// style of the gateway's validator (shape B: {"message", "errors"}).
//
// What is checked: `model` (required, a known id), `messages` (required,
// non-empty list, every item has a `role` of system/user/assistant/tool),
// `temperature` (0..2), `top_p` (0..1), `max_tokens` (integer 1..65536; it is
// accepted but has no effect), `stream` (boolean). Unknown parameters such as
// `stop`, `n`, `seed` or `response_format` are ignored, as the gateway
// silently drops them.

import { MODEL_IDS } from './catalog.mjs';

export const ROLES = Object.freeze(['system', 'user', 'assistant', 'tool']);

/**
 * @param {unknown} body parsed JSON body ({} when the body was not JSON)
 * @returns {Record<string, string[]> | null} field errors, or null when valid
 */
export function validateChatRequest(body) {
  const input = isPlainObject(body) ? body : {};
  const errors = {};
  const add = (field, message) => {
    errors[field] ??= [];
    errors[field].push(message);
  };

  // model
  if (isMissing(input.model)) add('model', 'The model field is required.');
  else if (typeof input.model !== 'string') add('model', 'The model field must be a string.');
  else if (!MODEL_IDS.includes(input.model)) add('model', 'The selected model is invalid.');

  // messages
  const { messages } = input;
  if (isMissing(messages) || (Array.isArray(messages) && messages.length === 0)) {
    add('messages', 'The messages field is required.');
  } else if (!Array.isArray(messages)) {
    add('messages', 'The messages field must be an array.');
  } else {
    messages.forEach((message, i) => {
      const field = `messages.${i}.role`;
      const role = isPlainObject(message) ? message.role : undefined;
      if (isMissing(role)) add(field, `The ${field} field is required.`);
      else if (!ROLES.includes(role)) add(field, `The selected ${field} is invalid.`);
    });
  }

  numberInRange(input, 'temperature', 'temperature', 0, 2, add);
  numberInRange(input, 'top_p', 'top p', 0, 1, add);

  if (!isMissing(input.max_tokens)) {
    if (!Number.isInteger(input.max_tokens)) {
      add('max_tokens', 'The max tokens field must be an integer.');
    } else {
      rangeMessage(input.max_tokens, 'max_tokens', 'max tokens', 1, 65536, add);
    }
  }

  if (!isMissing(input.stream) && ![true, false, 0, 1, '0', '1'].includes(input.stream)) {
    add('stream', 'The stream field must be true or false.');
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

function numberInRange(input, field, label, min, max, add) {
  const raw = input[field];
  if (isMissing(raw)) return;
  // Like the gateway's `numeric` rule, numeric strings such as "0.5" pass.
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    add(field, `The ${label} field must be a number.`);
    return;
  }
  rangeMessage(value, field, label, min, max, add);
}

function rangeMessage(value, field, label, min, max, add) {
  if (value < min) add(field, `The ${label} field must be at least ${min}.`);
  else if (value > max) add(field, `The ${label} field must not be greater than ${max}.`);
}

/** Missing in the validator's sense: absent, null or an empty string. */
function isMissing(value) {
  return value === undefined || value === null || value === '';
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stream flag as the validator's boolean rule reads it. */
export function wantsStream(body) {
  return [true, 1, '1'].includes(body.stream);
}
