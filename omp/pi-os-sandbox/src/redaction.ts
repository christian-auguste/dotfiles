/**
 * @fileoverview Credential redaction: env-variable scrubbing for child
 * processes and secret masking for logs and errors.
 */

export const CREDENTIAL_VAR_PATTERNS: RegExp[] = [
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN)$/i,
  /^AWS_.*(SECRET|SESSION)/i,
  /^GIT_ASKPASS$/i,
  /^GNUPGHOME$/i,
];

/**
 * Return a copy of env with credential variables removed, keeping SSH_AUTH_SOCK.
 * 
 * @param env environment to filter.
 * @param patterns variable-name matchers, defaults to the credential list.
 */
export function scrubEnv(
  env: Record<string, string | undefined>,
  patterns: RegExp[] = CREDENTIAL_VAR_PATTERNS,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !patterns.some((p) => p.test(name))),
  );
}

const REDACT_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}(?![0-9A-Z])|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{16,}|(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])|(?:secret|token|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi;

/**
 * Mask secret-shaped content with a fixed placeholder, revealing nothing.
 * 
 * @param value text to sanitize.
 */
export function redact(value: string): string {
  return value.replace(REDACT_PATTERN, "[redacted]");
}
