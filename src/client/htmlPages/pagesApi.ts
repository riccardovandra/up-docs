// The client's calls to /api/pages. Uploads send the HTML file as the raw
// request body (text/html), which the API accepts only from the app's origin.

import { pageContentPath, type PageListItem, type PageView } from "../../shared/htmlPages.ts";
import { ApiError, request } from "../api.ts";

export const PAGES_PATH = "/pages";

async function upload(path: string, file: Blob): Promise<PageView> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: file,
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data as ApiError["body"]);
  return (data as { page: PageView }).page;
}

const query = (entries: Record<string, string | null | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value != null) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
};

export const pagesApi = {
  list: () => request<{ pages: Array<PageListItem> }>("GET", "/api/pages").then((body) => body.pages),
  get: (pageId: string) =>
    request<{ page: PageView }>("GET", `/api/pages/${pageId}`).then((body) => body.page),
  create: (input: { readonly title: string; readonly projectId: string | null; readonly file: Blob }) =>
    upload(`/api/pages${query({ title: input.title, projectId: input.projectId ?? "none" })}`, input.file),
  addVersion: (pageId: string, file: Blob, note?: string) =>
    upload(`/api/pages/${pageId}/versions${query({ note })}`, file),
  rename: (pageId: string, title: string) =>
    request<{ page: PageView }>("PATCH", `/api/pages/${pageId}`, { title }).then((body) => body.page),
  move: (pageId: string, projectId: string | null) =>
    request<{ page: PageView }>("PATCH", `/api/pages/${pageId}`, { projectId }).then((body) => body.page),
  remove: (pageId: string) => request<{ ok: true }>("DELETE", `/api/pages/${pageId}`),
  contentUrl: pageContentPath,
  downloadUrl: (pageId: string, version: number) => `/api/pages/${pageId}/versions/${version}/download`,
};

/** An upload refusal in words. */
export function uploadErrorText(cause: unknown): string {
  const code = cause instanceof ApiError ? cause.body.error : undefined;
  if (code === "page_too_large") return "That file is over the 5 MB limit for a page.";
  if (code === "invalid_html") return "That file is not an HTML page saved as UTF-8 text.";
  if (code === "forbidden") return "You can view this page but not upload to it.";
  return "Could not upload the file. Try again.";
}

/** A file's name without its extension, as a new page's title. */
export const titleFromFile = (file: File) => file.name.replace(/\.html?$/i, "").trim() || "Untitled page";

export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
