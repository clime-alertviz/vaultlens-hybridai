export type RedactionEntry = {
  token: string;
  category: 'IBAN' | 'CZ_BANK' | 'EMAIL' | 'PHONE' | 'CZ_ID' | 'SECRET';
  original: string;
};

export type RedactionResult = {
  redactedText: string;
  entries: RedactionEntry[];
  bytesOriginal: number;
  bytesRedacted: number;
  piiCount: number;
};

export type ExtractedInvoice = {
  vendor: string;
  ico: string | null;
  iban: string | null;
  amount: string | null;
  currency: string | null;
  dueDate: string | null;
  documentKind: 'invoice' | 'contract' | 'statement' | 'general';
  riskFlags: string[];
  summary: string;
};

// Official ISO-13616 / SWIFT IBAN Registry lengths per country code.
// Using exact per-country lengths allows space/hyphen-grouped letters-only bank codes
// (e.g., "GB82 WEST 1234 5698 7654 32", "NL91 ABNA 0417 1643 00") while stopping cleanly
// before adjacent labels such as "EUR", "ICO", or "paid".
const IBAN_COUNTRY_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
  BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29,
  ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27,
  GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24,
  ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29,
  PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24,
  SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24,
  XK: 20,
};

export const SUPPORTED_PII_CATEGORIES = [
  'IBAN (ISO-13616 formatted or compact, any case)',
  'Czech bank account (prefix-number/bankCode)',
  'Czech birth/tax IDs (6 digits + /3-4 digits)',
  'Email addresses & phone numbers',
  'API key tokens (sk-, AIza, ghp_)',
] as const;

export function findIbanMatches(input: string): Array<{ start: number; end: number; match: string }> {
  const results: Array<{ start: number; end: number; match: string }> = [];
  const headRegex = /\b[A-Za-z]{2}\d{2}/g;
  let head: RegExpExecArray | null;
  let searchFrom = 0;

  while ((head = headRegex.exec(input)) !== null) {
    if (head.index < searchFrom) continue;
    const cc = head[0].slice(0, 2).toUpperCase();
    const expectedLen = IBAN_COUNTRY_LENGTHS[cc];
    const startIdx = head.index;
    const tailSlice = input.slice(startIdx, startIdx + 56);
    const groupRegex = /^[A-Za-z]{2}\d{2}(?:[ \t-]?[A-Za-z0-9]{1,30})*/;
    const rough = groupRegex.exec(tailSlice)?.[0];
    if (!rough) continue;

    // Walk chunk-by-chunk so we stop cleanly at expectedLen without swallowing trailing words.
    const tokens = [...rough.matchAll(/[A-Za-z0-9]+/g)];
    let compact = '';
    let candidateEndRel = -1;

    if (expectedLen !== undefined) {
      for (const tok of tokens) {
        const nextCompact = compact + tok[0];
        if (nextCompact.length <= expectedLen) {
          compact = nextCompact;
          candidateEndRel = (tok.index ?? 0) + tok[0].length;
          if (compact.length === expectedLen) break;
        } else {
          break;
        }
      }
      if (compact.length !== expectedLen) continue;
    } else {
      for (const tok of tokens) {
        // Unknown fallback: stop before standalone trailing label words once BBAN >= 15 chars
        if (compact.length >= 15 && !/\d/.test(tok[0])) break;
        const nextCompact = compact + tok[0];
        if (nextCompact.length > 34) break;
        compact = nextCompact;
        candidateEndRel = (tok.index ?? 0) + tok[0].length;
      }
      if (compact.length < 15 || compact.length > 34) continue;
    }

    // Check word boundary after end offset and ensure BBAN has digits (avoids pure prose matches).
    const absEnd = startIdx + candidateEndRel;
    if (absEnd < input.length && /[A-Za-z0-9]/.test(input[absEnd]!)) continue;
    if (!/\d/.test(compact.slice(4))) continue;

    results.push({
      start: startIdx,
      end: absEnd,
      match: input.slice(startIdx, absEnd),
    });
    searchFrom = absEnd;
  }
  return results;
}

const REGEX_PATTERNS: Array<{
  category: Exclude<RedactionEntry['category'], 'IBAN'>;
  regex: RegExp;
}> = [
  {
    category: 'SECRET',
    regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/g,
  },
  {
    category: 'CZ_BANK',
    regex: /\b(?:\d{1,6}-)?\d{2,10}\/\d{4}\b/g,
  },
  {
    category: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: 'PHONE',
    regex: /(?<!\w)\+?\d{1,3}[ \t.-]?\d{3}[ \t.-]?\d{3}[ \t.-]?\d{3,4}\b/g,
  },
  {
    category: 'CZ_ID',
    regex: /\b\d{6}\/\d{3,4}\b/g,
  },
];

export function redactSensitiveText(input: string): RedactionResult {
  let working = input;
  const entries: RedactionEntry[] = [];
  const counters: Record<RedactionEntry['category'], number> = {
    IBAN: 0,
    CZ_BANK: 0,
    EMAIL: 0,
    PHONE: 0,
    CZ_ID: 0,
    SECRET: 0,
  };
  const seen = new Map<string, string>();
  const alloc = (category: RedactionEntry['category'], match: string): string => {
    const existing = seen.get(`${category}:${match}`);
    if (existing) return existing;
    counters[category] += 1;
    const token = `[${category}_${counters[category]}]`;
    seen.set(`${category}:${match}`, token);
    entries.push({ token, category, original: match });
    return token;
  };

  // 1. Mask Secrets first so token contents can't collide with other patterns
  working = working.replace(REGEX_PATTERNS[0]!.regex, (m) => alloc('SECRET', m));

  // 2. Mask formatted & compact IBANs via exact country-length aware scanner
  const ibanMatches = findIbanMatches(working);
  if (ibanMatches.length > 0) {
    let out = '';
    let cursor = 0;
    for (const im of ibanMatches) {
      out += working.slice(cursor, im.start) + alloc('IBAN', im.match);
      cursor = im.end;
    }
    working = out + working.slice(cursor);
  }

  // 3. Mask CZ bank accounts, emails, phone numbers, and birth/tax IDs
  for (const { category, regex } of REGEX_PATTERNS.slice(1)) {
    working = working.replace(regex, (m) => alloc(category, m));
  }

  return {
    redactedText: working,
    entries,
    bytesOriginal: new TextEncoder().encode(input).length,
    bytesRedacted: new TextEncoder().encode(working).length,
    piiCount: entries.length,
  };
}

export function restoreRedactedText(
  text: string,
  entries: RedactionEntry[]
): string {
  let out = text;
  for (const e of entries) {
    out = out.split(e.token).join(e.original);
  }
  return out;
}

export function extractDocumentHeuristics(input: string): ExtractedInvoice {
  const lower = input.toLowerCase();
  const ibanMatch = findIbanMatches(input)[0]?.match ?? null;
  const icoMatch = input.match(/\bI[ČC]O\s*[:#]?\s*(\d{8})\b/i);
  const amountMatch = input.match(
    /(?:total|celkem|k úhradě|amount|balance|price|cena)[ \t]*[:=]?[ \t]*([0-9][0-9 \t.,]*)[ \t]*(CZK|Kč|EUR|USD|€|\$)?/i
  );
  const dueMatch = input.match(
    /(?:due\s*date|splatnost|payable\s*by)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/i
  );
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  let documentKind: ExtractedInvoice['documentKind'] = 'general';
  if (lower.includes('invoice') || lower.includes('faktura') || lower.includes('splatnost')) {
    documentKind = 'invoice';
  } else if (
    lower.includes('agreement') ||
    lower.includes('nda') ||
    lower.includes('contract') ||
    lower.includes('smlouva') ||
    lower.includes('liability')
  ) {
    documentKind = 'contract';
  } else if (lower.includes('balance') || lower.includes('account number') || lower.includes('iban')) {
    documentKind = 'statement';
  }

  const riskFlags: string[] = [];
  if (lower.includes('auto-renew') || lower.includes('automatic renewal')) {
    riskFlags.push('Auto-renewal clause detected — review cancellation notice window.');
  }
  if (lower.includes('unlimited liability') || lower.includes('indemnify')) {
    riskFlags.push('Broad liability / indemnification language present.');
  }
  if (lower.includes('penalty') || lower.includes('smluvní pokuta') || lower.includes('úrok z prodlení')) {
    riskFlags.push('Late fee or contractual penalty clause detected.');
  }
  if (lower.includes('non-compete') || lower.includes('exclusiv')) {
    riskFlags.push('Exclusivity / non-compete restriction flagged.');
  }

  const rawCurrency = amountMatch?.[2] ?? null;
  const currency =
    rawCurrency === 'Kč'
      ? 'CZK'
      : rawCurrency === '€'
        ? 'EUR'
        : rawCurrency === '$'
          ? 'USD'
          : rawCurrency?.toUpperCase() ?? null;

  return {
    vendor: lines[0]?.slice(0, 64) ?? 'Local Document',
    ico: icoMatch?.[1] ?? null,
    iban: ibanMatch ? ibanMatch.replace(/\s+/g, ' ') : null,
    amount: amountMatch?.[1]?.trim() ?? null,
    currency,
    dueDate: dueMatch?.[1] ?? null,
    documentKind,
    riskFlags,
    summary: `Classified as ${documentKind} (${lines.length} lines). ${riskFlags.length > 0 ? `${riskFlags.length} risk flag(s) found.` : 'No critical clause flags detected by local scan.'}`,
  };
}

export function buildSpdPaymentString(params: {
  iban: string;
  bic: string;
  amountCzk: number;
  vs: string;
  message: string;
  recipientName: string;
}): string {
  const acc = `${params.iban.replace(/\s+/g, '')}+${params.bic.replace(/\s+/g, '')}`;
  const amt = params.amountCzk.toFixed(2);
  const msg = params.message.replace(/\*/g, ' ').slice(0, 60);
  const rn = params.recipientName.replace(/\*/g, ' ').slice(0, 35);
  return `SPD*1.0*ACC:${acc}*AM:${amt}*CC:CZK*RN:${rn}*X-VS:${params.vs}*MSG:${msg}`;
}

export function buildSepaEpcPaymentString(params: {
  iban: string;
  bic: string;
  amountEur: number;
  ref: string;
  message: string;
  recipientName: string;
}): string {
  const iban = params.iban.replace(/\s+/g, '').toUpperCase();
  const bic = params.bic.replace(/\s+/g, '').toUpperCase();
  const rn = params.recipientName.slice(0, 70);
  const cleanRef = params.ref.trim().slice(0, 35);
  const cleanMsg = params.message.trim().slice(0, 140);
  if (!Number.isFinite(params.amountEur) || params.amountEur < 0.01 || params.amountEur > 999999999.99) {
    throw new Error('EPC EUR amount must be between 0.01 and 999999999.99');
  }
  // EPC069-12 v3.1: Structured reference (line 10) and unstructured text (line 11) are mutually exclusive; omit trailing empty lines.
  const line10 = cleanMsg ? '' : cleanRef;
  const line11 = cleanMsg;
  const lines = [
    'BCD',
    '002',
    '1',
    'SCT',
    bic,
    rn,
    iban,
    `EUR${params.amountEur.toFixed(2)}`,
    '',
    line10,
    line11,
  ];
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const payload = lines.join('\n');
  if (new TextEncoder().encode(payload).length > 331) {
    throw new Error('EPC069-12 payload exceeds maximum 331 UTF-8 bytes');
  }
  return payload;
}

export function buildAccountingCsv(items: ExtractedInvoice[]): string {
  const esc = (v: string | null) => {
    const s = (v ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };
  const header = ['Kind', 'Vendor', 'ICO', 'IBAN', 'Amount', 'Currency', 'DueDate', 'RiskFlags', 'Summary'];
  const rows = items.map((it) =>
    [
      esc(it.documentKind),
      esc(it.vendor),
      esc(it.ico),
      esc(it.iban),
      esc(it.amount),
      esc(it.currency),
      esc(it.dueDate),
      esc(it.riskFlags.join(' | ')),
      esc(it.summary),
    ].join(',')
  );
  return [header.join(','), ...rows].join('\n');
}
