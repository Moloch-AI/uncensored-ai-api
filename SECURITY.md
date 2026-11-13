# Security policy

## Reporting a vulnerability in this repository

Report vulnerabilities in the code in this repository (the mock server, the
reference clients, the examples, the CI configuration) through GitHub private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for a security
problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. Follow-up happens in the private advisory GitHub creates for your report.

## Problems with the hosted API

Security problems with the hosted MolochAI API, the dashboard or an account are
not handled in this repository. Report them through
[molochai.dev/contact](https://molochai.dev/contact?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api).

## API keys

Never post an API key in an issue, a pull request, a log or a screenshot. If a
key was exposed, revoke it in the dashboard (Account, API keys) and create a new
one: keys are not scoped and do not expire on a timer.

## Scope notes

- The mock server is a local test double. It accepts any token and binds to
  `127.0.0.1` by default. Exposing it on a public interface is not a supported
  setup.
- The reference clients are meant to be copied. A fix here does not reach a
  copy in your project; watch the repository's releases if you copied one.
