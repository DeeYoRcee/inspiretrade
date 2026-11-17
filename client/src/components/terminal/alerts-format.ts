/** Shared localized time formatters for the Phase 5 fundamental workspaces.
 *  Uses the visitor's timezone automatically (Intl default zone). */
export const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
