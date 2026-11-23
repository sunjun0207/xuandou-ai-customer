export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 9;

const ALLOWED = new Set([
  "txt",
  "pdf",
  "doc",
  "docx",
  "word",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "mp4",
  "mp3",
  "avi",
  "mov",
  "wmv",
  "flv",
  "mkv",
  "wav",
  "aac",
  "flac",
  "m4a",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "zip",
  "rar",
  "7z",
  "csv",
  "json",
  "xml",
  "md",
  "log",
]);

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
};

export function parseMaxBytes(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(value), 1024 * 1024 * 1024);
}

export function formatMaxLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (Number.isInteger(mb) && mb >= 1) return `${mb}MB`;
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)}KB`;
  return `${bytes}B`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)}MB`;
}

export function extensionOf(name: string, mime: string): string {
  const fromName = extensionFromName(name);
  if (fromName && ALLOWED.has(fromName)) return fromName;
  const normalized = mime.toLowerCase().split(";")[0].trim();
  const fromMime = MIME_EXT[normalized] || "";
  return fromMime && ALLOWED.has(fromMime) ? fromMime : "";
}

export function extensionFromName(name: string): string {
  const base = name.trim().split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isImageFile(mime: string, name: string): boolean {
  if (mime.toLowerCase().startsWith("image/")) return true;
  const ext = extensionFromName(name);
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "bmp" || ext === "svg" || ext === "ico";
}

export function displayFileName(name: string, ext: string): string {
  const base = (name || `附件.${ext}`).replace(/[/\\]/g, " ").replace(/\s+/g, " ").trim() || `附件.${ext}`;
  if (base.toLowerCase().endsWith(`.${ext}`)) return base.slice(0, 120);
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim() || "附件";
  return `${stem}.${ext}`.slice(0, 120);
}
