import { invoiceXmlText } from './invoiceXml.ts';

/** Extract readable text entirely in the browser. No document bytes are uploaded. */
const maxChars = 500_000;

export async function readDocument(file: File): Promise<string> {
  if (file.size > 12 * 1024 * 1024) throw Error('size');
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const task = pdfjs.getDocument({data:await file.arrayBuffer(),
      useSystemFonts:true, disableFontFace:true});
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 75) throw Error('size');
      let result = '';
      for (let n=1; n<=pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const {items} = await page.getTextContent();
        result += items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
        if (result.length > maxChars) throw Error('size');
      }
      if (!result.trim()) throw Error('scan');
      return result.trim();
    } finally { await task.destroy(); }
  }
  const xml = await file.text();
  if (xml.length > maxChars) throw Error('size');
  if (/<!DOCTYPE/i.test(xml)) throw Error('xml');
  const doc = new DOMParser().parseFromString(xml,'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw Error('xml');
  return invoiceXmlText(doc);
}
