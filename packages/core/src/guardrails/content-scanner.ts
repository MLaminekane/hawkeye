/**
 * Content Scanner — PII detection and prompt injection/jailbreak detection.
 *
 * Inspired by IBM and Cloudflare AI guardrail frameworks.
 * Uses regex-based pattern matching for PII categories and known
 * prompt injection techniques.
 */

export interface PiiMatch {
  type: string; // 'ssn', 'credit_card', etc.
  value: string; // The matched text (redacted for logging)
  index: number; // Position in text
}

export interface ContentScanResult {
  piiMatches: PiiMatch[];
  promptInjection: boolean;
  injectionPatterns: string[]; // Which patterns matched
}

// ── PII regex patterns ──

const PII_PATTERNS: Record<string, RegExp> = {
  ssn: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g,
  credit_card:
    /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  api_key:
    /\b(?:sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[a-zA-Z0-9_-]{35}|ghp_[a-zA-Z0-9]{36}|xox[bprs]-[a-zA-Z0-9-]+)\b/g,
  ip_address: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  aws_secret: /\b[A-Za-z0-9/+=]{40}\b/g, // AWS secret keys (loose match — needs context)
  private_key: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
};

// ── Prompt injection patterns (common jailbreak techniques) ──

const INJECTION_PATTERNS: { name: string; pattern: RegExp }[] = [
  {
    name: 'ignore_instructions',
    pattern: /ignore (?:all |previous |prior |above |your )?instructions/i,
  },
  {
    name: 'new_instructions',
    pattern:
      /(?:new|override|replace|forget|disregard) (?:your |the )?(?:instructions|rules|guidelines|system prompt)/i,
  },
  {
    name: 'roleplay_bypass',
    pattern:
      /(?:you are|act as|pretend to be|imagine you are|roleplay as) (?:a |an )?(?:unrestricted|unfiltered|evil|DAN|jailbroken)/i,
  },
  {
    name: 'dan_jailbreak',
    pattern: /\bDAN\b.*(?:Do Anything Now|jailbreak)/i,
  },
  {
    name: 'developer_mode',
    pattern: /(?:developer|debug|admin|god) mode (?:enabled|activated|on)/i,
  },
  {
    name: 'system_prompt_extraction',
    pattern:
      /(?:show|reveal|print|output|display|repeat|tell me) (?:your |the )?(?:system prompt|instructions|initial prompt|hidden prompt)/i,
  },
  {
    name: 'encoding_bypass',
    pattern: /(?:base64|rot13|hex|binary|morse)[:\s]+(?:decode|encode|translate)/i,
  },
  {
    name: 'token_smuggling',
    pattern: /(?:split|separate|divide) (?:the |this |these )?(?:word|token|character)/i,
  },
];

/**
 * Scan text for PII and prompt injection patterns.
 *
 * @param text       The text to scan
 * @param categories Optional list of PII categories to check (all if omitted)
 * @returns          Scan result with PII matches and injection detection
 */
export function scanContent(text: string, categories?: string[]): ContentScanResult {
  const piiMatches: PiiMatch[] = [];
  const injectionPatterns: string[] = [];

  // PII scanning
  for (const [type, regex] of Object.entries(PII_PATTERNS)) {
    if (categories && !categories.includes(type)) continue;
    regex.lastIndex = 0; // Reset global regex
    let match;
    while ((match = regex.exec(text)) !== null) {
      piiMatches.push({
        type,
        value: redact(match[0]),
        index: match.index,
      });
    }
  }

  // Prompt injection scanning
  let promptInjection = false;
  for (const { name, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      promptInjection = true;
      injectionPatterns.push(name);
    }
  }

  return { piiMatches, promptInjection, injectionPatterns };
}

/**
 * Redact a matched value for safe logging.
 * Keeps first 2 and last 2 characters, replaces the rest with asterisks.
 */
function redact(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}
