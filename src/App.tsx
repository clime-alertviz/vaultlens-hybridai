import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import {readDocument} from './lib/importDocument';
import { ScanLine, LockKeyhole, Upload, ArrowRight, Download } from 'lucide-react';
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
  redactSensitiveText,
  type ExtractedInvoice,
} from './lib/privacy';

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

function Modal({title, onClose, children}: {title: string; onClose: () => void; children: ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return <dialog ref={dialog} onCancel={onClose} aria-label={title}><h2>{title}</h2>{children}</dialog>;
}

export function App() {
  const readCzech = () => new URLSearchParams(location.search).get('lang') !== 'en';
  const [cs, setCs] = useState(readCzech);
  const t = (en: string, cz: string) => cs ? cz : en;
  useEffect(() => {
    const restore = () => setCs(readCzech());
    window.addEventListener('popstate',restore);
    return () => window.removeEventListener('popstate',restore);
  }, []);
  useEffect(() => {
    document.documentElement.lang = cs ? 'cs' : 'en';
    document.title = cs ? 'VaultLens AI · Analýza dokumentů' : 'VaultLens AI · Document analysis';
  }, [cs]);
  const alternate = new URL(location.href);
  if (cs) alternate.searchParams.set('lang','en'); else alternate.searchParams.delete('lang');
  const [analysisError, setAnalysisError] = useState(false);
  const [inputText, setInputText] = useState<string>(SAMPLES[0]!.text);
  const [routing, setRouting] = useState<RoutingChoice>('strict_local');
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
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (result) resultHeading.current?.focus();
  }, [result]);
  const [savedBatch, setSavedBatch] = useState<
    Array<{ id: string; source: AnalysisOutput['source']; item: ExtractedInvoice }>
  >([]);
  const [chromeNanoStatus, setChromeNanoStatus] = useState<string>('checking');
  const [copiedFlag, setCopiedFlag] = useState<boolean>(false);

  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [importStatus,setImportStatus] = useState('');
  const [reading,setReading] = useState(false);
  const [savedConfig, setSavedConfig] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_CFG_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [cfgJsonInput, setCfgJsonInput] = useState(savedConfig);
  const [cfgError, setCfgError] = useState<string>('');

  const firebaseConfig: FirebaseClientConfig | null = useMemo(() => {
    const envCfg = getEnvFirebaseConfig();
    if (envCfg) return envCfg;
    if (!savedConfig.trim()) return null;
    try {
      const parsed = JSON.parse(savedConfig) as Partial<FirebaseClientConfig>;
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
  }, [savedConfig]);

  useEffect(() => {
    setPreflightDraft(baseRedaction.redactedText);
    setPreflightApproved(false);
  }, [inputText, baseRedaction.redactedText]);

  const appCheckStatus = useMemo(
    () => getAppCheckStatus(firebaseConfig),
    [firebaseConfig]
  );

  useEffect(() => {
    void checkChromeNanoAvailability().then(setChromeNanoStatus);
  }, []);

  const pendingApproval = routing !== 'strict_local' && (!preflightApproved || !preflightDraft.trim());
  const handleAnalyze = async () => {
    if (!inputText.trim() && !imageAttachment) return;
    if (pendingApproval) return;
    setRunning(true);
    setAnalysisError(false);
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
    } catch {
      setAnalysisError(true);
    } finally {
      setRunning(false);
    }
  };

  const importFile = async (file:File) => {
          setReading(true);setImportStatus(t('Reading file…','Načítám soubor…'));
          try {const text=await readDocument(file);setInputText(text);setImageAttachment(null);setResult(null);setPreflightApproved(false);setImportStatus(file.name);}
          catch(err){const reason=err instanceof Error?err.message:'';
            setImportStatus(reason==='scan'?t('This PDF contains only images. Open a PDF with selectable text.','Toto PDF obsahuje pouze obrázky. Vyberte PDF s textovou vrstvou.'):
              reason==='size'?t('Choose a smaller document (12 MB, 75 pages, 500,000 characters).','Zvolte menší dokument (12 MB, 75 stran, 500 000 znaků).'):
              t('Could not read the document. Check its format or remove PDF password protection.','Dokument se nepodařilo přečíst. Zkontrolujte formát nebo odemkněte PDF.'));}
          finally {setReading(false);}
  };
  const openExample = async (type:'pdf'|'xml') => {
    try {
      setReading(true);
      const r=await fetch(import.meta.env.BASE_URL+'examples/faktura.'+type);
      if(!r.ok) throw Error();
      await importFile(new File([await r.blob()],'faktura.'+type));
    } catch {setImportStatus(t('Could not load sample.','Vzor se nepodařilo načíst.'));setReading(false);}
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
      try { localStorage.removeItem(STORAGE_CFG_KEY); } catch { /* Session only. */ }
      setSavedConfig('');
      setCfgError('');
      setShowSettings(false);
      return;
    }
    try {
      const parsed = JSON.parse(cfgJsonInput) as Partial<FirebaseClientConfig>;
      if (!parsed.apiKey || !parsed.projectId || !parsed.appId) {
        setCfgError(t('Include apiKey, projectId and appId.', 'Doplňte apiKey, projectId a appId.'));
        return;
      }
      try { localStorage.setItem(STORAGE_CFG_KEY, cfgJsonInput.trim()); } catch { /* Session only. */ }
      setSavedConfig(cfgJsonInput.trim());
      setCfgError('');
      setShowSettings(false);
    } catch {
      setCfgError(t('Invalid JSON format.', 'Neplatný formát JSON.'));
    }
  };

  const openSettings = () => {
    setCfgJsonInput(savedConfig);
    setCfgError('');
    setShowSettings(true);
  };
  const sampleNames = [t('Invoice','Faktura'), t('Contract','Smlouva'), t('Bank statement','Výpis z účtu')];
  const kinds = {invoice: sampleNames[0], contract: sampleNames[1], statement: sampleNames[2], general: t('Document','Dokument')};
  const sourceNames: Record<AnalysisOutput['source'], string> = {
    local_deterministic: t('Local parser','Lokální rozpoznávání'),
    firebase_in_cloud: t('Firebase cloud','Firebase v cloudu'),
    firebase_on_device: 'Firebase · Gemini Nano',
    chrome_builtin_ai: 'Chrome · Gemini Nano',
  };
  const modes: [RoutingChoice,string][] = [['strict_local',t('On device only','Pouze v zařízení')], ['hybrid_prefer_local',t('Prefer on device','Přednostně v zařízení')], ['prefer_cloud',t('Prefer cloud','Přednostně v cloudu')]];
  const flagTranslations: Record<string,string> = {
    'Auto-renewal clause detected — review cancellation notice window.':'Smlouva se automaticky prodlužuje. Zkontrolujte výpovědní lhůtu.',
    'Broad liability / indemnification language present.':'Dokument obsahuje široce vymezenou odpovědnost nebo náhradu škody.',
    'Late fee or contractual penalty clause detected.':'Dokument obsahuje ustanovení o poplatku za prodlení nebo smluvní pokutě.',
    'Exclusivity / non-compete restriction flagged.':'Dokument obsahuje omezení týkající se výhradnosti nebo konkurence.',
  };
  const hub = cs ? '/hub/' : '/hub/en/';
  return <>
    <a className="skip" href="#document">{t('Skip to document','Přejít k dokumentu')}</a>
    <header className="site-head"><div className="wrap head-row">
      <a className="wordmark" href={cs ? './' : '?lang=en'}><ScanLine aria-hidden="true"/>VaultLens AI</a>
      <nav className="nav"><a href="#settings">{t('Settings','Nastavení')}</a>
        <a href={hub}>{t('Suite Hub','Přehled nástrojů')}</a>
        <a className="language" href={alternate.href} hrefLang={cs?'en':'cs'} lang={cs?'en':'cs'} onClick={e=>{
          if(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault(); history.pushState(null,'',alternate); setCs(!cs);
        }}>{t('Česky','English')}</a></nav>
    </div></header>
    <main><section className="hero-band"><div className="wrap vault-intro">
      <h1>{t('Review documents','Prověřte dokumenty')}<br/><em>{t('with private data.','s citlivými údaji.')}</em></h1>
      <p>{t('Open a text PDF or XML invoice, review its amount and due date, and export CSV. For contracts, review flagged clauses. You choose what can go to the cloud.',
        'Otevřete fakturu v PDF nebo XML, zkontrolujte částku a splatnost a exportujte výsledek do CSV. U smluv zvýrazníme ustanovení ke kontrole. Identifikátory se maskují v prohlížeči. Vy určíte, co se smí odeslat do cloudu.')}</p>
    </div></section>
    <div className="wrap desk">
      <section className="panel"><h2><label htmlFor="document">{t('Source document','Zdrojový dokument')}</label></h2>
        <div className="samples"><span>{t('Samples','Vzory')}</span>{SAMPLES.map((sample,i)=><button type="button" className="secondary" key={sample.label} aria-pressed={inputText===sample.text} disabled={running || reading} onClick={()=>setInputText(sample.text)}>{sampleNames[i]}</button>)}</div>
        <div className="samples"><button className="secondary" disabled={reading || running} onClick={()=>openExample('pdf')}>{t('Try a PDF invoice','Vyzkoušet fakturu PDF')}</button><button className="secondary" disabled={reading || running} onClick={()=>openExample('xml')}>{t('Try an XML invoice','Vyzkoušet fakturu XML')}</button></div>
        <textarea id="document" rows={10} value={inputText} disabled={running || reading} onChange={e=>setInputText(e.target.value)} spellCheck={false}/>
        <label className="upload"><Upload size={16}/>{t('Open PDF or XML / ISDOC','Otevřít PDF nebo XML / ISDOC')}<input type="file" accept=".pdf,.xml,.isdoc,application/pdf,text/xml,application/xml" disabled={running||reading} onChange={async e=>{
          const file=e.target.files?.[0]; e.target.value=''; if(!file)return;
          await importFile(file);
        }}/></label><p className="subtle" role="status">{importStatus || t('Read locally. Text PDFs and XML invoices are supported.','Soubor se načte v prohlížeči. Podporujeme textová PDF a faktury XML včetně ISDOC.')}</p>
        <label className="upload"><Upload size={16}/>{t('Attach an image','Přiložit obrázek')}<input type="file" accept="image/jpeg,image/png" disabled={running || reading} onChange={e=>handleImageUpload(e.target.files?.[0])}/></label>
        {imageAttachment && <div className="attachment"><img src={imageAttachment.previewUrl} alt=""/><span>{imageAttachment.name}</span><button className="secondary" disabled={running || reading} onClick={()=>setImageAttachment(null)}>{t('Remove','Odebrat')}</button></div>}
        <p className="subtle">{t('Receipt images are used only for on-device analysis.','Obrázky dokladů se analyzují pouze ve vašem zařízení.')}</p>
      </section>
      <section className="panel review"><div className="review-head"><h2><label htmlFor="preflightPayload">{t('Review masked text','Kontrola maskování')}</label></h2><LockKeyhole size={20}/></div>
        <p>{t('Check names, addresses, amounts and any other details you want to remove. Edit the text before approving it.','Zkontrolujte jména, adresy, částky a další údaje, které chcete odstranit. Před schválením můžete text upravit.')}</p>
        <textarea id="preflightPayload" rows={6} spellCheck={false} value={preflightDraft} disabled={running || reading} onChange={e=>{setPreflightDraft(e.target.value);setPreflightApproved(false);}}/>
        <div className="mask-row"><span>{t('Masked identifiers','Maskované identifikátory')} · {baseRedaction.piiCount}</span><button disabled={running || reading} className="secondary" onClick={()=>{setPreflightDraft(baseRedaction.redactedText);setPreflightApproved(false);}}>{t('Reset edits','Obnovit maskování')}</button></div>
        <label className="field-label" htmlFor="route">{t('Processing mode','Způsob zpracování')}</label>
        <select id="route" value={routing} disabled={running || reading} onChange={e=>{setRouting(e.target.value as RoutingChoice);setPreflightApproved(false);}}>{modes.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
        {routing !== 'strict_local' && <label className="consent"><input type="checkbox" checked={preflightApproved} disabled={running || reading} onChange={e=>setPreflightApproved(e.target.checked)}/>{t('I approve the text above for cloud processing.','Schvaluji výše uvedený text pro zpracování v cloudu.')}</label>}
        <button className="analyze" aria-describedby={pendingApproval ? 'approval-hint' : undefined} id="analyze" disabled={reading || running || pendingApproval || (!inputText.trim()&&!imageAttachment)} onClick={handleAnalyze}>{running?t('Analyzing…','Zpracovává se…'):t('Analyze document','Analyzovat dokument')} <ArrowRight size={18}/></button>
        {pendingApproval && <p id="approval-hint">{t('To continue, approve the masked text or choose “On device only”.','Pro spuštění schvalte maskovaný text nebo zvolte „Pouze v zařízení“.')}</p>}
        {analysisError && <p role="alert">{t('Analysis failed. Try again or choose on-device processing.','Analýza selhala. Zkuste to znovu nebo vyberte zpracování v zařízení.')}</p>}
      </section>
    </div>
    <div className="wrap vault-lower">
    {result && <section className="results" id="results"><div className="results-head"><h2 ref={resultHeading} tabIndex={-1}>{t('Analysis result','Výsledek analýzy')}</h2>
      <button onClick={handleExportCsv}><Download size={16}/>{t('Export CSV','Exportovat CSV')} ({savedBatch.length || 1})</button></div>
      <p className="subtle">{sourceNames[result.source]} · {result.latencyMs} ms · {t('Estimated cloud cost','Odhad nákladů na cloud')} ${result.estimatedCloudCostUsd.toFixed(4)}</p>
      <dl className="record-grid">{[[t('Document type','Typ dokumentu'),kinds[result.extracted.documentKind]],[t('Vendor / party','Dodavatel / strana'),result.extracted.vendor],['IČO',result.extracted.ico],
        [t('Amount','Částka'),[result.extracted.amount,result.extracted.currency].filter(Boolean).join(' ')],[t('Due date','Splatnost'),result.extracted.dueDate],['IBAN',result.extracted.iban]].map(([label,v])=><div key={label}><dt>{label}</dt><dd>{v||'—'}</dd></div>)}</dl>
      <p>{cs && result.source==='local_deterministic' ? 'Lokální analýza · počet upozornění: '+result.extracted.riskFlags.length+'.' : result.extracted.summary}</p>
      {!!result.extracted.riskFlags.length && <ul>{result.extracted.riskFlags.map((flag,i)=><li key={i}>{cs ? flagTranslations[flag] || flag : flag}</li>)}</ul>}
      <details><summary>{t('Processing details and reviewed text','Podrobnosti zpracování a zkontrolovaný text')}</summary><p lang="en">{result.note}</p><pre>{result.redaction.redactedText}</pre></details>
    </section>}
    {savedBatch.length>0 && <section className="ledger"><div className="results-head"><h2>{t('Batch','Dávka')} ({savedBatch.length})</h2><button className="secondary" onClick={()=>setSavedBatch([])}>{t('Clear batch','Vyprázdnit dávku')}</button></div>
      <div className="table-scroll"><table><thead><tr>{[t('Vendor','Dodavatel'),t('Type','Typ'),t('Amount','Částka'),t('Due date','Splatnost')].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{savedBatch.map(row=><tr key={row.id}><td>{row.item.vendor}</td><td>{kinds[row.item.documentKind]}</td><td>{row.item.amount??'—'} {row.item.currency}</td><td>{row.item.dueDate??'—'}</td></tr>)}</tbody></table></div></section>}
    <section id="settings" className="settings"><h2>{t('Settings and access','Nastavení a přístup')}</h2>
      <details><summary>{t('Processing and privacy','Zpracování a soukromí')}</summary><p>{t('VaultLens masks IBANs, Czech bank accounts, supported Czech personal IDs, emails, phone numbers and common API key formats. Cloud processing uses the reviewed text. The original values are restored in your browser for export.','VaultLens maskuje čísla IBAN, české účty, podporované české osobní identifikátory, e-maily, telefonní čísla a vybrané formáty API klíčů. Cloud zpracovává schválený text. Původní hodnoty se pro export obnoví ve vašem prohlížeči.')}</p>
      <p>Chrome Nano · {chromeNanoStatus} &nbsp; / &nbsp; Firebase App Check · {appCheckStatus}</p>
      <button className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText('chrome://flags/#prompt-api-for-gemini-nano');setCopiedFlag(true);setTimeout(()=>setCopiedFlag(false),1800);}catch{setCopiedFlag(false);}}}>{copiedFlag?t('Copied','Zkopírováno'):t('Copy Chrome Nano flag URL','Zkopírovat adresu nastavení Chrome Nano')}</button></details>
      <div className="setting-row"><div><h3>Firebase AI Logic</h3><p className="subtle">{firebaseConfig?t('Configured','Nakonfigurováno'):t('Optional cloud and on-device models','Volitelné cloudové modely a modely v zařízení')}</p></div><button className="secondary" onClick={openSettings}>{t('Configure','Nastavit')}</button></div>
      <p>{t('CSV export includes your latest 20 results in this session.','Export CSV obsahuje posledních 20 výsledků v této relaci.')}</p>
    </section></div></main>
    <footer className="suite-foot"><div className="wrap"><strong>VaultLens AI</strong><nav><a href={cs?'/faktura-qr/':'/faktura-qr/?lang=en'}>Faktura QR</a><a href={cs?'/eurokyb/':'/eurokyb/en/'}>EuroKYB API</a><a href={hub}>Suite Hub</a><a href="https://github.com/clime-alertviz/vaultlens-hybridai">GitHub</a></nav></div></footer>
    {showSettings && <Modal title={t('Connect Firebase','Připojení Firebase')} onClose={()=>setShowSettings(false)}>
      <label htmlFor="cfg">{t('Firebase web app configuration (JSON)','Konfigurace webové aplikace Firebase (JSON)')}</label><p>{t('Copy it from Project Settings. You can include appCheckSiteKey for reCAPTCHA v3 and appCheckDebugToken for development. Configuration is saved in this browser.','Zkopírujte ji z Project Settings. Volitelně přidejte appCheckSiteKey pro reCAPTCHA v3 a appCheckDebugToken pro vývoj. Konfigurace se ukládá do tohoto prohlížeče.')}</p>
      <textarea id="cfg" rows={6} value={cfgJsonInput} onChange={e=>setCfgJsonInput(e.target.value)}/>{cfgError && <p role="alert">{cfgError}</p>}
      <div className="actions"><button className="secondary" onClick={()=>setShowSettings(false)}>{t('Cancel','Zrušit')}</button><button onClick={handleSaveConfig}>{t('Save configuration','Uložit konfiguraci')}</button></div></Modal>}
  </>;
}
