import { Lexer, type Token, type Tokens } from "marked";
import { robotoRegular, robotoBold, robotoItalic, robotoBoldItalic } from "./pdf-fonts";

// ─── Shared: Mermaid filtering ───

function shouldSkipToken(token: Token): boolean {
  if (token.type === "code" && (token as Tokens.Code).lang?.toLowerCase() === "mermaid") return true;
  if (token.type === "html") {
    const text = (token as Tokens.HTML).text;
    if (text.includes("class=\"mermaid\"") || text.includes("diagram-container")) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
//  PDF Export via pdfmake
// ═══════════════════════════════════════════════════════════════════

type PdfContent = any; // pdfmake content node

const PDF_STYLES: Record<string, any> = {
  h1: { fontSize: 22, bold: true, margin: [0, 20, 0, 10] },
  h2: { fontSize: 17, bold: true, margin: [0, 18, 0, 8] },
  h3: { fontSize: 14, bold: true, margin: [0, 14, 0, 6] },
  h4: { fontSize: 12, bold: true, margin: [0, 12, 0, 6] },
  paragraph: { fontSize: 10, lineHeight: 1.5, margin: [0, 0, 0, 8] },
};

function pdfInline(tokens: Token[]): PdfContent {
  if (!tokens || tokens.length === 0) return "";
  const parts: PdfContent[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          const sub = pdfInline(t.tokens);
          if (Array.isArray(sub)) parts.push(...sub);
          else parts.push(sub);
        } else {
          parts.push(t.text);
        }
        break;
      }
      case "strong": {
        const inner = pdfInline((token as Tokens.Strong).tokens);
        parts.push({ text: inner, bold: true });
        break;
      }
      case "em": {
        const inner = pdfInline((token as Tokens.Em).tokens);
        parts.push({ text: inner, italics: true });
        break;
      }
      case "codespan":
        parts.push({ text: (token as Tokens.Codespan).text, font: "Roboto", fontSize: 9, background: "#eef0f2" });
        break;
      case "link": {
        const l = token as Tokens.Link;
        const inner = pdfInline(l.tokens);
        parts.push({ text: inner, link: l.href, color: "#0969da", decoration: "underline" });
        break;
      }
      case "br":
        parts.push("\n");
        break;
      case "escape":
        parts.push((token as Tokens.Escape).text);
        break;
      case "del": {
        const inner = pdfInline((token as Tokens.Del).tokens);
        parts.push({ text: inner, decoration: "lineThrough" });
        break;
      }
      default:
        if ("text" in token) parts.push((token as any).text);
        break;
    }
  }
  if (parts.length === 1) return parts[0];
  return parts;
}

function pdfBlock(tokens: Token[]): PdfContent[] {
  const result: PdfContent[] = [];
  for (const token of tokens) {
    if (shouldSkipToken(token)) continue;
    switch (token.type) {
      case "heading": {
        const h = token as Tokens.Heading;
        const depth = Math.min(h.depth, 4);
        result.push({ text: pdfInline(h.tokens), style: `h${depth}` });
        break;
      }
      case "paragraph": {
        result.push({ text: pdfInline((token as Tokens.Paragraph).tokens), style: "paragraph" });
        break;
      }
      case "code": {
        const c = token as Tokens.Code;
        result.push({
          table: {
            widths: ["*"],
            body: [[{ text: c.text, font: "Roboto", fontSize: 8.5, preserveLeadingSpaces: true }]],
          },
          layout: {
            fillColor: () => "#f6f8fa",
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => "#d1d9e0",
            vLineColor: () => "#d1d9e0",
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: [0, 0, 0, 8],
        });
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item) => {
          const children = pdfBlock(item.tokens);
          if (children.length === 1 && children[0].text !== undefined) {
            return children[0].text;
          }
          return { stack: children };
        });
        if (list.ordered) {
          result.push({ ol: items, margin: [0, 0, 0, 8] });
        } else {
          result.push({ ul: items, margin: [0, 0, 0, 8] });
        }
        break;
      }
      case "table": {
        const t = token as Tokens.Table;
        const headerRow = t.header.map((cell) => ({
          text: pdfInline(cell.tokens),
          bold: true,
          fillColor: "#f6f8fa",
          fontSize: 9,
        }));
        const dataRows = t.rows.map((row) =>
          row.map((cell) => ({ text: pdfInline(cell.tokens), fontSize: 9 })),
        );
        result.push({
          table: {
            headerRows: 1,
            widths: Array(t.header.length).fill("*"),
            body: [headerRow, ...dataRows],
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 8],
        });
        break;
      }
      case "blockquote": {
        const bq = token as Tokens.Blockquote;
        const inner = pdfBlock(bq.tokens);
        result.push({
          table: {
            widths: ["*"],
            body: [[{ stack: inner, color: "#656d76" }]],
          },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i: number) => (i === 0 ? 3 : 0),
            vLineColor: () => "#d1d9e0",
            paddingLeft: () => 10,
            paddingRight: () => 4,
            paddingTop: () => 4,
            paddingBottom: () => 4,
          },
          margin: [0, 0, 0, 8],
        });
        break;
      }
      case "hr":
        result.push({
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineColor: "#d1d9e0" }],
          margin: [0, 8, 0, 8],
        });
        break;
      case "space":
        break;
      case "html":
        // Skip raw HTML (diagrams, etc.)
        break;
      default:
        if ("text" in token) {
          result.push({ text: (token as any).text, style: "paragraph" });
        }
        break;
    }
  }
  return result;
}

export async function exportPdf(markdown: string, title: string): Promise<Buffer> {
  const tokens = new Lexer().lex(markdown);
  const content = pdfBlock(tokens);

  // Font data is embedded at build time via pdf-fonts.ts
  const vfsPaths: Record<string, Buffer> = {
    "fonts/Roboto-Regular.ttf": robotoRegular,
    "fonts/Roboto-Medium.ttf": robotoBold,
    "fonts/Roboto-Italic.ttf": robotoItalic,
    "fonts/Roboto-MediumItalic.ttf": robotoBoldItalic,
  };

  const virtualfs = {
    existsSync: (p: string) => p in vfsPaths,
    readFileSync: (p: string) => vfsPaths[p],
  };

  const fontDescriptors = {
    Roboto: {
      normal: "fonts/Roboto-Regular.ttf",
      bold: "fonts/Roboto-Medium.ttf",
      italics: "fonts/Roboto-Italic.ttf",
      bolditalics: "fonts/Roboto-MediumItalic.ttf",
    },
  };

  // @ts-ignore — pdfmake server-side Printer has no type declarations
  const PdfPrinter = (await import("pdfmake/src/Printer.js")).default;
  const printer = new PdfPrinter(fontDescriptors, virtualfs);

  const docDefinition = {
    info: { title },
    content,
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.5 },
    styles: PDF_STYLES,
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: "center",
      fontSize: 8,
      color: "#656d76",
      margin: [0, 10, 0, 0],
    }),
    pageMargins: [40, 40, 40, 50] as [number, number, number, number],
  };

  const pdfDoc = await printer.createPdfKitDocument(docDefinition);
  pdfDoc.end();

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
    pdfDoc.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DOCX Export via docx
// ═══════════════════════════════════════════════════════════════════

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  BorderStyle, WidthType, AlignmentType, ExternalHyperlink,
  LevelFormat, ShadingType, convertInchesToTwip,
} from "docx";

const BODY_FONT = "Segoe UI";
const CODE_FONT = "Consolas";
const HEADING_COLOR = "1f2328";
const LINK_COLOR = "0969da";
const CODE_BG = "f6f8fa";
const BORDER_COLOR = "d1d9e0";


function docxInline(tokens: Token[], baseProps?: Partial<{ bold: boolean; italics: boolean }>): (TextRun | ExternalHyperlink)[] {
  if (!tokens || tokens.length === 0) return [];
  const runs: (TextRun | ExternalHyperlink)[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          runs.push(...docxInline(t.tokens, baseProps));
        } else {
          runs.push(new TextRun({ text: t.text, font: BODY_FONT, ...baseProps }));
        }
        break;
      }
      case "strong":
        runs.push(...docxInline((token as Tokens.Strong).tokens, { ...baseProps, bold: true }));
        break;
      case "em":
        runs.push(...docxInline((token as Tokens.Em).tokens, { ...baseProps, italics: true }));
        break;
      case "codespan":
        runs.push(new TextRun({
          text: (token as Tokens.Codespan).text,
          font: CODE_FONT,
          size: 19,
          shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: "auto" },
          ...baseProps,
        }));
        break;
      case "link": {
        const l = token as Tokens.Link;
        runs.push(new ExternalHyperlink({
          children: docxInline(l.tokens).map((r) =>
            r instanceof TextRun
              ? new TextRun({ ...((r as any).root?.[1] ?? {}), color: LINK_COLOR, underline: {} })
              : r,
          ),
          link: l.href,
        }));
        break;
      }
      case "br":
        runs.push(new TextRun({ break: 1 }));
        break;
      case "escape":
        runs.push(new TextRun({ text: (token as Tokens.Escape).text, font: BODY_FONT, ...baseProps }));
        break;
      case "del":
        runs.push(...docxInline((token as Tokens.Del).tokens, { ...baseProps }).map((r) =>
          r instanceof TextRun ? new TextRun({ ...(r as any).root?.[1], strike: true }) : r,
        ));
        break;
      default:
        if ("text" in token) {
          runs.push(new TextRun({ text: (token as any).text, font: BODY_FONT, ...baseProps }));
        }
        break;
    }
  }
  return runs;
}

function docxBlock(tokens: Token[], listLevel?: number): (Paragraph | Table)[] {
  const result: (Paragraph | Table)[] = [];
  for (const token of tokens) {
    if (shouldSkipToken(token)) continue;
    switch (token.type) {
      case "heading": {
        const h = token as Tokens.Heading;
        const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][Math.min(h.depth - 1, 5)];
        result.push(new Paragraph({
          heading: level,
          children: docxInline(h.tokens) as TextRun[],
          spacing: { before: 240, after: 120 },
        }));
        break;
      }
      case "paragraph": {
        const children = docxInline((token as Tokens.Paragraph).tokens);
        if (listLevel !== undefined) {
          result.push(new Paragraph({ children: children as TextRun[], spacing: { after: 80 } }));
        } else {
          result.push(new Paragraph({ children: children as TextRun[], spacing: { after: 160 } }));
        }
        break;
      }
      case "code": {
        const c = token as Tokens.Code;
        const lines = c.text.split("\n");
        const codeParagraphs = lines.map((line) =>
          new Paragraph({
            children: [new TextRun({ text: line || " ", font: CODE_FONT, size: 18 })],
            spacing: { after: 0, line: 260 },
          }),
        );
        result.push(new Table({
          rows: [new TableRow({
            children: [new TableCell({
              children: codeParagraphs,
              shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: "auto" },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
                left: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
                right: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
              },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
            })],
          })],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }));
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        const level = listLevel ?? 0;
        for (const item of list.items) {
          const itemBlocks = docxBlock(item.tokens, level);
          for (let i = 0; i < itemBlocks.length; i++) {
            const block = itemBlocks[i];
            if (i === 0 && block instanceof Paragraph) {
              const props: any = {};
              if (list.ordered) {
                props.numbering = { reference: "ordered-list", level };
              } else {
                props.bullet = { level };
              }
              result.push(new Paragraph({
                ...props,
                children: (block as any).root?.[1]?.children ?? [],
                spacing: { after: 80 },
              }));
            } else {
              result.push(block);
            }
          }
        }
        break;
      }
      case "table": {
        const t = token as Tokens.Table;
        const headerRow = new TableRow({
          children: t.header.map((cell) =>
            new TableCell({
              children: [new Paragraph({ children: docxInline(cell.tokens, { bold: true }) as TextRun[] })],
              shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: "auto" },
            }),
          ),
        });
        const dataRows = t.rows.map((row) =>
          new TableRow({
            children: row.map((cell) =>
              new TableCell({
                children: [new Paragraph({ children: docxInline(cell.tokens) as TextRun[] })],
              }),
            ),
          }),
        );
        result.push(new Table({
          rows: [headerRow, ...dataRows],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }));
        break;
      }
      case "blockquote": {
        const bq = token as Tokens.Blockquote;
        const inner = docxBlock(bq.tokens);
        for (const block of inner) {
          if (block instanceof Paragraph) {
            result.push(new Paragraph({
              children: (block as any).root?.[1]?.children ?? [],
              indent: { left: convertInchesToTwip(0.4) },
              border: {
                left: { style: BorderStyle.SINGLE, size: 6, color: BORDER_COLOR, space: 8 },
              },
              spacing: { after: 120 },
            }));
          } else {
            result.push(block);
          }
        }
        break;
      }
      case "hr":
        result.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: BORDER_COLOR } },
          spacing: { before: 120, after: 120 },
        }));
        break;
      case "space":
        break;
      case "html":
        break;
      default:
        if ("text" in token) {
          result.push(new Paragraph({
            children: [new TextRun({ text: (token as any).text, font: BODY_FONT })],
            spacing: { after: 160 },
          }));
        }
        break;
    }
  }
  return result;
}

export async function exportDocx(markdown: string, title: string): Promise<Buffer> {
  const tokens = new Lexer().lex(markdown);
  const children = docxBlock(tokens);

  const doc = new Document({
    title,
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 22, color: HEADING_COLOR },
          paragraph: { spacing: { after: 160, line: 340 } },
        },
        heading1: {
          run: { size: 44, bold: true, color: HEADING_COLOR, font: BODY_FONT },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading2: {
          run: { size: 34, bold: true, color: HEADING_COLOR, font: BODY_FONT },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading3: {
          run: { size: 28, bold: true, color: HEADING_COLOR, font: BODY_FONT },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
        heading4: {
          run: { size: 24, bold: true, color: HEADING_COLOR, font: BODY_FONT },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    },
    numbering: {
      config: [{
        reference: "ordered-list",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2)", alignment: AlignmentType.START },
          { level: 2, format: LevelFormat.LOWER_ROMAN, text: "%3.", alignment: AlignmentType.START },
        ],
      }],
    },
    sections: [{
      properties: {},
      children,
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
