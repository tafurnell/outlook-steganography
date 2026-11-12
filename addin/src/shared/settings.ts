// Settings keys and pure helpers shared by the task pane and the event handler
// (which runs in a JavaScript-only runtime in classic Outlook – keep this DOM-free).

export const KEY_SETTING = "ostg.masterKey";
export const NAME_SETTING = "ostg.displayName";
export const REMOVE_OLD_SETTING = "ostg.removeOldSignatures";
/** Written by the OnNewMessageCompose handler – proves events fire (D-039). */
export const LAST_EVENT_SETTING = "ostg.lastComposeEvent";
/** JSON array of recently used signature texts, newest first (D-040). */
export const RECENT_NAMES_SETTING = "ostg.recentNames";
export const MAX_RECENT_NAMES = 10;

/** Notification key of the "Add secure signature" bar shown on new drafts. */
export const OFFER_NOTIFICATION_KEY = "ostgOffer";

export function parseRecentNames(json: string | undefined): string[] {
  try {
    const a: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Put `name` first (case-insensitive de-duplication), keeping at most `max` entries. */
export function withRecentName(list: string[], name: string, max = MAX_RECENT_NAMES): string[] {
  const n = name.trim();
  if (!n) return list;
  return [n, ...list.filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, max);
}
