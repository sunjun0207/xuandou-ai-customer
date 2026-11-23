import { apiFetch } from "./session";

export type UploadCredential = {
  token: string;
  key: string;
  uploadUrl: string;
  publicUrl: string;
  maxBytes: number;
  maxLabel: string;
};

export async function fetchUploadCredential(file: File): Promise<UploadCredential> {
  const res = await apiFetch("/api/upload/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, mime: file.type, fileSize: file.size }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<UploadCredential> & { error?: string };
  if (!res.ok || !body.token || !body.key || !body.uploadUrl || !body.publicUrl) {
    throw new Error(body.error || "上传凭证没有拿到");
  }
  return {
    token: body.token,
    key: body.key,
    uploadUrl: body.uploadUrl,
    publicUrl: body.publicUrl,
    maxBytes: body.maxBytes || 0,
    maxLabel: body.maxLabel || "",
  };
}

export function postQiniu(file: File, creds: UploadCredential, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("token", creds.token);
    form.append("key", creds.key);
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", creds.uploadUrl);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && !qiniuError(xhr.responseText)) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(uploadError(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => reject(new Error("上传没有连上七牛，请稍后重试"));
    xhr.send(form);
  });
}

function qiniuError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

function uploadError(status: number, raw: string): string {
  const message = qiniuError(raw) || raw.trim();
  if (/fsize|too large|exceed/i.test(message)) return "文件超过大小限制";
  if (status === 401 || /bad token|token/i.test(message)) return "上传凭证失效，请重试";
  if (status === 614 || /exists/i.test(message)) return "同名文件已存在，请重试";
  return "上传失败，请稍后重试";
}
