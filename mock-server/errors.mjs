// Error bodies, in the three shapes the gateway uses.
//
//   A. Gateway error:   {"error": {"type": "...", "message": "...", ...extra}}
//   B. Validation 422:  {"message": "...", "errors": {"field": ["..."]}}
//   C. Bare message:    {"message": "..."}  (401, 429 rate limit, 403 has "code")
//
// Messages are written for people and can change. Clients must branch on the
// HTTP status, `error.type`, `code` and the extra fields, never on the text.

// Sent with refusals that cannot succeed on a retry (no plan, quota and session caps, context too
// large), as the gateway does. The official OpenAI SDKs obey it before their own retry rules.
export const NO_RETRY = Object.freeze({ 'X-Should-Retry': 'false' });

/** Shape A. */
export function gatewayError(type, message, extra = {}) {
  return { error: { type, message, ...extra } };
}

/** Shape B. `errors` maps a field name to a list of messages. */
export function validationError(errors) {
  const all = Object.values(errors).flat();
  const more = all.length - 1;
  const message = more > 0 ? `${all[0]} (and ${more} more error${more === 1 ? '' : 's'})` : all[0];
  return { message, errors };
}

/** Shape C. */
export function bareMessage(message, extra = {}) {
  return { message, ...extra };
}

export const UNAUTHENTICATED = bareMessage('Unauthenticated.');
export const TOO_MANY_ATTEMPTS = bareMessage('Too Many Attempts.');
export const NOT_FOUND = bareMessage('Not found.');

export const EMAIL_UNVERIFIED = bareMessage(
  'Verify your email to continue. Follow the link in the confirmation email, or resend it from the dashboard.',
  { code: 'email_unverified' },
);

export const NO_ACTIVE_PLAN = gatewayError(
  'no_active_plan',
  'This account has no active plan and no account credit. Buy a plan or add credit in the dashboard under Billing.',
  { plan: null },
);

/** The body Cloudflare returns when the origin takes too long (status 524). */
export const CLOUDFLARE_524_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>api.molochai.dev | 524: A timeout occurred</title></head>
<body>
<h1>A timeout occurred</h1>
<p>Error code 524. The origin web server timed out responding to this request.</p>
<p>This is a mock of the Cloudflare edge page. It is HTML, not JSON.</p>
</body>
</html>
`;
