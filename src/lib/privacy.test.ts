import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAccountingCsv,
  buildSepaEpcPaymentString,
  buildSpdPaymentString,
  extractDocumentHeuristics,
  redactSensitiveText,
  restoreRedactedText,
} from './privacy.ts';
import {
  buildCloudSafeModelParts,
  getAppCheckStatus,
  prepareCloudSafePrompt,
} from './hybridEngine.ts';

void test('redactSensitiveText masks IBAN, Czech account, email, phone, and restores cleanly', () => {
  const raw =
    'Pay Michal Novotny account 19-2000145399/0800 (IBAN CZ65 0800 0000 1920 0014 5399), contact info@alertviz.com or +420 777 123 456.';
  const res = redactSensitiveText(raw);
  assert.ok(res.piiCount >= 4);
  assert.ok(!res.redactedText.includes('19-2000145399/0800'));
  assert.ok(!res.redactedText.includes('CZ65 0800 0000 1920 0014 5399'));
  assert.ok(!res.redactedText.includes('info@alertviz.com'));
  assert.equal(restoreRedactedText(res.redactedText, res.entries), raw);
});

void test('extractDocumentHeuristics detects invoice fields and contract risk flags', () => {
  const doc = `ACME Cloud s.r.o.
ICO: 12345678
Total: 14 500 CZK
Due Date: 2026-12-01
This contract includes automatic renewal unless canceled 60 days prior and smluvní pokuta 0.5% daily.`;
  const parsed = extractDocumentHeuristics(doc);
  assert.equal(parsed.documentKind, 'contract');
  assert.equal(parsed.ico, '12345678');
  assert.equal(parsed.currency, 'CZK');
  assert.equal(parsed.dueDate, '2026-12-01');
  assert.equal(parsed.riskFlags.length, 2);

  const inv = extractDocumentHeuristics('Invoice #12\nTotal: 299 CZK\nSplatnost: 2026-12-01');
  assert.equal(inv.documentKind, 'invoice');
});

void test('buildSpdPaymentString formats Czech QR Platba SPD 1.0 accurately', () => {
  const spd = buildSpdPaymentString({
    iban: 'CZ65 0800 0000 1920 0014 5399',
    bic: 'CEKOCZPP',
    amountCzk: 299,
    vs: '2026111701',
    message: 'VaultLens Pro Lifetime',
    recipientName: 'Michal Novotny',
  });
  assert.equal(
    spd,
    'SPD*1.0*ACC:CZ6508000000192000145399+CEKOCZPP*AM:299.00*CC:CZK*RN:Michal Novotny*X-VS:2026111701*MSG:VaultLens Pro Lifetime'
  );
});

void test('buildAccountingCsv generates clean quoted CSV', () => {
  const csv = buildAccountingCsv([
    {
      vendor: 'Supplier "One"',
      ico: '01346521',
      iban: 'CZ6508000000192000145399',
      amount: '299',
      currency: 'CZK',
      dueDate: '2026-11-30',
      documentKind: 'invoice',
      riskFlags: ['None'],
      summary: 'Clean',
    },
  ]);
  assert.match(csv, /^Kind,Vendor,ICO,IBAN/);
  assert.match(csv, /"Supplier ""One"""/);
});

void test('redactSensitiveText handles repeated secrets cleanly and normalizes Kc + dotted Czech dates', () => {
  const text = 'Faktura ABC s.r.o.\nCena: 4 200 Kč\nSplatnost: 15. 12. 2026\nKey sk-test-abcdefghijklmnop repeated sk-test-abcdefghijklmnop';
  const red = redactSensitiveText(text);
  assert.equal(red.entries.length, 1);
  assert.equal(red.entries[0]?.token, '[SECRET_1]');
  assert.equal(restoreRedactedText(red.redactedText, red.entries), text);

  const ext = extractDocumentHeuristics(text);
  assert.equal(ext.documentKind, 'invoice');
  assert.equal(ext.currency, 'CZK');
  assert.equal(ext.dueDate, '15. 12. 2026');
});

void test('IBAN matching does not swallow adjacent labels across lines or currency suffixes', () => {
  const snippet = `CSOB Statement — Michal Novotny
Account number: 19-2000145399/0800
IBAN: CZ65 0800 0000 1920 0014 5399
ICO: 01346521
IBAN2: DE89 3704 0044 0532 0130 00 EUR`;
  const red = redactSensitiveText(snippet);
  assert.equal(red.entries.find((e) => e.token === '[IBAN_1]')?.original, 'CZ65 0800 0000 1920 0014 5399');
  assert.equal(red.entries.find((e) => e.token === '[IBAN_2]')?.original, 'DE89 3704 0044 0532 0130 00');
  assert.ok(red.redactedText.includes('ICO: 01346521'));
  assert.ok(red.redactedText.includes('[IBAN_2] EUR'));

  const ext = extractDocumentHeuristics(snippet);
  assert.equal(ext.iban, 'CZ65 0800 0000 1920 0014 5399');
  assert.equal(ext.ico, '01346521');
});

void test('buildSepaEpcPaymentString formats EPC069-12 compliant SCT payload cleanly', () => {
  const epc = buildSepaEpcPaymentString({
    iban: 'CZ65 0800 0000 1920 0014 5399',
    bic: 'CEKOCZPP',
    amountEur: 12,
    ref: '2026111701',
    message: 'VaultLens Pro Pass',
    recipientName: 'Michal Novotny',
  });
  assert.equal(
    epc,
    'BCD\n002\n1\nSCT\nCEKOCZPP\nMichal Novotny\nCZ6508000000192000145399\nEUR12.00\n\n\nVaultLens Pro Pass'
  );
  assert.ok(!epc.endsWith('\n'));
});

void test('lowercase and space-delimited letters-only bank-code IBANs (UK, NL, FR) are masked accurately', () => {
  for (const iban of [
    'GB82 WEST 1234 5698 7654 32',
    'NL91 ABNA 0417 1643 00',
    'GB82WEST12345698765432',
    'cz65 0800 0000 1920 0014 5399',
    'FR76 3000 6000 0112 3456 7890 189',
  ]) {
    const red = redactSensitiveText(`Transfer to ${iban} EUR paid`);
    assert.equal(red.piiCount, 1, `Expected 1 masked token for ${iban}`);
    assert.equal(red.redactedText, 'Transfer to [IBAN_1] EUR paid', `Wrong mask output for ${iban}`);
    assert.equal(restoreRedactedText(red.redactedText, red.entries), `Transfer to ${iban} EUR paid`);
  }

  const cloudParts = buildCloudSafeModelParts({
    promptText: 'redacted',
    choice: 'hybrid_prefer_local',
    imageBase64: { data: 'QUJD', mimeType: 'image/png' },
  });
  assert.equal(cloudParts.withheldRawImageFromCloud, true);
  assert.equal(cloudParts.parts.length, 1);

  const localParts = buildCloudSafeModelParts({
    promptText: 'local',
    choice: 'strict_local',
    imageBase64: { data: 'QUJD', mimeType: 'image/png' },
  });
  assert.equal(localParts.withheldRawImageFromCloud, false);
  assert.equal(localParts.parts.length, 2);
});

void test('preflight override controls outbound cloud prompt and App Check reports site key requirement', () => {
  const pre = prepareCloudSafePrompt({
    rawText: 'Pay Jan Novak GB82 WEST 1234 5698 7654 32 today',
    redactedTextOverride: 'Pay [PERSON_MANUAL] [IBAN_1] today',
    choice: 'prefer_cloud',
  });
  assert.ok(!pre.promptText.includes('Jan Novak'));
  assert.ok(!pre.promptText.includes('WEST'));
  assert.ok(pre.promptText.includes('[PERSON_MANUAL] [IBAN_1]'));

  assert.equal(getAppCheckStatus(null), 'no_firebase');
  assert.equal(
    getAppCheckStatus({ apiKey: 'k', projectId: 'p', appId: 'a' }),
    'missing_site_key'
  );
  assert.equal(
    getAppCheckStatus({ apiKey: 'k', projectId: 'p', appId: 'a', appCheckSiteKey: '6Lc...' }),
    'active'
  );
});

void test('explicit empty and whitespace-only edits never restore document text in hybrid mode', () => {
  for (const draft of ['', '   ']) {
    const output = prepareCloudSafePrompt({ rawText: 'private sentence', redactedTextOverride: draft, choice: 'hybrid_prefer_local' });
    assert.equal(output.outboundDocumentText, draft);
    assert.ok(!output.promptText.includes('private sentence'));
  }
});

void test('ISDOC 6.0.2 keeps the supplier identity and masks split payment fields before cloud review', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const { invoiceXmlText } = await import('./invoiceXml.ts');
  const supplier = '<i:PartyIdentification><i:ID>00123456</i:ID></i:PartyIdentification>';
  const xml = `<i:Invoice xmlns:i="http://isdoc.cz/namespace/2013" version="6.0.2">
    <i:AccountingCustomerParty><i:Party><i:PartyIdentification><i:ID>00876543</i:ID>
      </i:PartyIdentification></i:Party></i:AccountingCustomerParty>
    <i:AccountingSupplierParty><i:Party><i:PartyName><i:Name>Test Studio</i:Name></i:PartyName>
      ${supplier}<i:PartyTaxScheme><i:CompanyID>CZ0123456789</i:CompanyID></i:PartyTaxScheme>
    </i:Party></i:AccountingSupplierParty>
    <i:PaymentMeans><i:Payment><i:Details><i:ID>19-24681357</i:ID><i:BankCode>0300</i:BankCode></i:Details>
    </i:Payment><i:Payment><i:Details><i:ID>987654321</i:ID></i:Details></i:Payment></i:PaymentMeans>
  </i:Invoice>`;
  const read = (input: string) => invoiceXmlText(new DOMParser().parseFromString(input, 'application/xml') as unknown as Document);
  const raw = read(xml);
  const fields = extractDocumentHeuristics(raw);
  assert.equal(fields.vendor, 'Test Studio');
  assert.equal(fields.ico, '00123456');
  assert.equal(extractDocumentHeuristics(read(xml.replace(supplier, ''))).ico, null);
  assert.match(raw, /DIČ: CZ0123456789/);
  assert.match(raw, /Platební účet: 19-24681357\/0300/);
  const { outboundDocumentText } = prepareCloudSafePrompt({rawText: raw, choice: 'prefer_cloud'});
  assert.match(outboundDocumentText, /Platební účet: \[CZ_BANK_1\]/);
  assert.match(outboundDocumentText, /Platební účet: \[CZ_BANK_2\]/);
  for (const identifier of ['24681357', '987654321', 'CZ0123456789']) {
    assert.ok(!outboundDocumentText.includes(identifier));
  }
  const redaction = redactSensitiveText(raw);
  assert.equal(restoreRedactedText(redaction.redactedText, redaction.entries), raw);
});
