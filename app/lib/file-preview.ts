import JSZip from "jszip";
import type { LocalFileRecord } from "./local-store";

export type LocalPreview =
  | { kind: "image"; url: string }
  | { kind: "pdf"; url: string }
  | { kind: "word"; paragraphs: string[] }
  | { kind: "slides"; slides: Array<{ number: number; lines: string[] }> }
  | { kind: "server"; url: string; render: "image" | "pdf" | "other" }
  | { kind: "unsupported"; message: string };

export async function buildLocalPreview(record: LocalFileRecord): Promise<LocalPreview> {
  const name = record.name.toLowerCase();
  if (record.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return { kind: "image", url: URL.createObjectURL(record.blob) };
  }
  if (record.type === "application/pdf" || name.endsWith(".pdf")) {
    return { kind: "pdf", url: URL.createObjectURL(record.blob) };
  }
  if (name.endsWith(".docx")) {
    return extractWordPreview(record.blob);
  }
  if (name.endsWith(".pptx")) {
    return extractPowerPointPreview(record.blob);
  }
  if (name.endsWith(".doc") || name.endsWith(".ppt")) {
    return {
      kind: "unsupported",
      message: "旧版 .doc/.ppt 文件已安全保存，但浏览器无法直接渲染。建议另存为 .docx/.pptx 后重新上传。",
    };
  }
  return { kind: "unsupported", message: "该文件已保存在本地，但当前没有可用的预览器。" };
}

export function releaseLocalPreview(preview: LocalPreview | null) {
  if (preview && (preview.kind === "image" || preview.kind === "pdf")) {
    URL.revokeObjectURL(preview.url);
  }
}

async function extractWordPreview(blob: Blob): Promise<LocalPreview> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return { kind: "unsupported", message: "Word 文档结构不完整，无法生成预览。" };
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphs = Array.from(document.getElementsByTagName("w:p"))
    .map((paragraph) =>
      Array.from(paragraph.getElementsByTagName("w:t"))
        .map((node) => node.textContent ?? "")
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 300);
  return {
    kind: "word",
    paragraphs: paragraphs.length ? paragraphs : ["文档没有可显示的文本内容。"],
  };
}

async function extractPowerPointPreview(blob: Blob): Promise<LocalPreview> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  const slides = [];
  for (const [index, name] of slideNames.slice(0, 100).entries()) {
    const xml = await zip.file(name)?.async("string");
    if (!xml) continue;
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const lines = Array.from(document.getElementsByTagName("a:t"))
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean)
      .slice(0, 80);
    slides.push({ number: index + 1, lines });
  }
  return slides.length
    ? { kind: "slides", slides }
    : { kind: "unsupported", message: "PPT 文档没有可显示的幻灯片文本。" };
}

function slideNumber(name: string) {
  return Number(name.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
}

