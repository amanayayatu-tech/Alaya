const SECRET_KEY_RE = /(authorization|cookie|set-cookie|api[_-]?key|token|secret|password|private[_-]?key|webhook[_-]?secret|database[_-]?url|dsn)$/i;
const PHONE_LIKE_RE = /(^|[^\w])(\+?\d[\d\s().-]{8,}\d)(?![\w])/g;

function redactPhoneLikeText(input: string): string {
  return input.replace(PHONE_LIKE_RE, (_match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/g, "");
    const separatorCount = (candidate.match(/[\s().-]/g) ?? []).length;
    if (digits.length < 10 || digits.length > 15) return `${prefix}${candidate}`;
    if (!candidate.includes("+") && separatorCount < 2) return `${prefix}${candidate}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate.trim())) return `${prefix}${candidate}`;
    return `${prefix}[redacted-phone]`;
  });
}

export function redactSensitiveText(input: string): string {
  return redactPhoneLikeText(input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\b(?:Authorization|authorization)\s*:\s*Bearer\s+[A-Za-z0-9._~+\/=-]+/g, "Authorization: Bearer [redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/g, "Bearer [redacted-token]")
    .replace(/\b(?:Cookie|cookie|Set-Cookie|set-cookie)\s*:\s*[^\r\n]+/g, "Cookie: [redacted-cookie]")
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/([^:\s/@]+):([^@\s]+)@/gi, (match) => {
      const scheme = match.slice(0, match.indexOf("://"));
      return `${scheme}://[redacted-user]:[redacted-password]@`;
    })
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|xox[abprs])_[A-Za-z0-9_\-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(?:api[_-]?key|token|password|secret|webhook[_-]?secret)\s*[:=]\s*["']?[^"'\s,}]{6,}/gi, (match) => {
      const key = match.split(/[:=]/)[0];
      return `${key}=[redacted-secret]`;
    }));
}

export function redactSensitiveData<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted-secret]" : redactSensitiveData(item);
    }
    return out as T;
  }
  return value;
}

export function redactError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSensitiveText(error.message),
      stack: error.stack ? redactSensitiveText(error.stack) : undefined,
    };
  }
  return { message: redactSensitiveText(String(error)) };
}
