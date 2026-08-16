import type { Confidence, ExtractResult } from "./ai-contract";
import type { PDFDocumentProxy } from "pdfjs-dist";

const MAX_TEXT_PAGES = 80;
const MAX_TEXT_CHARS = 36_000;
const MIN_TEXT_CHARS = 20;
const MAX_IMAGE_PAGES = 3;
const MAX_RENDER_WIDTH = 1_600;

export type PdfImportExtraction = {
  text: string;
  pageCount: number;
  extractedPageCount: number;
  previewImages: string[];
};

/**
 * Extracts a PDF locally in the browser. The PDF bytes never leave the device;
 * only the extracted text or a small page image is sent to the model route.
 */
export async function extractPdfForImport(
  file: File,
  signal?: AbortSignal,
): Promise<PdfImportExtraction> {
  throwIfAborted(signal);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const document = await loadingTask.promise;
  const textPages: string[] = [];
  let extractedPageCount = 0;

  try {
    const pagesToRead = Math.min(document.numPages, MAX_TEXT_PAGES);
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (pageText) {
          textPages.push(`第${pageNumber}页：${pageText}`);
          extractedPageCount += 1;
        }
      } finally {
        page.cleanup();
      }

      if (textPages.join("\n").length >= MAX_TEXT_CHARS) break;
    }

    const text = textPages.join("\n").slice(0, MAX_TEXT_CHARS).trim();
    if (text.length >= MIN_TEXT_CHARS) {
      return {
        text: `PDF正文（共${document.numPages}页，已读取${pagesToRead}页）：\n${text}`,
        pageCount: document.numPages,
        extractedPageCount,
        previewImages: [],
      };
    }

    const previewImages = await renderPreviewPages(document, signal);
    return {
      text: "",
      pageCount: document.numPages,
      extractedPageCount,
      previewImages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

/** Merge page-level vision results into one confirmation draft. */
export function mergeExtractResults(results: ExtractResult[]): ExtractResult {
  const tasks = results
    .flatMap((result) => result.tasks)
    .filter((task, index, all) =>
      all.findIndex((candidate) =>
        candidate.title === task.title && candidate.dueAt === task.dueAt,
      ) === index,
    )
    .slice(0, 10);
  const resources = results
    .map((result) => result.resource)
    .filter((resource): resource is NonNullable<typeof resource> => Boolean(resource));
  const confidence: Confidence = resources.some((item) => item.confidence === "high")
    ? "high"
    : resources.some((item) => item.confidence === "medium")
      ? "medium"
      : "low";
  const resource = resources.length
    ? {
        ...resources[0],
        tags: [...new Set(resources.flatMap((item) => item.tags))].slice(0, 8),
        confidence,
        evidence: resources.map((item) => item.evidence).filter(Boolean).slice(0, 3).join("；"),
      }
    : null;

  return {
    summary: results.map((result) => result.summary).filter(Boolean).slice(0, 3).join("；") || "没有识别到可直接写入的信息。",
    tasks,
    resource,
    questions: [...new Set(results.flatMap((result) => result.questions))].slice(0, 8),
    requiresConfirmation: true,
  };
}

async function renderPreviewPages(
  document: PDFDocumentProxy,
  signal?: AbortSignal,
) {
  const images: string[] = [];
  const pagesToRender = Math.min(document.numPages, MAX_IMAGE_PAGES);
  for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
    throwIfAborted(signal);
    const page = await document.getPage(pageNumber);
    try {
      const initialViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1.8, MAX_RENDER_WIDTH / initialViewport.width);
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) continue;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.78));
      canvas.width = 1;
      canvas.height = 1;
    } finally {
      page.cleanup();
    }
  }
  return images;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}
