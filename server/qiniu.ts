import { createHmac, randomBytes } from "crypto";
import type { ChatAttachment } from "../shared/protocol";
import { extensionOf, formatMaxLabel, MAX_ATTACHMENTS, parseMaxBytes } from "../shared/upload";

const KEY_RE = /^xuandou-ai-customer\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.[a-z0-9]{1,16}$/;
const TOKEN_TTL_SECONDS = 3600;

export type QiniuConfig = {
  accessKey: string;
  secretKey: string;
  bucket: string;
  publicDomain: string;
  uploadDomain: string;
  maxBytes: number;
  maxLabel: string;
};

export type UploadCredential = {
  token: string;
  key: string;
  uploadUrl: string;
  publicUrl: string;
  maxBytes: number;
  maxLabel: string;
};

export function qiniuConfig(): QiniuConfig | undefined {
  const accessKey = text(process.env.QINIU_ACCESS_KEY);
  const secretKey = text(process.env.QINIU_SECRET_KEY);
  const bucket = text(process.env.QINIU_BUCKET);
  const useHttps = process.env.QINIU_USE_HTTPS !== "false";
  const publicDomain = rootUrl(text(process.env.QINIU_PUBLIC_DOMAIN), useHttps);
  const uploadDomain = rootUrl(text(process.env.QINIU_UPLOAD_DOMAIN), true);
  const maxBytes = parseMaxBytes(process.env.UPLOAD_MAX_BYTES);
  if (!accessKey || !secretKey || !bucket || !publicDomain || !uploadDomain) return undefined;
  return { accessKey, secretKey, bucket, publicDomain, uploadDomain, maxBytes, maxLabel: formatMaxLabel(maxBytes) };
}

export function uploadLimit(): { maxBytes: number; maxLabel: string } {
  const maxBytes = parseMaxBytes(process.env.UPLOAD_MAX_BYTES);
  return { maxBytes, maxLabel: formatMaxLabel(maxBytes) };
}

export function issueUpload(fileName: string, mime: string, fileSize: number): UploadCredential | { error: string; status: number } {
  const cfg = qiniuConfig();
  if (!cfg) return { error: "上传还没配好", status: 503 };
  if (!Number.isFinite(fileSize) || fileSize <= 0) return { error: "文件是空的", status: 400 };
  if (fileSize > cfg.maxBytes) return { error: `文件不能超过 ${cfg.maxLabel}`, status: 400 };
  const ext = extensionOf(fileName, mime);
  if (!ext) return { error: `不支持的文件类型：${fileName || mime || "未知"}`, status: 400 };
  const key = objectKey(ext);
  const deadline = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = uploadToken(cfg, key, deadline);
  return {
    token,
    key,
    uploadUrl: cfg.uploadDomain,
    publicUrl: `${cfg.publicDomain}/${key}`,
    maxBytes: cfg.maxBytes,
    maxLabel: cfg.maxLabel,
  };
}

export function attachmentError(items: ChatAttachment[]): string {
  if (!items.length) return "";
  const cfg = qiniuConfig();
  const limit = uploadLimit();
  if (!cfg) return "上传还没配好";
  if (items.length > MAX_ATTACHMENTS) return "一次最多 9 个附件";
  for (const item of items) {
    if (!Number.isFinite(item.size) || item.size <= 0) return "文件是空的";
    if (item.size > limit.maxBytes) return `文件不能超过 ${limit.maxLabel}`;
    if (!allowedPublicUrl(item.url, cfg.publicDomain)) return "附件地址不正确";
    const keyExt = item.url.slice(item.url.lastIndexOf(".") + 1).toLowerCase();
    if (!keyExt || extensionOf(item.name, item.mime) !== keyExt) return "附件地址不正确";
  }
  return "";
}

export function uploadToken(cfg: Pick<QiniuConfig, "accessKey" | "secretKey" | "bucket" | "maxBytes">, key: string, deadline: number): string {
  const policy = JSON.stringify({
    scope: `${cfg.bucket}:${key}`,
    deadline,
    insertOnly: 1,
    fsizeLimit: cfg.maxBytes,
  });
  const encoded = urlsafeBase64(policy);
  const sign = urlsafeBase64(createHmac("sha1", cfg.secretKey).update(encoded).digest());
  return `${cfg.accessKey}:${sign}:${encoded}`;
}

function allowedPublicUrl(raw: string, publicDomain: string): boolean {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(raw);
    expected = new URL(publicDomain);
  } catch {
    return false;
  }
  if (url.origin !== expected.origin || url.search || url.hash) return false;
  let path = url.pathname.replace(/^\/+/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }
  return KEY_RE.test(path);
}

function objectKey(ext: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `xuandou-ai-customer/${yyyy}/${mm}/${dd}/${randomBytes(16).toString("hex")}.${ext}`;
}

function rootUrl(raw: string, useHttps: boolean): string {
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `${useHttps ? "https" : "http"}://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

function urlsafeBase64(value: Buffer | string): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function text(value: string | undefined): string {
  return (value || "").trim();
}
