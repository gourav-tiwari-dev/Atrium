/**
 * Tailing a transcript broadcasts everything the agent saw, including anything
 * secret that got pasted into a session. This runs on every Turn before it
 * leaves the machine. It is a coarse net on purpose - a false positive costs a
 * masked string, a false negative leaks a key.
 */

type Rule = { re: RegExp; to: string } | { re: RegExp; fn: (...m: string[]) => string };

const RULES: Rule[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, to: 'sk-ant-***' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, to: 'sk-***' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: 'gh*_***' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: 'AKIA***' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: 'xox*-***' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, to: 'Bearer ***' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, to: '<jwt ***>' },
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: '<private key ***>',
  },
  // KEY=value / KEY: value, where the key name smells secret
  {
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*("[^"\n]{4,}"|'[^'\n]{4,}'|\S{4,})/gi,
    fn: (_full: string, key: string) => `${key}=***`,
  },
];

/** Marker a person can put in a prompt to keep that turn on their own machine. */
export const PRIVATE_MARKER = '#private';

export function isPrivate(text: string): boolean {
  return text.toLowerCase().includes(PRIVATE_MARKER);
}

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = 'to' in rule ? out.replace(rule.re, rule.to) : out.replace(rule.re, rule.fn);
  }
  return out;
}
