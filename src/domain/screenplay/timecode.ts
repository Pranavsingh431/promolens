/**
 * Timestamp conversion. Uses integer arithmetic only, so a source time such as
 * "01:23.45" becomes exactly 83450 ms.
 *
 * Accepted forms: M:SS, MM:SS.f, MM:SS.ff, MM:SS.fff, and H:MM:SS(.fff).
 * Without hours, minutes may exceed 59. Seconds must be below 60. More than
 * three fraction digits is rejected because it cannot be stored exactly.
 */

const TIMECODE = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/;

export function parseTimecode(text: string): number | undefined {
  const match = TIMECODE.exec(text);
  if (!match) return undefined;

  const [, hoursText, minutesText = "", secondsText = "", fractionText] = match;
  const hours = hoursText === undefined ? 0 : Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);

  if (seconds >= 60) return undefined;
  if (hoursText !== undefined && (minutesText.length !== 2 || minutes >= 60)) return undefined;

  const milliseconds = fractionText === undefined ? 0 : Number(fractionText.padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

/**
 * Formats milliseconds as MM:SS with the given number of fraction digits.
 * Extra precision is truncated, not rounded. Use 3 digits for an exact value.
 */
export function formatTimecode(ms: number, fractionDigits: 0 | 1 | 2 | 3 = 2): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`Expected a non-negative integer number of milliseconds, got ${ms}`);
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const fraction = String(ms % 1000)
    .padStart(3, "0")
    .slice(0, fractionDigits);
  return fractionDigits === 0 ? `${minutes}:${seconds}` : `${minutes}:${seconds}.${fraction}`;
}
