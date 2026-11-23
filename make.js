// Files the model makes with create_file: xlsx, pdf, md, txt, pptx and csv. The same code runs on the desktop (main process)
// and on the phones (the page). The libraries come through `load()`, never a top-level require, so the phone bundle doesn't
// pull them in: the desktop requires them in main.js, the phones import www/vendor/make-libs.js on first use.
const { toB64 } = require('./seal');

const CREATE = 'create_file';
const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
};
const SOURCE_MAX = 20000; // characters of what the model wrote that later turns get back (see Lib.requestMessages)
const CELLS_MAX = 200000; // cells in one spreadsheet or CSV; beyond that the model should make a smaller file

const CREATE_DEF = {
  type: 'function',
  function: {
    name: CREATE,
    description: 'Create a file and attach it to your reply, where the user can save it. Use it when the user asks for a file, document, '
      + 'spreadsheet or presentation. Formats: "xlsx" (Excel) and "csv" take "sheets" (csv uses the first sheet; csv may give "content" '
      + 'instead); the first row of a sheet is its header, cells are strings, numbers, booleans or null, and a string starting with "=" '
      + 'is an Excel formula. "pdf" takes "content" in Markdown (headings, lists, tables, bold, italic, code). "md" and "txt" take '
      + '"content". "pptx" (PowerPoint) takes "slides", and optionally a deck "title" and "subtitle" for a title slide. '
      + "Don't repeat the file's contents in your reply.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name; the extension is added from the format' },
        format: { type: 'string', enum: Object.keys(MIME) },
        content: { type: 'string', description: 'md, txt and csv: the text. pdf: Markdown' },
        sheets: {
          type: 'array', description: 'xlsx and csv',
          items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: {} } } }, required: ['rows'] },
        },
        title: { type: 'string', description: 'pptx: title slide' },
        subtitle: { type: 'string', description: 'pptx: under the title' },
        slides: {
          type: 'array', description: 'pptx',
          items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } },
        },
      },
      required: ['name', 'format'],
    },
  },
};

const isStr = (v) => typeof v === 'string';
const optStr = (v, what) => { if (v !== undefined && v !== null && !isStr(v)) throw new Error(`"${what}" must be a string.`); return v ?? ''; };
const isCell = (v) => v === null || isStr(v) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** The sheets in `args`, checked: [{name, rows}] with rows of cells. */
function sheetsOf(args) {
  if (!Array.isArray(args.sheets) || !args.sheets.length) throw new Error('Give "sheets": [{"name": "Sheet1", "rows": [["Header", ...], [...]]}].');
  let cells = 0;
  return args.sheets.map((s, i) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.rows) || !s.rows.length) throw new Error(`Sheet ${i + 1} needs "rows", an array of rows.`);
    for (const r of s.rows) {
      if (!Array.isArray(r) || !r.every(isCell)) throw new Error(`Sheet ${i + 1}: every row must be an array of strings, numbers, booleans or null.`);
      cells += r.length;
    }
    if (cells > CELLS_MAX) throw new Error(`Too many cells (over ${CELLS_MAX}); make a smaller file.`);
    return { name: optStr(s.name, 'name') || `Sheet${i + 1}`, rows: s.rows };
  });
}

/** CSV text for `rows`, quoted where a cell needs it. */
const csvOf = (rows) => rows.map((r) => r.map((v) => {
  const s = v === null ? '' : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\r\n') + '\r\n';

/** Text that is safe inside XML: escaped, and without the control characters XML 1.0 forbids. */
// eslint-disable-next-line no-control-regex
const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const colName = (i) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/** An .xlsx written by hand (SpreadsheetML): inline strings, numbers, booleans and formulas; the first row bold; fitted column widths. */
async function xlsx(sheets, JSZip) {
  const zip = new JSZip(), used = new Set();
  const names = sheets.map((s) => { // Excel: at most 31 characters, none of []:*?/\, and unique
    const base = s.name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let n = base; for (let k = 2; used.has(n.toLowerCase()); k++) n = base.slice(0, 31 - String(k).length - 1) + ' ' + k;
    used.add(n.toLowerCase()); return n;
  });
  sheets.forEach((s, i) => {
    const width = [];
    const rows = s.rows.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => {
      if (v === null || v === '') return '';
      const ref = colName(x) + (y + 1), bold = y === 0 ? ' s="1"' : '';
      width[x] = Math.max(width[x] || 0, Math.min(60, String(v).length));
      if (typeof v === 'number') return `<c r="${ref}"${bold}><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"${bold}><v>${v ? 1 : 0}</v></c>`;
      if (v.length > 1 && v[0] === '=') return `<c r="${ref}"${bold}><f>${xml(v.slice(1))}</f></c>`;
      return `<c r="${ref}" t="inlineStr"${bold}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    const cols = width.length ? `<cols>${width.map((w, x) => `<col min="${x + 1}" max="${x + 1}" width="${Math.max(8, (w || 0) + 2)}" customWidth="1"/>`).join('')}</cols>` : '';
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`);
  });
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets>`
    + names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets><calcPr fullCalcOnLoad="1"/></workbook>'); // formulas have no saved result: work them out on opening
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
    + '</styleSheet>');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** pdfmake content for Markdown `text`, from marked's tokens: headings, paragraphs, lists, tables, code, quotes and rules. */
function pdfContent(text, marked) {
  const inline = (tokens = []) => tokens.map((t) => {
    switch (t.type) {
      case 'strong': return { text: inline(t.tokens), bold: true };
      case 'em': return { text: inline(t.tokens), italics: true };
      case 'del': return { text: inline(t.tokens), decoration: 'lineThrough' };
      case 'codespan': return { text: t.text, background: '#eeeeee' };
      case 'link': return { text: inline(t.tokens), link: t.href, color: '#2563eb', decoration: 'underline' }; // a link to click, never fetched
      case 'image': return { text: `[${t.text || 'image'}]`, italics: true };
      case 'br': return '\n';
      default: return t.tokens ? inline(t.tokens) : (t.text ?? t.raw ?? '');
    }
  });
  const SIZE = [22, 18, 15, 13, 12, 11];
  const blocks = (tokens = []) => tokens.flatMap((t) => {
    switch (t.type) {
      case 'heading': return [{ text: inline(t.tokens), fontSize: SIZE[t.depth - 1], bold: true, margin: [0, 10, 0, 4] }];
      case 'paragraph': return [{ text: inline(t.tokens), margin: [0, 0, 0, 6] }];
      case 'text': return [{ text: t.tokens ? inline(t.tokens) : t.text }];
      case 'list': return [{
        [t.ordered ? 'ol' : 'ul']: t.items.map((it) => { const b = blocks(it.tokens); if (it.task) b.unshift({ text: it.checked ? '[x]' : '[ ]' }); return b.length === 1 ? b[0] : { stack: b }; }),
        margin: [0, 0, 0, 6], ...(t.ordered && typeof t.start === 'number' && { start: t.start }),
      }];
      case 'table': return [{
        table: { headerRows: 1, widths: t.header.map(() => '*'), body: [t.header.map((c) => ({ text: inline(c.tokens), bold: true })), ...t.rows.map((r) => r.map((c) => ({ text: inline(c.tokens) })))] },
        layout: 'lightHorizontalLines', margin: [0, 2, 0, 8],
      }];
      case 'code': return [{ table: { widths: ['*'], body: [[{ text: t.text, fontSize: 9, preserveLeadingSpaces: true, fillColor: '#f2f2f2', margin: [4, 4, 4, 4] }]] }, layout: 'noBorders', margin: [0, 2, 0, 8] }];
      case 'blockquote': return [{ stack: blocks(t.tokens), margin: [14, 0, 0, 6], color: '#555555', italics: true }];
      case 'hr': return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 495, y2: 0, lineWidth: 0.5, lineColor: '#999999' }], margin: [0, 6, 0, 6] }];
      case 'space': return [];
      default: return t.text ? [{ text: t.text, margin: [0, 0, 0, 6] }] : [];
    }
  });
  return blocks(marked.lexer(text, { gfm: true }));
}

/** A .pptx: an optional title slide, then a slide per entry with a title, bullets and speaker notes. */
async function pptx(args, PptxGenJS) {
  if (!Array.isArray(args.slides) || !args.slides.length) throw new Error('Give "slides": [{"title": "…", "bullets": ["…"], "notes": "…"}].');
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in
  const title = optStr(args.title, 'title'), sub = optStr(args.subtitle, 'subtitle');
  if (title) p.title = title;
  if (title || sub) {
    const s = p.addSlide();
    if (title) s.addText(title, { x: 0.7, y: 2.4, w: 11.9, h: 1.4, fontSize: 40, bold: true, align: 'center' });
    if (sub) s.addText(sub, { x: 0.7, y: 3.9, w: 11.9, h: 0.9, fontSize: 22, color: '666666', align: 'center' });
  }
  args.slides.forEach((d, i) => {
    if (!d || typeof d !== 'object') throw new Error(`Slide ${i + 1} must be an object.`);
    const bullets = d.bullets ?? [];
    if (!Array.isArray(bullets) || !bullets.every(isStr)) throw new Error(`Slide ${i + 1}: "bullets" must be an array of strings.`);
    const s = p.addSlide(), head = optStr(d.title, 'title'), notes = optStr(d.notes, 'notes');
    if (head) s.addText(head, { x: 0.6, y: 0.4, w: 12.1, h: 1, fontSize: 30, bold: true });
    if (bullets.length) s.addText(bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), { x: 0.8, y: head ? 1.6 : 0.6, w: 11.7, h: head ? 5.4 : 6.4, fontSize: 20, valign: 'top', paraSpaceAfter: 8 });
    if (notes) s.addNotes(notes);
  });
  return Uint8Array.from(atob(await p.write({ outputType: 'base64' })), (c) => c.charCodeAt(0));
}

/** The deck as a text outline, for later turns. */
const outline = (args) => [args.title && `# ${args.title}`, args.subtitle, ...args.slides.map((d, i) => [
  `## Slide ${i + 1}${d.title ? ': ' + d.title : ''}`, ...(d.bullets || []).map((b) => '- ' + b), d.notes && 'Notes: ' + d.notes,
].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');

/**
 * Makes the file create_file asks for. Resolves to {name, mime, data (base64), size, made: true, source}, where `source` is a
 * text form of what the model wrote (cut to SOURCE_MAX), or rejects with a message for the model. The name isn't cleaned here.
 * @param {any} args The tool call's arguments, from the model: checked field by field.
 * @param {() => Promise<{pdfmake: any, PptxGenJS: any, JSZip: any, marked: any}>} load The libraries.
 */
async function makeFile(args, load) {
  const format = String(args?.format ?? '').toLowerCase().replace(/^\./, '').replace(/^ppt$/, 'pptx');
  if (!MIME[format]) throw new Error(`"format" must be one of ${Object.keys(MIME).join(', ')}.`);
  const base = optStr(args.name, 'name').trim().replace(new RegExp(`\\.${format}$`, 'i'), '') || 'file';
  let bytes, source;
  if (format === 'md' || format === 'txt' || format === 'pdf' || (format === 'csv' && args.sheets === undefined)) {
    if (!isStr(args.content) || !args.content.trim()) throw new Error('Give the file\'s text as "content".');
    source = args.content;
  }
  if (format === 'md' || format === 'txt') bytes = new TextEncoder().encode(source);
  else if (format === 'csv') {
    source ??= csvOf(sheetsOf(args)[0].rows);
    bytes = new TextEncoder().encode('﻿' + source); // the BOM makes Excel read it as UTF-8
  } else if (format === 'xlsx') {
    const sheets = sheetsOf(args);
    bytes = await xlsx(sheets, (await load()).JSZip);
    source = sheets.map((s) => `Sheet "${s.name}":\n${csvOf(s.rows)}`).join('\n');
  } else if (format === 'pptx') {
    bytes = await pptx(args, (await load()).PptxGenJS);
    source = outline(args);
  } else {
    const { pdfmake, marked } = await load();
    const doc = { info: { title: base }, pageSize: 'A4', pageMargins: [50, 50, 50, 50], content: pdfContent(source, marked), defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25 } };
    bytes = new Uint8Array(await pdfmake.createPdf(doc).getBuffer());
  }
  if (source.length > SOURCE_MAX) source = source.slice(0, SOURCE_MAX) + '\n[… the rest is cut here; the file has it all]';
  return { name: `${base}.${format}`, mime: MIME[format], data: toB64(bytes), size: bytes.length, made: true, source };
}

module.exports = { CREATE, CREATE_DEF, makeFile, csvOf, SOURCE_MAX };
