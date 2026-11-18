# VaultLens Hybrid AI

**On-device structured PII redaction + hybrid Firebase AI Logic document & invoice copilot.**
Built for **[#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/)** (`firebase@13.4.0` `firebase/ai`).

- **Live Hosted Demo:** [https://alertviz.com/vaultlens/](https://alertviz.com/vaultlens/)

## Problem
Freelancers, accountants, and small businesses paste invoices, NDAs, bank statements, and API credentials into cloud AI tools every day — leaking IBANs, local bank accounts, tax/personal IDs, phone numbers, and secrets to remote prompts while paying per-token cloud inference costs on routine documents.

## Solution & Hybrid AI Architecture
```
Raw Document (Text)               Receipt Image (PNG/JPEG)
   │                                 │
   ▼  (100% in-browser RAM)          ▼  (Strict Local ONLY_ON_DEVICE only — never sent to cloud)
Browser PII Vault (src/lib/privacy.ts)
   ├─ Masks IBANs (case-insensitive), CZ accounts, IDs, emails, phones, sk-/AIza/ghp_ tokens
   │  (Note: unstructured names & postal addresses remain legible; review Redacted Preview before cloud routing)
   │
   ▼
Firebase AI Logic Router (src/lib/hybridEngine.ts)
   ├─ Strict Local    → InferenceMode.ONLY_ON_DEVICE (Chrome Gemini Nano)
   ├─ Hybrid Smart    → InferenceMode.PREFER_ON_DEVICE → Cloud Masked fallback (text only)
   └─ Cloud Masked    → InferenceMode.PREFER_IN_CLOUD (`gemini-2.5-flash` over `[PII_TOKEN]` placeholders)
```

> **Firebase App Check Security**: Client initialization via `firebase/app-check` (`ReCaptchaV3Provider`) is wired in `src/lib/hybridEngine.ts` when `VITE_FIREBASE_APP_CHECK_SITE_KEY` (or JSON `"appCheckSiteKey"` / `"appCheckDebugToken"`) is provided. Before submitting for hackathon judging, enable **Firebase App Check** (reCAPTCHA v3 / Enterprise) in Firebase Console, restrict API keys by HTTP referrer (`alertviz.com`), and test with a debug token.

- Uses official `firebase/ai` (`getAI(app, { backend: new GoogleAIBackend() })` and `getGenerativeModel`) with live routing across `InferenceMode.ONLY_ON_DEVICE`, `InferenceMode.PREFER_ON_DEVICE`, and `InferenceMode.PREFER_IN_CLOUD`.
- Supports multimodal receipt/invoice `PNG`/`JPEG` upload (`type: 'inlineData'`) with local thumbnail preview.
- Falls back gracefully to Chrome's native `LanguageModel` Prompt API (when available without Firebase credentials) and deterministic offline extraction so the workflow works zero-cost even in offline mode.

## Running Locally

```bash
npm install
cp .env.example .env   # Optional: bake in your Firebase Web App credentials
npm run test:types
npm run test:unit
npm run build
npm run dev
```

Or connect any Firebase project with **Firebase AI Logic** enabled directly in the live UI via **Setup Firebase**.

## Chrome On-Device Testing
To test hardware-accelerated Chrome Gemini Nano on Desktop (`Chrome >= 139`):
1. Open `chrome://flags/#prompt-api-for-gemini-nano` and set to **Enabled**.
2. Visit [https://alertviz.com/vaultlens/](https://alertviz.com/vaultlens/) and select **Strict Local (`ONLY_ON_DEVICE`)** or **Hybrid Smart (`PREFER_ON_DEVICE`)**.
