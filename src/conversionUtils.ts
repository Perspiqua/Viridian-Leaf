/**
 * Conversion utilities for PDF to Word, PowerPoint, Excel
 * and AI summarization using Transformers.js
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } from "docx";
import PptxGenJS from "pptxgenjs";
import * as XLSX from "xlsx";

// Types
export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface ExtractedContent {
  text: string;
  pages: PageContent[];
}

export interface PageContent {
  pageNum: number;
  text: string;
  textItems: TextItem[];
}

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function buildStructuredPageText(textItems: TextItem[]): string {
  const yTolerance = 4;
  const rows: TextItem[][] = [];

  for (const item of textItems.filter(item => item.str.trim())) {
    const row = rows.find(existing => Math.abs(existing[0].y - item.y) <= yTolerance);
    if (row) {
      row.push(item);
    } else {
      rows.push([item]);
    }
  }

  return rows
    .sort((a, b) => b[0].y - a[0].y)
    .map(row => {
      const sorted = row.sort((a, b) => a.x - b.x);
      return sorted
        .map((item, index) => {
          const text = item.str.trim();
          if (index === 0) return text;

          const previous = sorted[index - 1];
          const gap = item.x - (previous.x + previous.width);
          return `${gap > 24 ? " | " : " "}${text}`;
        })
        .join("")
        .replace(/\s+\|/g, " |")
        .replace(/\|\s+/g, "| ")
        .trim();
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract text content from PDF pages with position info
 */
export async function extractPdfContent(
  doc: any,
  onProgress?: (page: number, total: number) => void
): Promise<ExtractedContent> {
  const pages: PageContent[] = [];
  let fullText = "";

  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i, doc.numPages);

    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();

    const textItems: TextItem[] = textContent.items.map((item: any) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: item.height || 0,
    }));

    const pageText = buildStructuredPageText(textItems);
    fullText += `Page ${i}\n${pageText}\n\n`;

    pages.push({
      pageNum: i,
      text: pageText,
      textItems,
    });
  }

  return { text: fullText.trim(), pages };
}

/**
 * Detect tables from text items based on alignment
 */
export function detectTables(textItems: TextItem[]): TableData[] {
  const tables: TableData[] = [];

  // Group items by Y position (rows)
  const yGroups = new Map<number, TextItem[]>();
  const yTolerance = 5;

  for (const item of textItems) {
    let foundGroup = false;
    for (const [y, group] of yGroups) {
      if (Math.abs(item.y - y) < yTolerance) {
        group.push(item);
        foundGroup = true;
        break;
      }
    }
    if (!foundGroup) {
      yGroups.set(item.y, [item]);
    }
  }

  // Sort rows by Y position (top to bottom)
  const rows = Array.from(yGroups.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([_, items]) => items.sort((a, b) => a.x - b.x));

  // Find potential table regions (rows with similar column structure)
  let currentTable: string[][] = [];
  let lastColumnCount = 0;

  for (const row of rows) {
    const cells = row.map(item => item.str.trim()).filter(s => s.length > 0);

    if (cells.length >= 2) {
      if (currentTable.length === 0 || Math.abs(cells.length - lastColumnCount) <= 1) {
        currentTable.push(cells);
        lastColumnCount = cells.length;
      } else if (currentTable.length >= 2) {
        // Save current table and start new one
        tables.push({
          headers: currentTable[0],
          rows: currentTable.slice(1),
        });
        currentTable = [cells];
        lastColumnCount = cells.length;
      }
    } else if (currentTable.length >= 2) {
      tables.push({
        headers: currentTable[0],
        rows: currentTable.slice(1),
      });
      currentTable = [];
      lastColumnCount = 0;
    }
  }

  // Don't forget last table
  if (currentTable.length >= 2) {
    tables.push({
      headers: currentTable[0],
      rows: currentTable.slice(1),
    });
  }

  return tables;
}

/**
 * Convert PDF content to Word document
 */
export async function convertToWord(
  content: ExtractedContent,
  filename: string
): Promise<Uint8Array> {
  const children: Paragraph[] = [];

  // Add title
  children.push(
    new Paragraph({
      text: filename.replace(".pdf", ""),
      heading: HeadingLevel.HEADING_1,
    })
  );

  // Add content page by page
  for (const page of content.pages) {
    children.push(
      new Paragraph({
        text: `Page ${page.pageNum}`,
        heading: HeadingLevel.HEADING_2,
      })
    );

    // Split text into paragraphs
    const paragraphs = page.text.split(/\n\s*\n/);
    for (const para of paragraphs) {
      if (para.trim()) {
        children.push(
          new Paragraph({
            children: [new TextRun(para.trim())],
          })
        );
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children,
    }],
  });

  // Use toBlob for browser compatibility (toBuffer requires Node.js)
  const blob = await Packer.toBlob(doc);
  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Convert PDF content to PowerPoint
 */
export async function convertToPowerPoint(
  content: ExtractedContent,
  filename: string
): Promise<Uint8Array> {
  const pptx = new PptxGenJS();

  // Set presentation properties
  pptx.title = filename.replace(".pdf", "");
  pptx.author = "Viridian Leaf";

  // Title slide
  const titleSlide = pptx.addSlide();
  titleSlide.addText(filename.replace(".pdf", ""), {
    x: 0.5,
    y: 2,
    w: "90%",
    h: 1.5,
    fontSize: 36,
    bold: true,
    align: "center",
  });
  titleSlide.addText("Converted by Viridian Leaf", {
    x: 0.5,
    y: 4,
    w: "90%",
    h: 0.5,
    fontSize: 14,
    align: "center",
    color: "666666",
  });

  // Content slides (one per page)
  for (const page of content.pages) {
    const slide = pptx.addSlide();

    slide.addText(`Page ${page.pageNum}`, {
      x: 0.5,
      y: 0.3,
      w: "90%",
      h: 0.5,
      fontSize: 18,
      bold: true,
    });

    // Truncate text if too long for slide
    const maxChars = 2000;
    const text = page.text.length > maxChars
      ? page.text.substring(0, maxChars) + "..."
      : page.text;

    slide.addText(text, {
      x: 0.5,
      y: 1,
      w: "90%",
      h: 5,
      fontSize: 11,
      valign: "top",
    });
  }

  // Generate as base64 and convert to Uint8Array
  const base64 = await pptx.write({ outputType: "base64" }) as string;
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert tables to Excel workbook
 */
export function convertTablesToExcel(
  tables: TableData[],
  filename: string
): Uint8Array {
  const workbook = XLSX.utils.book_new();

  if (tables.length === 0) {
    // Create empty sheet with message
    const ws = XLSX.utils.aoa_to_sheet([["No tables detected in PDF"]]);
    XLSX.utils.book_append_sheet(workbook, ws, "Sheet1");
  } else {
    // Create a sheet for each table
    tables.forEach((table, index) => {
      const data = [table.headers, ...table.rows];
      const ws = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, ws, `Table ${index + 1}`);
    });
  }

  // Generate as array buffer
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Uint8Array(buffer);
}

/**
 * Extract all tables from PDF and convert to Excel
 */
export async function extractTablesToExcel(
  doc: any,
  filename: string,
  onProgress?: (page: number, total: number) => void
): Promise<Uint8Array> {
  const allTables: TableData[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i, doc.numPages);

    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();

    const textItems: TextItem[] = textContent.items.map((item: any) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: item.height || 0,
    }));

    const pageTables = detectTables(textItems);
    allTables.push(...pageTables);
  }

  return convertTablesToExcel(allTables, filename);
}
