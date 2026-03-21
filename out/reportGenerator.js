"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateWordReport = generateWordReport;
exports.generateHtmlReport = generateHtmlReport;
const docx_1 = require("docx");
// ─── Colour palette ───────────────────────────────────────────────────────────
const BRAND_BLUE = '1E3A5F';
const ACCENT_TEAL = '00897B';
const CODE_BG = 'F3F4F6';
const TABLE_HEADER = '1E3A5F';
const WARN_AMBER = 'FFF8E1';
const WARN_BORDER = 'F59E0B';
const TEXT_DARK = '1A1A2E';
const TEXT_MUTED = '6B7280';
function tokenize(markdown) {
    const tokens = [];
    const lines = markdown.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Code block
        if (line.trimStart().startsWith('```')) {
            const lang = line.replace(/^```/, '').trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            tokens.push({ kind: 'code', lang, lines: codeLines });
            i++;
            continue;
        }
        // Table
        if (line.includes('|') && line.trim().startsWith('|')) {
            const tableLines = [line];
            i++;
            // skip separator row
            if (i < lines.length && /^\|[-| :]+\|$/.test(lines[i].trim())) {
                i++;
            }
            while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
                tableLines.push(lines[i]);
                i++;
            }
            const parseRow = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
            const headers = parseRow(tableLines[0]);
            const rows = tableLines.slice(1).map(parseRow);
            tokens.push({ kind: 'table', headers, rows });
            continue;
        }
        // Headings
        const h1 = line.match(/^# (.+)/);
        if (h1) {
            tokens.push({ kind: 'h1', text: h1[1].trim() });
            i++;
            continue;
        }
        const h2 = line.match(/^## (.+)/);
        if (h2) {
            tokens.push({ kind: 'h2', text: h2[1].trim() });
            i++;
            continue;
        }
        const h3 = line.match(/^### (.+)/);
        if (h3) {
            tokens.push({ kind: 'h3', text: h3[1].trim() });
            i++;
            continue;
        }
        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
            tokens.push({ kind: 'hr' });
            i++;
            continue;
        }
        // Bullet list
        const bullet = line.match(/^(\s*)[*\-] (.+)/);
        if (bullet) {
            tokens.push({ kind: 'bullet', level: Math.floor(bullet[1].length / 2), text: bullet[2] });
            i++;
            continue;
        }
        // Numbered list
        const numbered = line.match(/^(\d+)\. (.+)/);
        if (numbered) {
            tokens.push({ kind: 'numbered', index: parseInt(numbered[1]), text: numbered[2] });
            i++;
            continue;
        }
        // Blank line
        if (line.trim() === '') {
            tokens.push({ kind: 'blank' });
            i++;
            continue;
        }
        // Paragraph
        tokens.push({ kind: 'para', text: line });
        i++;
    }
    return tokens;
}
// ─── Inline text parser (bold, italic, inline-code) ──────────────────────────
function parseInline(text) {
    const runs = [];
    // Replace emoji-heavy chars that might not render in docx
    const cleaned = text.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
    const parts = cleaned.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/);
    for (const part of parts) {
        if (part.startsWith('`') && part.endsWith('`')) {
            runs.push(new docx_1.TextRun({
                text: part.slice(1, -1),
                font: 'Courier New',
                size: 18,
                shading: { type: docx_1.ShadingType.SOLID, color: CODE_BG, fill: CODE_BG },
            }));
        }
        else if (part.startsWith('**') && part.endsWith('**')) {
            runs.push(new docx_1.TextRun({ text: part.slice(2, -2), bold: true, color: TEXT_DARK }));
        }
        else if (part.startsWith('*') && part.endsWith('*')) {
            runs.push(new docx_1.TextRun({ text: part.slice(1, -1), italics: true }));
        }
        else if (part) {
            runs.push(new docx_1.TextRun({ text: part, color: TEXT_DARK }));
        }
    }
    return runs.length ? runs : [new docx_1.TextRun({ text: cleaned })];
}
// ─── Element builders ─────────────────────────────────────────────────────────
function heading1(text) {
    return new docx_1.Paragraph({
        heading: docx_1.HeadingLevel.HEADING_1,
        children: [new docx_1.TextRun({ text: text.replace(/[#🔍🗺📋🔧💡🧪⚙🐳⚠✅📄📊🎯🏢📈]/gu, '').trim(), bold: true, color: BRAND_BLUE, size: 32 })],
        spacing: { before: 400, after: 160 },
        border: { bottom: { color: BRAND_BLUE, size: 6, style: docx_1.BorderStyle.SINGLE } },
    });
}
function heading2(text) {
    return new docx_1.Paragraph({
        heading: docx_1.HeadingLevel.HEADING_2,
        children: [new docx_1.TextRun({ text: text.replace(/[🔍🗺📋🔧💡🧪⚙🐳⚠✅📄📊🎯🏢📈]/gu, '').trim(), bold: true, color: ACCENT_TEAL, size: 26 })],
        spacing: { before: 320, after: 120 },
    });
}
function heading3(text) {
    return new docx_1.Paragraph({
        heading: docx_1.HeadingLevel.HEADING_3,
        children: [new docx_1.TextRun({ text: text.replace(/[🔍🗺📋🔧💡🧪⚙🐳⚠✅📄📊🎯🏢📈]/gu, '').trim(), bold: true, color: TEXT_DARK, size: 22 })],
        spacing: { before: 240, after: 80 },
    });
}
function normalPara(text) {
    return new docx_1.Paragraph({
        children: parseInline(text),
        spacing: { before: 60, after: 100 },
        indent: { left: 0 },
    });
}
function bulletPara(text, level = 0) {
    return new docx_1.Paragraph({
        bullet: { level },
        children: parseInline(text),
        spacing: { before: 40, after: 40 },
        indent: { left: (0, docx_1.convertInchesToTwip)(0.25 * (level + 1)), hanging: (0, docx_1.convertInchesToTwip)(0.25) },
    });
}
function numberedPara(text, idx) {
    return new docx_1.Paragraph({
        numbering: { reference: 'numbering', level: 0 },
        children: parseInline(text),
        spacing: { before: 40, after: 40 },
    });
}
function codeBlock(lines, lang) {
    const langLabel = lang ? new docx_1.Paragraph({
        children: [new docx_1.TextRun({ text: lang.toUpperCase(), size: 14, color: TEXT_MUTED, bold: true })],
        spacing: { before: 120, after: 0 },
    }) : null;
    const codePara = new docx_1.Paragraph({
        children: [
            new docx_1.TextRun({
                text: lines.join('\n'),
                font: 'Courier New',
                size: 16,
                color: '1A1A2E',
            }),
        ],
        shading: { type: docx_1.ShadingType.SOLID, color: CODE_BG, fill: CODE_BG },
        border: {
            top: { color: 'CBD5E1', size: 4, style: docx_1.BorderStyle.SINGLE },
            bottom: { color: 'CBD5E1', size: 4, style: docx_1.BorderStyle.SINGLE },
            left: { color: ACCENT_TEAL, size: 12, style: docx_1.BorderStyle.SINGLE },
            right: { color: 'CBD5E1', size: 4, style: docx_1.BorderStyle.SINGLE },
        },
        spacing: { before: 80, after: 200 },
        indent: { left: (0, docx_1.convertInchesToTwip)(0.25) },
    });
    return langLabel ? [langLabel, codePara] : [codePara];
}
function tableBlock(headers, rows) {
    const headerRow = new docx_1.TableRow({
        tableHeader: true,
        children: headers.map((h) => new docx_1.TableCell({
            children: [new docx_1.Paragraph({
                    children: [new docx_1.TextRun({ text: h, bold: true, color: 'FFFFFF', size: 18 })],
                    alignment: docx_1.AlignmentType.LEFT,
                })],
            shading: { type: docx_1.ShadingType.SOLID, color: TABLE_HEADER, fill: TABLE_HEADER },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
        })),
    });
    const dataRows = rows.map((row, ri) => new docx_1.TableRow({
        children: row.map((cell) => new docx_1.TableCell({
            children: [new docx_1.Paragraph({
                    children: parseInline(cell),
                    spacing: { before: 40, after: 40 },
                })],
            shading: ri % 2 === 0
                ? { type: docx_1.ShadingType.SOLID, color: 'FFFFFF', fill: 'FFFFFF' }
                : { type: docx_1.ShadingType.SOLID, color: 'F8FAFC', fill: 'F8FAFC' },
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
        })),
    }));
    return new docx_1.Table({
        width: { size: 100, type: docx_1.WidthType.PERCENTAGE },
        rows: [headerRow, ...dataRows],
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
}
function hrRule() {
    return new docx_1.Paragraph({
        border: { bottom: { color: 'E2E8F0', size: 6, style: docx_1.BorderStyle.SINGLE } },
        spacing: { before: 200, after: 200 },
        children: [],
    });
}
function pageBreakPara() {
    return new docx_1.Paragraph({ children: [new docx_1.PageBreak()] });
}
function infoBox(text) {
    return new docx_1.Table({
        width: { size: 100, type: docx_1.WidthType.PERCENTAGE },
        rows: [new docx_1.TableRow({
                children: [new docx_1.TableCell({
                        children: [new docx_1.Paragraph({
                                children: parseInline(text),
                                spacing: { before: 60, after: 60 },
                            })],
                        shading: { type: docx_1.ShadingType.SOLID, color: 'EFF6FF', fill: 'EFF6FF' },
                        borders: {
                            top: { color: '3B82F6', size: 8, style: docx_1.BorderStyle.SINGLE },
                            bottom: { color: '3B82F6', size: 8, style: docx_1.BorderStyle.SINGLE },
                            left: { color: '3B82F6', size: 20, style: docx_1.BorderStyle.SINGLE },
                            right: { color: '3B82F6', size: 8, style: docx_1.BorderStyle.SINGLE },
                        },
                        margins: { top: 80, bottom: 80, left: 160, right: 160 },
                    })],
            })],
        margins: { top: 120, bottom: 120, left: 0, right: 0 },
    });
}
// ─── Cover Page ───────────────────────────────────────────────────────────────
function buildCoverPage(analysis, targetStack) {
    const { repoInfo, detectedStack } = analysis;
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    return [
        new docx_1.Paragraph({ children: [], spacing: { before: 800 } }),
        new docx_1.Paragraph({
            children: [new docx_1.TextRun({ text: 'CODE MIGRATION REPORT', bold: true, size: 48, color: BRAND_BLUE, characterSpacing: 100 })],
            alignment: docx_1.AlignmentType.CENTER,
            spacing: { after: 200 },
        }),
        new docx_1.Paragraph({
            children: [new docx_1.TextRun({ text: `${repoInfo.owner} / ${repoInfo.repo}`, size: 36, color: ACCENT_TEAL, bold: true })],
            alignment: docx_1.AlignmentType.CENTER,
            spacing: { after: 120 },
        }),
        new docx_1.Paragraph({
            children: [new docx_1.TextRun({ text: `${detectedStack.framework || detectedStack.primaryLanguage}  →  ${targetStack}`, size: 28, color: TEXT_MUTED, italics: true })],
            alignment: docx_1.AlignmentType.CENTER,
            spacing: { after: 600 },
        }),
        new docx_1.Paragraph({
            border: { top: { color: 'E2E8F0', size: 6, style: docx_1.BorderStyle.SINGLE }, bottom: { color: 'E2E8F0', size: 6, style: docx_1.BorderStyle.SINGLE } },
            children: [],
            spacing: { before: 0, after: 0 },
        }),
        new docx_1.Paragraph({ children: [], spacing: { before: 200 } }),
        ...[
            ['Repository', `https://github.com/${repoInfo.owner}/${repoInfo.repo}`],
            ['Current Stack', `${detectedStack.framework} on ${detectedStack.runtime}`],
            ['Target Stack', targetStack],
            ['Language', detectedStack.primaryLanguage],
            ['Total Files', analysis.totalFiles.toLocaleString()],
            ['Generated', date],
            ['Tool', 'Code Migration Assistant (VS Code)'],
        ].map(([label, value]) => new docx_1.Paragraph({
            children: [
                new docx_1.TextRun({ text: `${label}:  `, bold: true, color: TEXT_DARK, size: 20 }),
                new docx_1.TextRun({ text: value, color: TEXT_MUTED, size: 20 }),
            ],
            alignment: docx_1.AlignmentType.CENTER,
            spacing: { before: 80, after: 80 },
        })),
        pageBreakPara(),
    ];
}
// ─── Markdown → docx elements ─────────────────────────────────────────────────
function tokensToElements(tokens) {
    const elements = [];
    let numberedIdx = 0;
    for (const token of tokens) {
        switch (token.kind) {
            case 'h1':
                elements.push(pageBreakPara(), heading1(token.text));
                numberedIdx = 0;
                break;
            case 'h2':
                elements.push(heading2(token.text));
                numberedIdx = 0;
                break;
            case 'h3':
                elements.push(heading3(token.text));
                break;
            case 'code':
                elements.push(...codeBlock(token.lines, token.lang));
                break;
            case 'table':
                if (token.headers.length > 0) {
                    elements.push(tableBlock(token.headers, token.rows));
                    elements.push(new docx_1.Paragraph({ children: [], spacing: { before: 100, after: 100 } }));
                }
                break;
            case 'bullet':
                elements.push(bulletPara(token.text, token.level));
                break;
            case 'numbered':
                elements.push(numberedPara(token.text, token.index));
                break;
            case 'hr':
                elements.push(hrRule());
                break;
            case 'blank':
                break;
            case 'para':
                if (token.text.trim().startsWith('>')) {
                    elements.push(infoBox(token.text.replace(/^>\s*/, '')));
                }
                else if (token.text.trim()) {
                    elements.push(normalPara(token.text));
                }
                break;
        }
    }
    return elements;
}
// ─── Main Word Generator ──────────────────────────────────────────────────────
async function generateWordReport(markdown, analysis, targetStack) {
    const coverElements = buildCoverPage(analysis, targetStack);
    const tokens = tokenize(markdown);
    const contentElements = tokensToElements(tokens);
    const doc = new docx_1.Document({
        numbering: {
            config: [{
                    reference: 'numbering',
                    levels: [{
                            level: 0,
                            format: docx_1.LevelFormat.DECIMAL,
                            text: '%1.',
                            alignment: docx_1.AlignmentType.LEFT,
                            style: { paragraph: { indent: { left: (0, docx_1.convertInchesToTwip)(0.5), hanging: (0, docx_1.convertInchesToTwip)(0.25) } } },
                        }],
                }],
        },
        styles: {
            default: {
                document: {
                    run: { font: 'Calibri', size: 22, color: TEXT_DARK },
                    paragraph: { spacing: { line: 276 } },
                },
            },
        },
        sections: [{
                properties: {
                    page: {
                        margin: { top: (0, docx_1.convertInchesToTwip)(1), bottom: (0, docx_1.convertInchesToTwip)(1), left: (0, docx_1.convertInchesToTwip)(1.25), right: (0, docx_1.convertInchesToTwip)(1.25) },
                    },
                    titlePage: true,
                },
                headers: {
                    default: new docx_1.Header({
                        children: [new docx_1.Paragraph({
                                children: [
                                    new docx_1.TextRun({ text: `${analysis.repoInfo.owner}/${analysis.repoInfo.repo}  ·  Migration Report`, color: TEXT_MUTED, size: 16 }),
                                ],
                                alignment: docx_1.AlignmentType.RIGHT,
                                border: { bottom: { color: 'E2E8F0', size: 4, style: docx_1.BorderStyle.SINGLE } },
                            })],
                    }),
                },
                footers: {
                    default: new docx_1.Footer({
                        children: [new docx_1.Paragraph({
                                children: [
                                    new docx_1.TextRun({ text: 'Generated by Code Migration Assistant  ·  Page ', size: 16, color: TEXT_MUTED }),
                                    new docx_1.TextRun({ children: [docx_1.PageNumber.CURRENT], size: 16, color: TEXT_MUTED }),
                                    new docx_1.TextRun({ text: ' of ', size: 16, color: TEXT_MUTED }),
                                    new docx_1.TextRun({ children: [docx_1.PageNumber.TOTAL_PAGES], size: 16, color: TEXT_MUTED }),
                                ],
                                alignment: docx_1.AlignmentType.CENTER,
                                border: { top: { color: 'E2E8F0', size: 4, style: docx_1.BorderStyle.SINGLE } },
                            })],
                    }),
                },
                children: [...coverElements, ...contentElements],
            }],
    });
    return docx_1.Packer.toBuffer(doc);
}
// ─── HTML-to-PDF Generator ────────────────────────────────────────────────────
/** Build a Table of Contents from the markdown headings */
function buildToc(markdown) {
    const lines = markdown.split('\n');
    const entries = [];
    for (const line of lines) {
        const h1 = line.match(/^# (.+)/);
        const h2 = line.match(/^## (.+)/);
        const h3 = line.match(/^### (.+)/);
        const match = h1 || h2 || h3;
        if (!match) {
            continue;
        }
        const level = h1 ? 1 : h2 ? 2 : 3;
        const text = match[1].replace(/[^\w\s\-–.()]/g, '').trim();
        const id = text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
        entries.push({ level, text, id });
    }
    if (entries.length === 0) {
        return '';
    }
    let toc = '<nav class="toc"><h2>Table of Contents</h2><ol class="toc-l1">\n';
    let inL2 = false;
    let inL3 = false;
    for (const e of entries) {
        if (e.level === 1) {
            if (inL3) {
                toc += '</ol>';
                inL3 = false;
            }
            if (inL2) {
                toc += '</ol></li>';
                inL2 = false;
            }
            toc += `<li><a href="#${e.id}">${escapeHtml(e.text)}</a>`;
            inL2 = false;
        }
        else if (e.level === 2) {
            if (inL3) {
                toc += '</ol>';
                inL3 = false;
            }
            if (!inL2) {
                toc += '<ol class="toc-l2">';
                inL2 = true;
            }
            toc += `<li><a href="#${e.id}">${escapeHtml(e.text)}</a>`;
            inL3 = false;
        }
        else {
            if (!inL3) {
                toc += '<ol class="toc-l3">';
                inL3 = true;
            }
            toc += `<li><a href="#${e.id}">${escapeHtml(e.text)}</a></li>`;
        }
    }
    if (inL3) {
        toc += '</ol>';
    }
    if (inL2) {
        toc += '</ol></li>';
    }
    toc += '</ol></nav>';
    return toc;
}
function generateHtmlReport(markdown, analysis, targetStack) {
    const { repoInfo, detectedStack } = analysis;
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const html = markdownToHtml(markdown);
    const toc = buildToc(markdown);
    const metaRows = [
        ['Repository', `${repoInfo.owner}/${repoInfo.repo}`],
        ['Stars', String(repoInfo.stars)],
        ['Total Files', analysis.totalFiles.toLocaleString()],
        ['Size', `${repoInfo.size.toLocaleString()} KB`],
        ['Language', detectedStack.primaryLanguage],
        ['Runtime', detectedStack.runtime],
        ['Framework', detectedStack.framework],
        ['Build Tool', detectedStack.buildTool],
        ['Package Mgr', detectedStack.packageManager],
        ['Containers', detectedStack.containerized ? 'Yes (Docker)' : 'No'],
        ['CI/CD', detectedStack.ciSystem || 'None detected'],
        ['Databases', detectedStack.databases.join(', ') || 'None detected'],
        ['Test Frameworks', detectedStack.testingFrameworks.join(', ') || 'None detected'],
        ['Generated', date],
        ['Tool', 'Code Migration Assistant (VS Code)'],
    ];
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Migration Report — ${escapeHtml(repoInfo.owner)}/${escapeHtml(repoInfo.repo)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --blue:        #1E3A5F;
    --teal:        #00897B;
    --teal-light:  #E0F2F1;
    --code-bg:     #F3F4F6;
    --dark:        #111827;
    --muted:       #6B7280;
    --border:      #E5E7EB;
    --bg-subtle:   #F9FAFB;
    --warn:        #FFFBEB;
    --warn-border: #D97706;
    --info:        #EFF6FF;
    --info-border: #3B82F6;
    --danger:      #FEF2F2;
    --danger-border:#DC2626;
    --success:     #F0FDF4;
    --success-border:#16A34A;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html { scroll-behavior: smooth; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.8;
    color: var(--dark);
    background: #fff;
  }

  /* ─── Layout ────────────────────────────────────────── */
  .page-wrapper { display: flex; min-height: 100vh; }

  .sidebar {
    width: 260px;
    min-width: 260px;
    background: var(--blue);
    color: #fff;
    padding: 32px 0;
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    overflow-y: auto;
    z-index: 100;
  }
  .sidebar-brand {
    padding: 0 24px 24px;
    border-bottom: 1px solid rgba(255,255,255,0.12);
    margin-bottom: 16px;
  }
  .sidebar-brand .label { font-size: 9px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.6; }
  .sidebar-brand .repo { font-size: 15px; font-weight: 700; margin: 4px 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sidebar-brand .arrow { font-size: 11px; opacity: 0.7; }
  .sidebar-nav { padding: 0 12px; }
  .sidebar-nav a {
    display: block;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    color: rgba(255,255,255,0.75);
    text-decoration: none;
    margin: 1px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 0.15s, color 0.15s;
  }
  .sidebar-nav a:hover { background: rgba(255,255,255,0.12); color: #fff; }
  .sidebar-nav a.h1-link { font-weight: 600; color: rgba(255,255,255,0.95); font-size: 12.5px; margin-top: 8px; }
  .sidebar-nav a.h2-link { padding-left: 22px; }
  .sidebar-nav a.h3-link { padding-left: 34px; font-size: 11px; }

  .main-content {
    margin-left: 260px;
    flex: 1;
    max-width: 900px;
    padding: 48px 56px 80px;
  }

  /* ─── Cover Page ────────────────────────────────────── */
  .cover {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 80px 0 60px;
    border-bottom: 3px solid var(--border);
    margin-bottom: 48px;
    page-break-after: always;
  }
  .cover-eyebrow {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--teal);
    margin-bottom: 20px;
  }
  .cover-title {
    font-size: 48px;
    font-weight: 800;
    color: var(--blue);
    line-height: 1.15;
    margin-bottom: 8px;
  }
  .cover-subtitle {
    font-size: 20px;
    color: var(--muted);
    margin-bottom: 32px;
  }
  .cover-migration-badge {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    background: var(--teal-light);
    border: 1px solid var(--teal);
    border-radius: 8px;
    padding: 12px 20px;
    margin-bottom: 48px;
    font-size: 15px;
    font-weight: 600;
  }
  .cover-migration-badge .from { color: var(--blue); }
  .cover-migration-badge .sep { color: var(--teal); font-size: 20px; }
  .cover-migration-badge .to { color: var(--teal); }
  .cover-divider { border: none; border-top: 2px solid var(--border); margin: 32px 0; }
  .cover-meta-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .cover-meta-cell {
    background: var(--bg-subtle);
    padding: 14px 18px;
  }
  .cover-meta-cell .meta-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 4px; }
  .cover-meta-cell .meta-value { font-size: 13px; font-weight: 600; color: var(--dark); }

  /* ─── TOC ────────────────────────────────────────────── */
  .toc {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 28px 32px;
    margin: 0 0 48px;
    page-break-after: always;
  }
  .toc > h2 { font-size: 18px; font-weight: 700; color: var(--blue); margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .toc-l1 { list-style: decimal; padding-left: 20px; }
  .toc-l2 { list-style: lower-alpha; padding-left: 20px; margin: 4px 0; }
  .toc-l3 { list-style: disc; padding-left: 20px; margin: 2px 0; }
  .toc li { margin: 5px 0; }
  .toc a { color: var(--teal); text-decoration: none; font-weight: 500; font-size: 13px; }
  .toc a:hover { text-decoration: underline; }
  .toc .toc-l2 a { font-weight: 400; color: var(--dark); font-size: 12.5px; }
  .toc .toc-l3 a { font-weight: 400; color: var(--muted); font-size: 12px; }

  /* ─── Typography ─────────────────────────────────────── */
  h1 {
    font-size: 28px;
    font-weight: 800;
    color: var(--blue);
    border-bottom: 3px solid var(--blue);
    padding-bottom: 12px;
    margin: 64px 0 24px;
    page-break-before: always;
    scroll-margin-top: 24px;
  }
  h1:first-child { page-break-before: avoid; margin-top: 0; }

  h2 {
    font-size: 19px;
    font-weight: 700;
    color: var(--teal);
    margin: 40px 0 16px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--teal-light);
    scroll-margin-top: 24px;
  }

  h3 {
    font-size: 15px;
    font-weight: 700;
    color: var(--dark);
    margin: 28px 0 10px;
    scroll-margin-top: 24px;
  }

  h4 {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 20px 0 8px;
  }

  p { margin: 0 0 14px; }
  strong { font-weight: 700; }
  em { font-style: italic; color: var(--dark); }
  a { color: var(--teal); }

  ul, ol { margin: 8px 0 16px 24px; }
  li { margin: 5px 0; line-height: 1.7; }
  li::marker { color: var(--teal); font-weight: 600; }
  ul li::marker { content: "▸  "; }

  /* ─── Code ──────────────────────────────────────────── */
  code {
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    font-size: 12px;
    background: var(--code-bg);
    padding: 2px 7px;
    border-radius: 4px;
    color: #be123c;
    border: 1px solid #E5E7EB;
  }

  .code-wrap {
    margin: 16px 0 24px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #2D3748;
    page-break-inside: avoid;
  }
  .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #1A202C;
    padding: 8px 16px;
    border-bottom: 1px solid #2D3748;
  }
  .code-lang-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #68D391;
  }
  .code-dots { display: flex; gap: 5px; }
  .code-dot { width: 10px; height: 10px; border-radius: 50%; }
  .code-dot.red { background: #FC5C7D; }
  .code-dot.yellow { background: #F6D860; }
  .code-dot.green { background: #6FCB97; }

  pre {
    background: #1A202C;
    color: #E2E8F0;
    margin: 0;
    padding: 20px 24px;
    overflow-x: auto;
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    font-size: 12.5px;
    line-height: 1.7;
    tab-size: 2;
  }
  pre code { background: none; color: inherit; padding: 0; border: none; font-size: inherit; }

  /* ─── Tables ─────────────────────────────────────────── */
  .table-wrap { overflow-x: auto; margin: 16px 0 24px; border-radius: 8px; border: 1px solid var(--border); page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { background: var(--blue); }
  th { color: #fff; padding: 11px 16px; text-align: left; font-weight: 600; font-size: 12px; letter-spacing: 0.02em; white-space: nowrap; }
  td { padding: 10px 16px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.6; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even) { background: var(--bg-subtle); }
  tbody tr:hover { background: var(--info); }
  td code { font-size: 11px; }

  /* ─── Callouts ───────────────────────────────────────── */
  blockquote {
    border-left: 4px solid var(--teal);
    background: var(--success);
    padding: 14px 20px;
    margin: 16px 0;
    border-radius: 0 8px 8px 0;
    color: var(--dark);
  }
  .callout-warn {
    border-left: 4px solid var(--warn-border);
    background: var(--warn);
    padding: 14px 20px;
    margin: 16px 0;
    border-radius: 0 8px 8px 0;
  }
  .callout-info {
    border-left: 4px solid var(--info-border);
    background: var(--info);
    padding: 14px 20px;
    margin: 16px 0;
    border-radius: 0 8px 8px 0;
  }
  .callout-danger {
    border-left: 4px solid var(--danger-border);
    background: var(--danger);
    padding: 14px 20px;
    margin: 16px 0;
    border-radius: 0 8px 8px 0;
  }

  hr { border: none; border-top: 2px solid var(--border); margin: 40px 0; }

  /* ─── Section number badges ─────────────────────────── */
  .section-badge {
    display: inline-block;
    background: var(--blue);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    margin-right: 10px;
    vertical-align: middle;
    letter-spacing: 0.05em;
  }

  /* ─── Print ─────────────────────────────────────────── */
  @media print {
    .sidebar { display: none; }
    .main-content { margin-left: 0; padding: 20mm 22mm; max-width: none; }
    .cover { min-height: auto; padding: 30mm 0; }
    h1 { page-break-before: always; font-size: 22px; }
    h1:first-child { page-break-before: avoid; }
    h2 { font-size: 16px; }
    h3 { font-size: 13px; }
    pre, table, .code-wrap, blockquote { page-break-inside: avoid; }
    .cover-meta-grid { grid-template-columns: repeat(2, 1fr); }
    @page { margin: 2cm 2.5cm; size: A4; }
    @page :first { margin: 0; }
  }

  @media (max-width: 900px) {
    .sidebar { display: none; }
    .main-content { margin-left: 0; padding: 24px; }
  }
</style>
</head>
<body>
<div class="page-wrapper">

<!-- Sidebar Navigation -->
<nav class="sidebar">
  <div class="sidebar-brand">
    <div class="label">Migration Report</div>
    <div class="repo">${escapeHtml(repoInfo.owner)}/${escapeHtml(repoInfo.repo)}</div>
    <div class="arrow">${escapeHtml(detectedStack.framework || detectedStack.primaryLanguage)} &rarr; ${escapeHtml(targetStack)}</div>
  </div>
  <div class="sidebar-nav">
    ${buildSidebarNav(markdown)}
  </div>
</nav>

<!-- Main Content -->
<main class="main-content">

<!-- Cover -->
<div class="cover">
  <div class="cover-eyebrow">Technical Migration Report &mdash; Confidential</div>
  <div class="cover-title">Code Migration<br>Report</div>
  <div class="cover-subtitle">${escapeHtml(repoInfo.description || `${repoInfo.owner}/${repoInfo.repo}`)}</div>
  <div class="cover-migration-badge">
    <span class="from">${escapeHtml(detectedStack.framework || detectedStack.primaryLanguage)}</span>
    <span class="sep">&rarr;</span>
    <span class="to">${escapeHtml(targetStack)}</span>
  </div>
  <hr class="cover-divider">
  <div class="cover-meta-grid">
    ${metaRows.map(([label, value]) => `
    <div class="cover-meta-cell">
      <div class="meta-label">${escapeHtml(label)}</div>
      <div class="meta-value">${escapeHtml(value)}</div>
    </div>`).join('')}
  </div>
</div>

<!-- Table of Contents -->
${toc}

<!-- Report Body -->
<div class="report-body">
${html}
</div>

</main>
</div>
</body>
</html>`;
}
// ─── Sidebar navigation builder ───────────────────────────────────────────────
function buildSidebarNav(markdown) {
    const lines = markdown.split('\n');
    const links = [];
    for (const line of lines) {
        const h1 = line.match(/^# (.+)/);
        const h2 = line.match(/^## (.+)/);
        const h3 = line.match(/^### (.+)/);
        const match = h1 || h2 || h3;
        if (!match) {
            continue;
        }
        const level = h1 ? 1 : h2 ? 2 : 3;
        const text = match[1].replace(/[^\w\s\-–.()/]/g, '').trim();
        const id = text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
        const cls = level === 1 ? 'h1-link' : level === 2 ? 'h2-link' : 'h3-link';
        const short = text.length > 32 ? text.slice(0, 32) + '…' : text;
        links.push(`<a href="#${id}" class="${cls}">${escapeHtml(short)}</a>`);
    }
    return links.join('\n');
}
// ─── Markdown → HTML ──────────────────────────────────────────────────────────
function headingId(text) {
    return text.replace(/[^\w\s\-–.()/]/g, '').trim()
        .toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
}
function markdownToHtml(md) {
    const lines = md.split('\n');
    const out = [];
    let i = 0;
    let inUl = false;
    let inOl = false;
    const esc = escapeHtml;
    /** Inline: bold, italic, inline-code, links */
    const inline = (s) => s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const closeList = () => {
        if (inUl) {
            out.push('</ul>');
            inUl = false;
        }
        if (inOl) {
            out.push('</ol>');
            inOl = false;
        }
    };
    while (i < lines.length) {
        const line = lines[i];
        // Fenced code block
        if (line.trimStart().startsWith('```')) {
            closeList();
            const lang = line.replace(/^[ \t]*```/, '').trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(esc(lines[i]));
                i++;
            }
            const header = `<div class="code-header">
        <div class="code-dots"><div class="code-dot red"></div><div class="code-dot yellow"></div><div class="code-dot green"></div></div>
        ${lang ? `<span class="code-lang-tag">${esc(lang)}</span>` : ''}
      </div>`;
            out.push(`<div class="code-wrap">${header}<pre><code>${codeLines.join('\n')}</code></pre></div>`);
            i++;
            continue;
        }
        // Table
        if (line.trim().startsWith('|') && line.includes('|')) {
            closeList();
            const tableLines = [line];
            i++;
            if (i < lines.length && /^\|[-| :]+\|/.test(lines[i].trim())) {
                i++;
            }
            while (i < lines.length && lines[i].trim().startsWith('|')) {
                tableLines.push(lines[i]);
                i++;
            }
            const parseRow = (l) => l.split('|').slice(1, -1).map(c => c.trim());
            const headers = parseRow(tableLines[0]);
            const rows = tableLines.slice(1).map(parseRow);
            const thead = `<thead><tr>${headers.map(h => `<th>${inline(esc(h))}</th>`).join('')}</tr></thead>`;
            const tbody = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody>`;
            out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
            continue;
        }
        // Headings
        const h1m = line.match(/^# (.+)/);
        const h2m = line.match(/^## (.+)/);
        const h3m = line.match(/^### (.+)/);
        const h4m = line.match(/^#### (.+)/);
        if (h1m) {
            closeList();
            const text = h1m[1].trim();
            const id = headingId(text);
            out.push(`<h1 id="${id}">${inline(esc(text))}</h1>`);
            i++;
            continue;
        }
        if (h2m) {
            closeList();
            const text = h2m[1].trim();
            const id = headingId(text);
            out.push(`<h2 id="${id}">${inline(esc(text))}</h2>`);
            i++;
            continue;
        }
        if (h3m) {
            closeList();
            const text = h3m[1].trim();
            const id = headingId(text);
            out.push(`<h3 id="${id}">${inline(esc(text))}</h3>`);
            i++;
            continue;
        }
        if (h4m) {
            closeList();
            out.push(`<h4>${inline(esc(h4m[1].trim()))}</h4>`);
            i++;
            continue;
        }
        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
            closeList();
            out.push('<hr>');
            i++;
            continue;
        }
        // Blockquote / callout — detect "> NOTE:" / "> WARNING:" / "> DANGER:"
        if (line.trim().startsWith('>')) {
            closeList();
            const content = line.replace(/^>\s*/, '');
            if (/^(WARN|WARNING|CAUTION)/i.test(content)) {
                out.push(`<div class="callout-warn">${inline(esc(content))}</div>`);
            }
            else if (/^(DANGER|ERROR|CRITICAL)/i.test(content)) {
                out.push(`<div class="callout-danger">${inline(esc(content))}</div>`);
            }
            else if (/^(NOTE|INFO|TIP)/i.test(content)) {
                out.push(`<div class="callout-info">${inline(esc(content))}</div>`);
            }
            else {
                out.push(`<blockquote>${inline(esc(content))}</blockquote>`);
            }
            i++;
            continue;
        }
        // Unordered list (supports leading spaces for nesting)
        const ulMatch = line.match(/^(\s*)[*\-] (.+)/);
        if (ulMatch) {
            if (!inUl) {
                if (inOl) {
                    out.push('</ol>');
                    inOl = false;
                }
                out.push('<ul>');
                inUl = true;
            }
            out.push(`<li>${inline(esc(ulMatch[2]))}</li>`);
            i++;
            continue;
        }
        // Ordered list
        const olMatch = line.match(/^(\d+)\. (.+)/);
        if (olMatch) {
            if (!inOl) {
                if (inUl) {
                    out.push('</ul>');
                    inUl = false;
                }
                out.push('<ol>');
                inOl = true;
            }
            out.push(`<li>${inline(esc(olMatch[2]))}</li>`);
            i++;
            continue;
        }
        // Blank line
        if (line.trim() === '') {
            closeList();
            i++;
            continue;
        }
        // Paragraph
        closeList();
        out.push(`<p>${inline(esc(line))}</p>`);
        i++;
    }
    closeList();
    return out.join('\n');
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
//# sourceMappingURL=reportGenerator.js.map