/** Preserve invoice field context when turning a local XML document into readable text. */
export function invoiceXmlText(doc: Document): string {
  const root = doc.documentElement;
  const child = (el: Element | undefined, name: string) =>
    el && Array.from(el.children).find(item => item.localName === name);
  const value = (el: Element | undefined) => el?.textContent?.trim().replace(/\s+/g, ' ') || '';
  const party = child(child(root, 'AccountingSupplierParty'), 'Party');
  const name = value(child(child(party, 'PartyName'), 'Name'))
    || value(child(child(party, 'PartyLegalEntity'), 'RegistrationName'));
  const lines = name ? [name, root.localName] : [root.localName];
  const currency = value(child(root, 'LocalCurrencyCode')) || value(child(root, 'DocumentCurrencyCode'));
  const labels: Record<string, string> = {
    PayableAmount: 'Celkem', PaymentDueDate: 'Splatnost', DueDate: 'Splatnost',
  };
  const identifiers = new Set<Element>();
  for (const group of Array.from(party?.children || [])) {
    const id = group.localName === 'PartyIdentification' ? child(group, 'ID') || child(group, 'UserID')
      : group.localName === 'PartyLegalEntity' ? child(group, 'CompanyID') : undefined;
    if (id && /^\d{8}$/.test(value(id))) {
      lines.push('IČO: ' + value(id));
      identifiers.add(id);
      break;
    }
  }

  let leaves = 0;
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (el.children.length || !el.textContent?.trim() || identifiers.has(el)) continue;
    leaves++;
    const parent = el.parentElement;
    const key = el.localName;
    const isPayment = parent && (parent.localName === 'Payment' && parent.parentElement?.localName === 'PaymentMeans'
      || parent.localName === 'Details' && parent.parentElement?.localName === 'Payment'
        && parent.parentElement.parentElement?.localName === 'PaymentMeans');
    if (isPayment && key === 'BankCode' && child(parent, 'ID')) continue;
    if (isPayment && key === 'ID') {
      const account = value(el);
      const bank = value(child(parent, 'BankCode'));
      lines.push('Platební účet: ' + (bank && !account.includes('/') ? account + '/' + bank : account));
      continue;
    }
    const label = key === 'CompanyID' && parent?.localName === 'PartyTaxScheme' ? 'DIČ' : labels[key] || key;
    const unit = key === 'PayableAmount' ? el.getAttribute('currencyID') || currency : '';
    const content = label === 'DIČ' ? value(el) : el.textContent.trim();
    lines.push(label + ': ' + content + (unit ? ' ' + unit : ''));
  }
  if (!leaves && !identifiers.size) throw Error('xml');
  return lines.join('\n');
}
