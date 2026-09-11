// 资料正文抽取：把入库文件的可检索文本提取出来，供 Agent 的 read_resource / search_resources 使用。
// 浏览器本地完成，不发送给任何服务器。
import JSZip from "jszip";
import { extractPdfForImport } from "./pdf-extract";

export const MAX_CONTENT_TEXT_CHARS = 20_000;

export async function extractSearchableText(file: File): Promise<string> {
  try {
    const name = file.name.toLowerCase();
    if (file.type === "application/pdf" || name.endsWith(".pdf")) {
      const extraction = await extractPdfForImport(file);
      return cap(extraction.text);
    }
    if (name.endsWith(".docx")) {
      return cap(await extractWordText(file));
    }
    if (name.endsWith(".pptx")) {
      return cap(await extractSlidesText(file));
    }
    return "";
  } catch {
    return "";
  }
}

function cap(text: string) {
  return text.replace(/\s+\n/g, "\n").trim().slice(0, MAX_CONTENT_TEXT_CHARS);
}

async function extractWordText(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("w:p"))
    .map((paragraph) =>
      Array.from(paragraph.getElementsByTagName("w:t"))
        .map((node) => node.textContent ?? "")
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

async function extractSlidesText(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const parts: string[] = [];
  for (const [index, name] of slideNames.slice(0, 100).entries()) {
    const xml = await zip.file(name)?.async("string");
    if (!xml) continue;
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const lines = Array.from(document.getElementsByTagName("a:t"))
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean);
    if (lines.length) parts.push(`第${index + 1}页：${lines.join(" ")}`);
  }
  return parts.join("\n");
}

function slideNumber(name: string) {
  return Number(name.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
}
