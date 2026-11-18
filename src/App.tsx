import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  FileText,
  Lock,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
  Zap,
} from 'lucide-react';
import {
  analyzeDocumentHybrid,
  checkChromeNanoAvailability,
  getAppCheckStatus,
  getEnvFirebaseConfig,
  type AnalysisOutput,
  type FirebaseClientConfig,
  type RoutingChoice,
} from './lib/hybridEngine';
import {
  buildAccountingCsv,
  buildSepaEpcPaymentString,
  buildSpdPaymentString,
  redactSensitiveText,
  SUPPORTED_PII_CATEGORIES,
  type ExtractedInvoice,
} from './lib/privacy';

const paymentIban = (import.meta.env.VITE_VAULTLENS_PAYMENT_IBAN ?? '').replace(/\s/g, '');
const domesticAccount = import.meta.env.VITE_VAULTLENS_DOMESTIC_ACCOUNT ?? '';

const SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'Czech Invoice + IBAN',
    text: `CloudOps Demo s.r.o.
ICO: 00000000
Invoice #2026-1142
IBAN: CZ65 0800 0000 1920 0014 5399
Account: 19-2000145399/0800
Contact: billing@example.cz | +420 600 000 001
Due Date: 2026-12-05
Total: 18 450 CZK
Note: Includes smluvní pokuta 0.1% per day overdue.`,
  },
  {
    label: 'SaaS Vendor NDA',
    text: `Master Data Processing & SaaS Agreement — Acme Analytics Ltd.
Contact: legal@acmeanalytics.example | +1 415 555 0192
Fee: 2,400 USD annually
Due Date: 2026-11-30
Clause 7: This agreement includes automatic renewal unless canceled 90 days before term end.
Clause 11: Customer agrees to unlimited liability and broad indemnification for third-party API claims.`,
  },
  {
    label: 'OSVČ Bank Snippet',
    text: `CSOB Statement — Jan Novak (Synthetic Demo)
Account number: 19-2000145399/0800
IBAN: cz65 0800 0000 1920 0014 5399
ICO: 00000000
Balance: 5 000.00 CZK
Internal key sample: sk-test-1234567890abcdef1234`,
  },
];

const STORAGE_CFG_KEY = 'vaultlens_firebase_cfg_v1';

export function App() {
  const [inputText, setInputText] = useState<string>(SAMPLES[0]!.text);
  const [routing, setRouting] = useState<RoutingChoice>('hybrid_prefer_local');
  const baseRedaction = useMemo(() => redactSensitiveText(inputText), [inputText]);
  const [preflightDraft, setPreflightDraft] = useState<string>(() =>
    redactSensitiveText(SAMPLES[0]!.text).redactedText
  );
  const [preflightApproved, setPreflightApproved] = useState<boolean>(false);
  const [imageAttachment, setImageAttachment] = useState<{
    name: string;
    data: string;
    mimeType: string;
    previewUrl: string;
  } | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [result, setResult] = useState<AnalysisOutput | null>(null);
  const [savedBatch, setSavedBatch] = useState<
    Array<{ id: string; source: AnalysisOutput['source']; item: ExtractedInvoice }>
  >([]);
  const [chromeNanoStatus, setChromeNanoStatus] = useState<string>('checking');
  const [showArchGuide, setShowArchGuide] = useState<boolean>(false);
  const [copiedFlag, setCopiedFlag] = useState<boolean>(false);

  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showProModal, setShowProModal] = useState<boolean>(false);
  const [proPayMode, setProPayMode] = useState<'czk' | 'sepa'>('czk');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [cfgJsonInput, setCfgJsonInput] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_CFG_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [cfgError, setCfgError] = useState<string>('');

  const firebaseConfig: FirebaseClientConfig | null = useMemo(() => {
    const envCfg = getEnvFirebaseConfig();
    if (envCfg) return envCfg;
    if (!cfgJsonInput.trim()) return null;
    try {
      const parsed = JSON.parse(cfgJsonInput) as Partial<FirebaseClientConfig>;
      if (parsed.apiKey && parsed.projectId && parsed.appId) {
        return {
          apiKey: parsed.apiKey,
          projectId: parsed.projectId,
          appId: parsed.appId,
          authDomain: parsed.authDomain,
          appCheckSiteKey: parsed.appCheckSiteKey,
          appCheckDebugToken: parsed.appCheckDebugToken,
        };
      }
    } catch {
      // Handled when saving
    }
    return null;
  }, [cfgJsonInput]);

  useEffect(() => {
    setPreflightDraft(baseRedaction.redactedText);
    setPreflightApproved(false);
  }, [baseRedaction.redactedText]);

  const appCheckStatus = useMemo(
    () => getAppCheckStatus(firebaseConfig),
    [firebaseConfig]
  );

  useEffect(() => {
    void checkChromeNanoAvailability().then(setChromeNanoStatus);
  }, []);

  const spdString = useMemo(
    () => {
      if (!paymentIban) return '';
      return proPayMode === 'sepa'
        ? buildSepaEpcPaymentString({
            iban: paymentIban,
            bic: 'CEKOCZPP',
            amountEur: 12,
            ref: '2026111701',
            message: 'VaultLens Pro Pass',
            recipientName: 'Michal Novotny',
          })
        : buildSpdPaymentString({
            iban: paymentIban,
            bic: 'CEKOCZPP',
            amountCzk: 299,
            vs: '2026111701',
            message: 'VaultLens Pro Pass',
            recipientName: 'Michal Novotny',
          });
    },
    [proPayMode]
  );

  useEffect(() => {
    if (!showProModal) return;
    void QRCode.toDataURL(spdString, { width: 220, margin: 1 }).then(setQrDataUrl);
  }, [showProModal, spdString]);

  const handleAnalyze = async () => {
    if (!inputText.trim() && !imageAttachment) return;
    if (routing !== 'strict_local' && !preflightApproved) return;
    setRunning(true);
    try {
      const out = await analyzeDocumentHybrid({
        text: inputText,
        redactedTextOverride: preflightDraft,
        imageBase64: imageAttachment
          ? { data: imageAttachment.data, mimeType: imageAttachment.mimeType }
          : null,
        choice: routing,
        firebaseConfig,
      });
      setResult(out);
      setSavedBatch((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          source: out.source,
          item: out.extracted,
        },
        ...prev.slice(0, 19),
      ]);
    } finally {
      setRunning(false);
    }
  };

  const handleImageUpload = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = res.indexOf(',');
      if (commaIdx !== -1) {
        setImageAttachment({
          name: file.name,
          mimeType: file.type || 'image/png',
          data: res.slice(commaIdx + 1),
          previewUrl: res,
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleExportCsv = () => {
    const items =
      savedBatch.length > 0
        ? savedBatch.map((b) => b.item)
        : result
          ? [result.extracted]
          : [];
    if (items.length === 0) return;
    const csv = buildAccountingCsv(items);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaultlens-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveConfig = () => {
    if (!cfgJsonInput.trim()) {
      localStorage.removeItem(STORAGE_CFG_KEY);
      setCfgError('');
      setShowSettings(false);
      return;
    }
    try {
      const parsed = JSON.parse(cfgJsonInput) as Partial<FirebaseClientConfig>;
      if (!parsed.apiKey || !parsed.projectId || !parsed.appId) {
        setCfgError('JSON must include apiKey, projectId, and appId.');
        return;
      }
      localStorage.setItem(STORAGE_CFG_KEY, cfgJsonInput.trim());
      setCfgError('');
      setShowSettings(false);
    } catch {
      setCfgError('Invalid JSON format.');
    }
  };

  const totalSavedUsd = useMemo(
    () => (savedBatch.length * 0.0004).toFixed(4),
    [savedBatch.length]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top Navbar */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-400 text-slate-950 shadow">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-extrabold tracking-tight text-white">
                  VaultLens Hybrid AI
                </h1>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300 ring-1 ring-emerald-500/30">
                  Firebase AI Logic
                </span>
              </div>
              <p className="text-xs text-slate-400">
                On-Device PII Redaction + Cloud Fallback Document Desk
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300">
              App Check:{' '}
              <strong
                className={
                  appCheckStatus === 'active'
                    ? 'text-emerald-400'
                    : appCheckStatus === 'missing_site_key'
                      ? 'text-amber-300'
                      : 'text-slate-400'
                }
              >
                {appCheckStatus === 'active'
                  ? 'ReCaptchaV3 Active'
                  : appCheckStatus === 'missing_site_key'
                    ? 'Site Key Needed'
                    : 'Local Only'}
              </strong>
            </span>
            <span className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300">
              Chrome Nano:{' '}
              <strong
                className={
                  chromeNanoStatus === 'available' || chromeNanoStatus === 'readily'
                    ? 'text-emerald-400'
                    : 'text-amber-300'
                }
              >
                {chromeNanoStatus}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => setShowArchGuide((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-slate-700"
            >
              <Cpu className="h-3.5 w-3.5" />
              {showArchGuide ? 'Hide Architecture' : 'Hybrid Architecture'}
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              <Settings className="h-3.5 w-3.5" />
              {firebaseConfig ? 'Firebase Connected' : 'Setup Firebase'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (paymentIban) setShowProModal(true);
                else window.open('https://alertviz.com/vaultlens/', '_blank', 'noopener,noreferrer');
              }}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-gradient-to-r from-amber-400 to-emerald-400 px-3 py-1.5 text-xs font-black text-slate-950 shadow hover:brightness-105"
            >
              <Zap className="h-3.5 w-3.5" />
              Pro Batch Pass (299 CZK)
            </button>
          </div>
        </div>
      </header>

      {showArchGuide && (
        <section className="mx-auto mt-4 max-w-6xl px-4">
          <div className="rounded-2xl border border-cyan-500/30 bg-slate-900/80 p-4 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-cyan-300">
                Client-Redacted Hybrid Pipeline (#BuildHybridAI 2026)
              </h2>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText('chrome://flags/#prompt-api-for-gemini-nano');
                  setCopiedFlag(true);
                  setTimeout(() => setCopiedFlag(false), 1800);
                }}
                className="cursor-pointer rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20"
              >
                {copiedFlag
                  ? 'Copied chrome://flags URL!'
                  : 'Copy chrome://flags/#prompt-api-for-gemini-nano'}
              </button>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-slate-300 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <div className="font-bold text-white">1. On-Device PII Vault</div>
                <p className="mt-1 text-[11px] text-slate-400">
                  IBANs, Czech accounts, IDs, emails, phones, and API keys are masked in RAM before any network call.
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <div className="font-bold text-white">2. Firebase AI Logic Router</div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Switches live between <code className="text-cyan-300">ONLY_ON_DEVICE</code>,{' '}
                  <code className="text-cyan-300">PREFER_ON_DEVICE</code>, and masked{' '}
                  <code className="text-cyan-300">PREFER_IN_CLOUD</code> (Gemini 2.5 Flash).
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <div className="font-bold text-white">3. Local Restore &amp; Batch Export</div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Placeholders stay masked across cloud inference and rehydrate only inside your browser for Accounting CSV export.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-6 lg:grid-cols-12">
        {/* Left Column: Input + Routing */}
        <section className="flex flex-col gap-4 lg:col-span-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300">
                <FileText className="h-4 w-4 text-cyan-400" />
                Sensitive Document Input
              </span>
              <div className="flex flex-wrap gap-1.5">
                {SAMPLES.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setInputText(s.text)}
                    className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-cyan-500/50 hover:text-white"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              rows={9}
              placeholder="Paste invoice, NDA, receipt, or Czech bank statement here..."
              className="w-full rounded-xl border border-slate-700/80 bg-slate-950 p-3 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none"
            />

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-slate-700 bg-slate-950/60 px-3 py-1.5 text-xs text-slate-300 hover:border-cyan-400">
                <Upload className="h-3.5 w-3.5 text-cyan-400" />
                {imageAttachment ? imageAttachment.name : 'Attach Receipt / Invoice Image (Strict Local Only)'}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => handleImageUpload(e.target.files?.[0])}
                />
              </label>
              {imageAttachment && (
                <div className="flex items-center gap-2">
                  <img
                    src={imageAttachment.previewUrl}
                    alt={imageAttachment.name}
                    className="h-9 w-9 rounded-lg border border-slate-700 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setImageAttachment(null)}
                    className="cursor-pointer text-xs text-rose-400 hover:underline"
                  >
                    Remove image
                  </button>
                </div>
              )}
            </div>
            <div className="mt-1.5 rounded-xl border border-slate-800 bg-slate-950/70 p-2.5 text-[11px] leading-snug text-slate-400">
              <div className="font-semibold text-slate-300">Auto-Masked Identifier Scope:</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {SUPPORTED_PII_CATEGORIES.map((cat) => (
                  <li key={cat}>{cat}</li>
                ))}
              </ul>
              <div className="mt-1 text-amber-300/90">
                Not auto-masked: unstructured names, street addresses, amounts, or custom secrets — edit the preflight payload below before allowing cloud routing. Receipt images stay on-device only (<code>ONLY_ON_DEVICE</code>).
              </div>
            </div>

            {/* Editable Preflight Redaction Boundary BEFORE any network inference */}
            <div className="mt-4 rounded-xl border border-cyan-500/30 bg-slate-950/80 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label
                  htmlFor="preflightPayload"
                  className="text-[11px] font-bold uppercase tracking-wider text-cyan-300"
                >
                  Preflight Cloud-Safe Payload (Editable Before Dispatch)
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">
                    {baseRedaction.piiCount} auto-masked token(s)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setPreflightDraft(baseRedaction.redactedText);
                      setPreflightApproved(false);
                    }}
                    className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-200 hover:border-cyan-400"
                  >
                    Reset Scrub
                  </button>
                </div>
              </div>
              <textarea
                id="preflightPayload"
                value={preflightDraft}
                onChange={(e) => {
                  setPreflightDraft(e.target.value);
                  setPreflightApproved(false);
                }}
                rows={5}
                className="w-full rounded-lg border border-slate-800 bg-slate-900/80 p-2 font-mono text-[11px] text-slate-200 focus:border-cyan-400 focus:outline-none"
              />
              {routing !== 'strict_local' && (
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={preflightApproved}
                    onChange={(e) => setPreflightApproved(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-emerald-400"
                  />
                  <span>
                    I reviewed and edited the preflight payload above; approve sending only this redacted text if inference falls back to cloud.
                  </span>
                </label>
              )}
            </div>

            {/* Inference Routing Selector */}
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Firebase AI Logic Inference Mode
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    {
                      id: 'strict_local',
                      title: 'Strict Local',
                      sub: 'ONLY_ON_DEVICE',
                      icon: Lock,
                    },
                    {
                      id: 'hybrid_prefer_local',
                      title: 'Hybrid Smart',
                      sub: 'PREFER_ON_DEVICE',
                      icon: Cpu,
                    },
                    {
                      id: 'prefer_cloud',
                      title: 'Cloud Masked',
                      sub: 'PREFER_IN_CLOUD',
                      icon: Cloud,
                    },
                  ] as const
                ).map((mode) => {
                  const Icon = mode.icon;
                  const active = routing === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => {
                        setRouting(mode.id);
                        if (mode.id !== 'strict_local') setPreflightApproved(false);
                      }}
                      className={`flex cursor-pointer flex-col items-start rounded-xl border p-2.5 text-left transition ${
                        active
                          ? 'border-cyan-400 bg-cyan-500/10 text-white'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <Icon className="mb-1 h-4 w-4 text-cyan-400" />
                      <span className="text-xs font-bold">{mode.title}</span>
                      <span className="font-mono text-[9px] text-slate-400">{mode.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              disabled={running || (routing !== 'strict_local' && !preflightApproved)}
              onClick={() => {
                void handleAnalyze();
              }}
              className="mt-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-emerald-400 py-2.5 text-sm font-black text-slate-950 shadow-lg transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {running
                ? 'Running Hybrid Inference...'
                : routing !== 'strict_local' && !preflightApproved
                  ? 'Approve Preflight Payload Above to Run'
                  : 'Send Approved Payload & Analyze'}
            </button>
          </div>
        </section>

        {/* Right Column: Telemetry, Redaction Vault, Extracted Fields */}
        <section className="flex flex-col gap-4 lg:col-span-6">
          {!result ? (
            <div className="flex h-full min-h-[340px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-6 text-center">
              <ShieldCheck className="mb-3 h-10 w-10 text-emerald-400/70" />
              <h2 className="text-sm font-bold text-slate-200">
                Ready for Redacted Hybrid Analysis
              </h2>
              <p className="mt-1 max-w-sm text-xs text-slate-400">
                Supported IBANs, Czech account numbers, IDs, emails, phones, and API keys are masked
                locally in your editable preflight payload before cloud fallback; receipt photos stay
                on-device only. Review the preflight box and click{' '}
                <strong className="text-cyan-300">Send Approved Payload &amp; Analyze</strong>.
              </p>
            </div>
          ) : (
            <>
              {/* Telemetry Strip */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-slate-400">Execution</div>
                  <div className="mt-0.5 text-xs font-extrabold text-emerald-300">
                    {result.source.replace(/_/g, ' ')}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-slate-400">
                    Matched Tokens
                  </div>
                  <div className="mt-0.5 text-xs font-extrabold text-cyan-300">
                    {result.redaction.piiCount} pattern(s)
                  </div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-slate-400">
                    Latency / Saved
                  </div>
                  <div className="mt-0.5 text-xs font-extrabold text-amber-300">
                    {result.latencyMs}ms • ${totalSavedUsd}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                <CheckCircle2 className="mr-1.5 inline h-4 w-4 text-emerald-400" />
                {result.note}
              </div>

              {/* Extracted Structured Data */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Extracted Record ({result.extracted.documentKind})
                  </h2>
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-semibold text-cyan-300 hover:bg-slate-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export CSV ({savedBatch.length})
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  {(
                    [
                      ['Vendor / Party', result.extracted.vendor],
                      ['IČO', result.extracted.ico ?? '—'],
                      ['Amount', `${result.extracted.amount ?? '—'} ${result.extracted.currency ?? ''}`.trim()],
                      ['Due Date', result.extracted.dueDate ?? '—'],
                      ['IBAN', result.extracted.iban ?? '—'],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-slate-950/70 p-2">
                      <div className="text-[10px] text-slate-400">{k}</div>
                      <div className="truncate font-mono font-semibold text-slate-100">{v}</div>
                    </div>
                  ))}
                </div>

                <p className="mt-3 text-xs text-slate-300">{result.extracted.summary}</p>

                {result.extracted.riskFlags.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {result.extracted.riskFlags.map((flag, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200"
                      >
                        ⚠ {flag}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Local Redaction Preview */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Cloud-Safe Redacted Payload
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {result.redaction.entries.length} sensitive item(s) masked
                  </span>
                </div>
                <pre className="max-h-36 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
                  {result.redaction.redactedText}
                </pre>
              </div>

              {savedBatch.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                      Processed Batch Ledger ({savedBatch.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setSavedBatch([])}
                      className="cursor-pointer text-[11px] text-rose-400 hover:underline"
                    >
                      Clear batch
                    </button>
                  </div>
                  <div className="max-h-40 overflow-auto rounded-xl border border-slate-800 bg-slate-950">
                    <table className="w-full text-left font-mono text-[11px]">
                      <thead className="border-b border-slate-800 text-[10px] text-slate-400">
                        <tr>
                          <th className="px-2.5 py-1.5">Vendor</th>
                          <th className="px-2 py-1.5">Kind</th>
                          <th className="px-2 py-1.5">Amount</th>
                          <th className="px-2 py-1.5 text-right">Due</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {savedBatch.map((row) => (
                          <tr key={row.id} className="text-slate-200">
                            <td className="max-w-[140px] truncate px-2.5 py-1.5">
                              {row.item.vendor}
                            </td>
                            <td className="px-2 py-1.5 text-cyan-300">
                              {row.item.documentKind}
                            </td>
                            <td className="px-2 py-1.5">
                              {row.item.amount ? `${row.item.amount} ${row.item.currency ?? ''}`.trim() : '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right text-slate-400">
                              {row.item.dueDate ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {/* Firebase Config Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h2 className="text-sm font-bold text-white">Connect Firebase AI Logic</h2>
            <p className="mt-1 text-xs text-slate-400">
              Paste your Firebase Web App config JSON (from Firebase Console → Project Settings), plus optional{' '}
              <code className="text-cyan-300">appCheckSiteKey</code> (reCAPTCHA v3) and{' '}
              <code className="text-cyan-300">appCheckDebugToken</code> for App Check enforcement. Stored locally in your browser only.
            </p>
            <textarea
              value={cfgJsonInput}
              onChange={(e) => setCfgJsonInput(e.target.value)}
              rows={6}
              placeholder='{"apiKey":"...","projectId":"...","appId":"...","appCheckSiteKey":"..."}'
              className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-100"
            />
            {cfgError && <p className="mt-1 text-xs text-rose-400">{cfgError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="cursor-pointer rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveConfig}
                className="cursor-pointer rounded-lg bg-cyan-400 px-3 py-1.5 text-xs font-black text-slate-950"
              >
                Save Config
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Czech QR Platba / Pro Licensing Modal */}
      {showProModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h2 className="text-base font-extrabold text-white">
              VaultLens Pro Batch Pass — 299 CZK / €12 EUR
            </h2>
            <p className="mt-1 text-xs text-slate-300">
              One-time Founder license for unlimited batch CSV accounting exports, custom Czech/EU
              contract rulebooks, and priority support. Zero card fees via instant Czech QR Platba
              or European SEPA EPC QR:
            </p>

            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={() => setProPayMode('czk')}
                className={`flex-1 cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-bold ${proPayMode === 'czk' ? 'bg-cyan-400 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
              >
                CZ QR Platba (299 CZK)
              </button>
              <button
                type="button"
                onClick={() => setProPayMode('sepa')}
                className={`flex-1 cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-bold ${proPayMode === 'sepa' ? 'bg-emerald-400 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
              >
                EU SEPA EPC QR (€12.00)
              </button>
            </div>

            <div className="mt-3 flex flex-col items-center rounded-xl bg-white p-3 text-slate-900">
              {qrDataUrl && (
                <img
                  src={qrDataUrl}
                  alt={proPayMode === 'sepa' ? 'EU SEPA EPC QR' : 'Czech QR Platba SPD'}
                  className="h-44 w-44"
                />
              )}
              <div className="mt-2 text-center font-mono text-[11px]">
                <div>
                  <strong>{domesticAccount}</strong>
                </div>
                <div>IBAN: {paymentIban.match(/.{1,4}/g)?.join(' ')}</div>
                <div>
                  BIC: CEKOCZPP • Amount: {proPayMode === 'sepa' ? '€12.00 EUR' : '299 CZK'} • Ref:
                  2026111701
                </div>
                <div className="text-slate-600">Michal Novotný • IČO: 01346521 (Neplátce DPH)</div>
              </div>
            </div>

            <p className="mt-2.5 text-[11px] text-slate-400">
              After scanning with your Czech banking app or sending SEPA EUR (€12), email your VS
              reference to <strong className="text-cyan-300">info@alertviz.com</strong> to receive
              your Pro unlock pack &amp; invoice.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(paymentIban);
                }}
                className="cursor-pointer rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              >
                Copy IBAN
              </button>
              <button
                type="button"
                onClick={() => setShowProModal(false)}
                className="cursor-pointer rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-black text-slate-950"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
