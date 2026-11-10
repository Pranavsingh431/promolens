import type { DiagnosticCode } from "./diagnostics.ts";

export type DecodeResult =
  { ok: true; text: string } | { ok: false; code: DiagnosticCode; message: string };

/**
 * Decodes screenplay bytes as strict UTF-8. A UTF-8 byte order mark is removed.
 * Line endings are left as they are; the parser accepts LF, CRLF, and CR.
 */
export function decodeScreenplayBytes(bytes: Uint8Array): DecodeResult {
  const [first, second] = bytes;
  if ((first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)) {
    return {
      ok: false,
      code: "unsupported-encoding",
      message: "File is UTF-16. Save it as UTF-8.",
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "invalid-encoding", message: "File is not valid UTF-8 text." };
  }

  if (text.includes("\u0000")) {
    return { ok: false, code: "binary-content", message: "File contains binary data." };
  }
  return { ok: true, text };
}

const SCRIPT_MARKER = /^\s*-{2,}\s*script\s+start\s*-{2,}\s*$/im;
const SCENE_LINE = /^\s*scene\s+\d{1,4}\s*:?\s*$/im;
const TIMING_LINE = /^\s*start\s*:.*\|\s*end\s*:/im;

/** True when the text has the structure of a timestamped screenplay. */
export function looksLikeScreenplay(text: string): boolean {
  return SCRIPT_MARKER.test(text) || (SCENE_LINE.test(text) && TIMING_LINE.test(text));
}
