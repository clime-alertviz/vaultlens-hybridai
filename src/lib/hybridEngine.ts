import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  type Part,
} from 'firebase/ai';
import {
  extractDocumentHeuristics,
  redactSensitiveText,
  restoreRedactedText,
  type ExtractedInvoice,
  type RedactionResult,
} from './privacy';

export type FirebaseClientConfig = {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  appId: string;
  appCheckSiteKey?: string;
  appCheckDebugToken?: string | boolean;
};

export type RoutingChoice = 'strict_local' | 'hybrid_prefer_local' | 'prefer_cloud';

export type ExecutionSource =
  | 'firebase_on_device'
  | 'firebase_in_cloud'
  | 'chrome_builtin_ai'
  | 'local_deterministic';

export type AnalysisOutput = {
  redaction: RedactionResult;
  extracted: ExtractedInvoice;
  source: ExecutionSource;
  latencyMs: number;
  estimatedCloudCostUsd: number;
  rawModelText: string | null;
  note: string;
};

type ChromeLanguageModelSession = {
  prompt: (text: string) => Promise<string>;
  destroy?: () => void;
};

type ChromeLanguageModelGlobal = {
  availability?: () => Promise<string>;
  create?: (opts?: { systemPrompt?: string }) => Promise<ChromeLanguageModelSession>;
};

function getChromeLanguageModel(): ChromeLanguageModelGlobal | null {
  const g = globalThis as unknown as {
    LanguageModel?: ChromeLanguageModelGlobal;
  };
  return g.LanguageModel ?? null;
}

export async function checkChromeNanoAvailability(): Promise<string> {
  const lm = getChromeLanguageModel();
  if (!lm || typeof lm.availability !== 'function') {
    return 'unavailable';
  }
  try {
    return await lm.availability();
  } catch {
    return 'unavailable';
  }
}

export function getEnvFirebaseConfig(): FirebaseClientConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  const siteKey = import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY;
  const debugToken = import.meta.env.VITE_FIREBASE_APP_CHECK_DEBUG_TOKEN;
  if (
    typeof apiKey === 'string' &&
    apiKey.trim() &&
    typeof projectId === 'string' &&
    projectId.trim() &&
    typeof appId === 'string' &&
    appId.trim()
  ) {
    return {
      apiKey: apiKey.trim(),
      projectId: projectId.trim(),
      appId: appId.trim(),
      authDomain:
        typeof import.meta.env.VITE_FIREBASE_AUTH_DOMAIN === 'string'
          ? import.meta.env.VITE_FIREBASE_AUTH_DOMAIN.trim()
          : undefined,
      appCheckSiteKey:
        typeof siteKey === 'string' && siteKey.trim() ? siteKey.trim() : undefined,
      appCheckDebugToken:
        typeof debugToken === 'string' && debugToken.trim()
          ? debugToken.trim() === 'true'
            ? true
            : debugToken.trim()
          : undefined,
    };
  }
  return null;
}

let appCheckInstance: AppCheck | null = null;
let initializedAppCheckKey: string | null = null;

export function getAppCheckStatus(
  cfg: FirebaseClientConfig | null
): 'active' | 'missing_site_key' | 'no_firebase' {
  if (!cfg) return 'no_firebase';
  return cfg.appCheckSiteKey && cfg.appCheckSiteKey.trim() ? 'active' : 'missing_site_key';
}

function getOrInitFirebaseApp(cfg: FirebaseClientConfig): FirebaseApp {
  const existing = getApps()[0];
  const app = existing ?? initializeApp(cfg);
  const siteKey = cfg.appCheckSiteKey?.trim();
  if (siteKey && (!appCheckInstance || initializedAppCheckKey !== siteKey)) {
    if (cfg.appCheckDebugToken !== undefined) {
      (
        globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
      ).FIREBASE_APPCHECK_DEBUG_TOKEN = cfg.appCheckDebugToken;
    }
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    initializedAppCheckKey = siteKey;
  }
  return app;
}

function toInferenceMode(choice: RoutingChoice): InferenceMode {
  switch (choice) {
    case 'strict_local':
      return InferenceMode.ONLY_ON_DEVICE;
    case 'hybrid_prefer_local':
      return InferenceMode.PREFER_ON_DEVICE;
    case 'prefer_cloud':
      return InferenceMode.PREFER_IN_CLOUD;
  }
}

function parseJsonObjectFromText(raw: string): Partial<ExtractedInvoice> | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return null;
    return obj as Partial<ExtractedInvoice>;
  } catch {
    return null;
  }
}

function mergeWithBaseline(
  baseline: ExtractedInvoice,
  parsed: Partial<ExtractedInvoice> | null,
  redaction: RedactionResult
): ExtractedInvoice {
  if (!parsed) return baseline;
  const restore = (val: unknown): string | null => {
    if (typeof val !== 'string' || !val.trim()) return null;
    return restoreRedactedText(val.trim(), redaction.entries);
  };
  const kind =
    parsed.documentKind === 'invoice' ||
    parsed.documentKind === 'contract' ||
    parsed.documentKind === 'statement' ||
    parsed.documentKind === 'general'
      ? parsed.documentKind
      : baseline.documentKind;

  const flags = Array.isArray(parsed.riskFlags)
    ? parsed.riskFlags
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => restoreRedactedText(f, redaction.entries))
    : baseline.riskFlags;

  return {
    vendor: restore(parsed.vendor) ?? baseline.vendor,
    ico: restore(parsed.ico) ?? baseline.ico,
    iban: restore(parsed.iban) ?? baseline.iban,
    amount: restore(parsed.amount) ?? baseline.amount,
    currency: restore(parsed.currency) ?? baseline.currency,
    dueDate: restore(parsed.dueDate) ?? baseline.dueDate,
    documentKind: kind,
    riskFlags: flags.length > 0 ? flags : baseline.riskFlags,
    summary: restore(parsed.summary) ?? baseline.summary,
  };
}

export function buildCloudSafeModelParts(params: {
  promptText: string;
  choice: RoutingChoice;
  imageBase64?: { data: string; mimeType: string } | null;
}): { parts: Array<string | Part>; withheldRawImageFromCloud: boolean } {
  const parts: Array<string | Part> = [params.promptText];
  if (params.imageBase64) {
    // Unredacted receipt/statement photos cannot be tokenized via text regexes.
    // Permit binary inlineData ONLY under Strict Local (ONLY_ON_DEVICE); block on hybrid/cloud routes.
    if (params.choice === 'strict_local') {
      parts.push({
        type: 'inlineData',
        inlineData: {
          data: params.imageBase64.data,
          mimeType: params.imageBase64.mimeType,
        },
      });
    } else {
      return { parts, withheldRawImageFromCloud: true };
    }
  }
  return { parts, withheldRawImageFromCloud: false };
}

export function prepareCloudSafePrompt(params: {
  rawText: string;
  redactedTextOverride?: string;
  choice: RoutingChoice;
}): {
  redaction: RedactionResult;
  outboundDocumentText: string;
  promptText: string;
} {
  const redaction = redactSensitiveText(params.rawText);
  const scrubbedText =
    typeof params.redactedTextOverride === 'string'
      ? params.redactedTextOverride
      : redaction.redactedText;

  const finalRedaction: RedactionResult = {
    ...redaction,
    redactedText: scrubbedText,
    bytesRedacted: new TextEncoder().encode(scrubbedText).length,
  };

  // Strict local keeps raw text on-device; hybrid/cloud paths ONLY see the reviewed scrubbed payload.
  const outboundDocumentText = params.choice === 'strict_local' ? params.rawText : scrubbedText;
  const promptText =
    `Extract structured JSON from this document. Return ONLY valid JSON with keys: ` +
    `vendor (string), ico (string|null), iban (string|null), amount (string|null), ` +
    `currency (string|null), dueDate (string|null), documentKind ("invoice"|"contract"|"statement"|"general"), ` +
    `riskFlags (string[]), summary (string).\n\nDocument:\n${outboundDocumentText}`;

  return { redaction: finalRedaction, outboundDocumentText, promptText };
}

export async function analyzeDocumentHybrid(params: {
  text: string;
  redactedTextOverride?: string;
  imageBase64?: { data: string; mimeType: string } | null;
  choice: RoutingChoice;
  firebaseConfig: FirebaseClientConfig | null;
}): Promise<AnalysisOutput> {
  const t0 = performance.now();
  const { redaction, promptText } = prepareCloudSafePrompt({
    rawText: params.text,
    redactedTextOverride: params.redactedTextOverride,
    choice: params.choice,
  });
  if (params.choice !== 'strict_local' && !redaction.redactedText.trim()) {
    throw new Error('Enter and approve the text to send before analyzing.');
  }
  const baseline = extractDocumentHeuristics(params.text);

  // 1. Try Firebase AI Logic hybrid inference if configured
  if (params.firebaseConfig) {
    try {
      const app = getOrInitFirebaseApp(params.firebaseConfig);
      const ai = getAI(app, { backend: new GoogleAIBackend() });
      const mode = toInferenceMode(params.choice);
      const model = getGenerativeModel(ai, {
        mode,
        inCloudParams: { model: 'gemini-2.5-flash' },
      });

      const { parts: contentParts, withheldRawImageFromCloud } = buildCloudSafeModelParts({
        promptText,
        choice: params.choice,
        imageBase64: params.imageBase64,
      });

      const result = await model.generateContent(contentParts);
      const rawText = result.response.text();
      const parsed = parseJsonObjectFromText(rawText);
      const extracted = mergeWithBaseline(baseline, parsed, redaction);
      const isCloud = result.response.inferenceSource === InferenceSource.IN_CLOUD;
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      const imgGuardNote = withheldRawImageFromCloud
        ? ' Raw receipt photo was withheld from cloud fallback to protect unmasked visual PII (switch to Strict Local to send images on-device).'
        : '';

      return {
        redaction,
        extracted,
        source: isCloud ? 'firebase_in_cloud' : 'firebase_on_device',
        latencyMs,
        estimatedCloudCostUsd: isCloud ? 0.0004 : 0,
        rawModelText: rawText,
        note: (isCloud
          ? `Executed via Firebase AI Logic cloud fallback using reviewed preflight text (${redaction.piiCount} matched identifier pattern(s) tokenized).`
          : 'Executed on-device via Firebase AI Logic + Chrome Gemini Nano ($0.00 cloud cost).') + imgGuardNote,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Firebase hybrid call failed';
      if (params.choice === 'strict_local') {
        const latencyMs = Math.max(1, Math.round(performance.now() - t0));
        return {
          redaction,
          extracted: baseline,
          source: 'local_deterministic',
          latencyMs,
          estimatedCloudCostUsd: 0,
          rawModelText: null,
          note: `Strict on-device fallback used deterministic local parser (${msg}).`,
        };
      }
    }
  }

  // 2. Try Chrome Built-in Prompt API directly if available without Firebase config
  const lm = getChromeLanguageModel();
  if (lm && typeof lm.availability === 'function' && typeof lm.create === 'function') {
    try {
      const avail = await lm.availability();
      if (avail === 'available' || avail === 'readily') {
        const session = await lm.create({
          systemPrompt: 'You are a precise invoice and contract extraction assistant. Output valid JSON only.',
        });
        const rawText = await session.prompt(promptText);
        session.destroy?.();
        const parsed = parseJsonObjectFromText(rawText);
        const extracted = mergeWithBaseline(baseline, parsed, redaction);
        const latencyMs = Math.max(1, Math.round(performance.now() - t0));
        return {
          redaction,
          extracted,
          source: 'chrome_builtin_ai',
          latencyMs,
          estimatedCloudCostUsd: 0,
          rawModelText: rawText,
          note: 'Executed locally via Chrome Built-in Gemini Nano ($0.00 cost, 0 bytes uploaded).',
        };
      }
    } catch {
      // Fall through cleanly to deterministic local baseline
    }
  }

  // 3. Deterministic zero-network local baseline
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));
  const imageHint = params.imageBase64
    ? ' Attached receipt image previewed locally — connect Firebase AI Logic config for multimodal Gemini vision.'
    : '';
  return {
    redaction,
    extracted: baseline,
    source: 'local_deterministic',
    latencyMs,
    estimatedCloudCostUsd: 0,
    rawModelText: null,
    note: (params.firebaseConfig
      ? 'Ran local deterministic extractor (on-device Chrome Gemini Nano unavailable in this browser).'
      : 'Ran local deterministic privacy parser. Connect Firebase AI Logic config or Chrome 139+ Nano for full LLM reasoning.') + imageHint,
  };
}
