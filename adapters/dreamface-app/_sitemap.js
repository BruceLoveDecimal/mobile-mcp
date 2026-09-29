// The DreamFace app map behind `dreamface-app/sitemap` and `dreamface-app/open`: what an agent driving the app needs
// before it taps. Same fields as the web map (opencli-mcp adapters/dreamface/_sitemap.js) with routes replaced by
// screens.
//
// Written from a depth-first walk on a device with the mobile_* tools (see README.md here), so every entry is something
// that was seen. Visible texts are quoted as they appear so they can be used as getByText targets; element refs (@eN)
// are never recorded because they expire on every screen read. Update this file (and VERIFIED) when a walk finds a
// change.

/** When and how the map was last checked: '<date> on <device/image>, DreamFace <versionName> (<versionCode>), <account>, <language>'. */
export const VERIFIED = 'not walked yet: SCREENS is empty until the first depth-first walk (README.md, "Updating the map")';

/**
 * Screens, parent first.
 * - id: stable name, the `screen` argument of `open` and `sitemap`
 * - activity: foreground Activity (Android) as mobile_get_foreground_app / adb report it
 * - markers: visible texts that together mean "this screen is showing"; `open` waits for all of them
 * - parent: id of the screen it is reached from (null for the launch screen)
 * - via: how a person gets here from the parent (free text, for readers)
 * - open: how `open` gets here: { url } (deep link, from anywhere) and/or { taps: ['exact visible text', …] } from the parent
 * - sections / controls: what is on the screen, visible text quoted exactly, where each control leads
 * - submit: buttons that start a paid or free-quota job: label, when it enables, what it costs
 *
 * @type {Array<{ id: string, activity?: string, markers: string[], parent: string | null, via: string, open?: { url?: string, taps?: string[] }, sections?: string[], controls?: string[], submit?: string[] }>}
 */
export const SCREENS = [];

/** Things that cost credits, lose state or mislead a driver, most expensive first. @type {Array<{ id: string, screens?: string[], symptom: string, fix: string }>} */
export const TRAPS = [];

/** Which command covers which screen, and where the server-side check lives (the web adapter, same account). */
export const COMMANDS = [
  { command: 'dreamface-app/sitemap', screens: [], screen: '(none: reads this file)', note: 'read' },
  { command: 'dreamface-app/open', screens: [], screen: 'any screen with `open` directions', note: 'read: launches the app and navigates, never submits' },
  { command: 'dreamface/credits (web, opencli-mcp)', screens: [], screen: 'credit count', note: 'same account as the app: check credits before and after an app write' },
  { command: 'dreamface/works (web, opencli-mcp)', screens: [], screen: 'creations list', note: 'same account: confirm a generation started from the app reached the server' },
];

export const screenById = (id, screens = SCREENS) => screens.find((s) => s.id === id);

/** The screen and its descendants. */
export function subtree(id, screens = SCREENS) {
  const out = [];
  const walk = (sid) => {
    const s = screenById(sid, screens);
    if (!s) return;
    out.push(s);
    for (const child of screens.filter((c) => c.parent === sid)) walk(child.id);
  };
  walk(id);
  return out;
}

/** Draw the screen tree. */
export function tree(screens = SCREENS) {
  if (!screens.length) return '(no screens recorded yet)';
  const included = new Set(screens.map((s) => s.id));
  const children = new Map();
  for (const s of screens) {
    const parent = included.has(s.parent) ? s.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const lines = [];
  const walk = (s, indent) => {
    const how = s.open?.url ? `  ⇢ ${s.open.url}` : '';
    const warn = (s.submit ?? []).length ? '  $ submits' : '';
    lines.push(`${indent}${s.id}${s.activity ? `  (${s.activity})` : ''}${how}${warn}`);
    for (const child of children.get(s.id) ?? []) walk(child, `${indent}  `);
  };
  for (const root of children.get(null) ?? []) walk(root, '');
  return lines.join('\n');
}
