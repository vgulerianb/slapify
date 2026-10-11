/**
 * Tool contracts: what each tool can do to the world.
 *
 * An autonomous agent needs to know the difference between reading a page and
 * buying something. Every tool declares an effect, and the harness uses it to
 * decide how to admit a call (repeat handling), whether to review it first,
 * and what counts as a stall.
 *
 * Some tools can't be classified statically. A click on a tab is harmless; a
 * click on "Post" publishes to the world. Those are classified per call, from
 * the label of the element being acted on.
 */

export type Effect =
  /** Observes only. Safe to repeat. */
  | "read"
  /** Changes what the browser shows, but changes nothing outside it. */
  | "navigate"
  /** Changes local or reversible state: typing into a field, saving memory. */
  | "mutate"
  /** Commits something to the outside world: posting, sending, buying, deleting. */
  | "irreversible"
  /** Harness control: finishing, sleeping, reporting, asking the user. */
  | "control";

const STATIC: Record<string, Effect> = {
  get_page_state: "read",
  get_page_text: "read",
  get_links: "read",
  screenshot: "read",
  find_element: "read",
  check: "read",
  recall: "read",
  list_memories: "read",
  list_credential_profiles: "read",
  fetch_url: "read",
  perf_audit: "read",
  wait: "read",

  navigate: "navigate",
  go_back: "navigate",
  reload: "navigate",
  scroll: "navigate",
  hover: "navigate",
  switch_tab: "navigate",
  list_tabs: "read",

  type: "mutate",
  select_option: "mutate",
  set_checked: "mutate",
  remember: "mutate",
  save_credentials: "mutate",
  inject_credentials: "mutate",
  fill_login_form: "mutate",
  solve_captcha: "mutate",
  schedule: "mutate",
  write_output: "mutate",
  drag: "mutate",
  hold_keys: "mutate",
  click_at: "mutate",
  move_mouse: "mutate",
  pursue: "mutate",
  close_tab: "mutate",
  download_file: "mutate",

  // Sends a local file to a website: treat like any other commit.
  upload_file: "irreversible",

  done: "control",
  sleep_until: "control",
  status_update: "control",
  ask_user: "control",
};

/**
 * Words that mark a control as committing something. Matched against the
 * accessible name of the element being clicked. Deliberately broad: a false
 * positive costs one review, a false negative can post or pay without one.
 */
const COMMITTING =
  /\b(post|reply|tweet|send|submit|publish|share|buy|pay|purchase|order|checkout|check out|place order|confirm|delete|remove|unsubscribe|transfer|withdraw|donate|sign up|register|subscribe|accept|agree|book|reserve|apply)\b/i;

/** In a description: a committing word used as the control's name, or as the verb. */
const COMMITTING_CONTROL = new RegExp(
  `(\\b(${COMMITTING.source.replace(/^\\b\(|\)\\b$/g, "")})\\s+(button|link|control|icon|menu item)\\b)|(^\\s*(click\\s+|press\\s+)?(the\\s+)?(send|submit|publish|buy|pay|purchase|place order|checkout|check out|confirm|delete|remove|transfer|withdraw|donate|post|tweet|reply)\\b(?!\\s+(count|box|field)))`,
  "i"
);

/** Keyboard chords that submit a composer on most sites. */
const SUBMIT_CHORD = /^(meta|cmd|command|control|ctrl)\s*\+\s*enter$/i;

export interface CallContext {
  /** Accessible names by ref, from the most recent snapshot. */
  labels: Record<string, string>;
}

/** Remove quoted passages ('...', "...", “...”) from a description. */
export function stripQuoted(text: string): string {
  return text
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/‘[^’]*’/g, " ")
    .replace(/(^|[\s(])'[^']*'(?=[\s,.;:)!?]|$)/g, "$1 ");
}

/** Effect of one concrete call. Unknown tools (custom plugins) count as mutate. */
export function effectOf(
  toolName: string,
  args: Record<string, unknown>,
  ctx: CallContext
): Effect {
  if (toolName === "click" || toolName === "double_click") {
    const known = ctx.labels[String(args.ref || "")];
    // Without a label, judge the model's own description, minus anything it
    // quotes: "Like button on @dev's 'Reply guys, share this'" is a like.
    if (known) {
      // "0 Replies. Reply", "12 Likes. Like": a counter that opens something,
      // not a submit. Real submit controls are named by the verb alone.
      const name = known.replace(/^[\w-]+\s+"?/, "").replace(/"$/, "");
      if (/^\d[\d,.]*[kKmM]?\s+\w+\.\s/.test(name)) return "mutate";
      return COMMITTING.test(known) ? "irreversible" : "mutate";
    }
    const desc = stripQuoted(String(args.description || ""));
    // Focusing a text field never commits anything, whatever it is for.
    if (/\b(text ?box|input|field|composer|editor)\b/i.test(desc)) return "mutate";
    // A description is prose about the element ("Like button on Ann's tweet"),
    // so a committing word only counts when it names the control itself.
    return COMMITTING_CONTROL.test(desc) ? "irreversible" : "mutate";
  }
  if (toolName === "press") {
    return SUBMIT_CHORD.test(String(args.key || "").trim()) ? "irreversible" : "mutate";
  }
  return STATIC[toolName] || "mutate";
}

/** A short human-readable description of the action, for reviews and logs. */
export function describeCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: CallContext
): string {
  if (toolName === "click" || toolName === "double_click") {
    const label = ctx.labels[String(args.ref || "")];
    const verb = toolName === "click" ? "click" : "double-click";
    return `${verb} ${label ? `"${label}"` : String(args.ref)}`;
  }
  if (toolName === "press") return `press ${String(args.key)}`;
  if (toolName === "type") return `type "${String(args.text || "").slice(0, 280)}"`;
  if (toolName === "upload_file") return `upload ${JSON.stringify(args.paths)}`;
  return `${toolName} ${JSON.stringify(args).slice(0, 200)}`;
}
