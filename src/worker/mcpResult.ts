// What an MCP tool answers with besides plain JSON: pictures, and errors the
// agent reads. Shared by mcpTools.ts and mcpDesigns.ts.

/** A picture handed to the agent beside a tool's JSON; `data` is base64. */
export interface ToolImage {
  readonly data: string;
  readonly mimeType: string;
}

/** A tool result that carries pictures: `body` is the JSON, the images follow it. */
export class ToolResultWithImages {
  readonly body: object;
  readonly images: ReadonlyArray<ToolImage>;

  constructor(body: object, images: ReadonlyArray<ToolImage>) {
    this.body = body;
    this.images = images;
  }
}

export class McpToolError extends Error {
  readonly detail: Record<string, unknown>;
  readonly unknownTool: boolean;

  constructor(detail: Record<string, unknown>, unknownTool = false) {
    super(typeof detail.error === "string" ? detail.error : "tool_error");
    this.detail = detail;
    this.unknownTool = unknownTool;
  }
}

export function fail(
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new McpToolError({ error, message, ...extra });
}


/** Base64 of bytes, in chunks so a large picture does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
