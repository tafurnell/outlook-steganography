// Minimal MIME walker: extracts PNG parts from a raw RFC 822 message (.eml).
// Used as a fallback when Outlook's getAttachmentContentAsync fails for an inline
// image (seen in new Outlook: "GenericResponseError – An internal error has occurred").
// Pure function – no Office.js – so it can be unit-tested and reused (D-018).

export interface MimeImage {
  name: string;
  contentId: string;
  bytes: Uint8Array;
}

interface Entity {
  headers: Map<string, string>;
  body: string;
}

function splitEntity(text: string): Entity {
  const sep = text.indexOf("\n\n");
  const rawHeaders = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 2) : "";
  const headers = new Map<string, string>();
  // Unfold continuation lines, then split "Name: value".
  for (const line of rawHeaders.replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { headers, body };
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(header);
  return m ? (m[1] ?? m[2]) : undefined;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function walk(text: string, out: MimeImage[], depth: number): void {
  if (depth > 10) return;
  const { headers, body } = splitEntity(text);
  const ctype = headers.get("content-type") ?? "text/plain";
  const mime = ctype.split(";")[0].trim().toLowerCase();

  if (mime.startsWith("multipart/")) {
    const boundary = param(ctype, "boundary");
    if (!boundary) return;
    const delim = `--${boundary}`;
    const parts = body.split(new RegExp(`^${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*$`, "m"));
    // parts[0] is the preamble, the last is the epilogue after the closing delimiter.
    for (const part of parts.slice(1)) {
      const trimmed = part.replace(/^\n/, "");
      if (trimmed.trim()) walk(trimmed, out, depth + 1);
    }
    return;
  }

  const disposition = headers.get("content-disposition");
  const name = param(disposition, "filename") ?? param(ctype, "name") ?? "";
  const isPng = mime === "image/png" || name.toLowerCase().endsWith(".png");
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (isPng && encoding === "base64") {
    try {
      out.push({
        name,
        contentId: (headers.get("content-id") ?? "").replace(/[<>]/g, ""),
        bytes: base64ToBytes(body),
      });
    } catch {
      /* malformed part – skip */
    }
  }
}

/** Extract every base64-encoded PNG part from raw message text. */
export function extractPngParts(eml: string): MimeImage[] {
  const out: MimeImage[] = [];
  walk(eml.replace(/\r\n/g, "\n"), out, 0);
  return out;
}
