// @mobilenext/mobile-mcp/adapter-sdk — the app adapter contract (types). This file is the source of truth for what an
// adapter may use. It mirrors opencli-mcp/adapter-sdk: same descriptor, same errors; `tab` becomes `device` + `screen`.

export type Access = "read" | "write";

export interface ArgValue {
  type?: "string" | "int" | "number" | "boolean" | "array" | "object";
  nullable?: boolean;
  choices?: Array<string | number | boolean>;
  items?: ArgValue;
  properties?: Record<string, ArgValue & { required?: boolean; help?: string }>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** One representative value, shown to the agent; not used as a default. */
  example?: unknown;
}

export interface Arg extends ArgValue {
  /** snake_case, agent-native JSON key */
  name: string;
  required?: boolean;
  default?: unknown;
  /** one line, agent-facing, no CLI grammar */
  help?: string;
}

/** One element of the accessibility hierarchy, as mobile_list_elements_on_screen returns it. */
export interface ScreenElement {
  type: string;
  text?: string;
  label?: string;
  name?: string;
  value?: string;
  identifier?: string;
  rect: { x: number; y: number; width: number; height: number };
  ref?: string;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  enabled?: boolean;
}

export type Role = "button" | "textbox" | "text" | "image" | "switch" | "checkbox" | "radio" | "cell" | (string & {});
export type SwipeDirection = "up" | "down" | "left" | "right";
export type ButtonName = "HOME" | "BACK" | "VOLUME_UP" | "VOLUME_DOWN" | "ENTER" | "DPAD_CENTER" | "DPAD_UP" | "DPAD_DOWN" | "DPAD_LEFT" | "DPAD_RIGHT";

export interface TextOptions {
  /** true: the whole text must equal `text`, case-sensitive. Default: case-insensitive substring. */
  exact?: boolean;
}

export interface WaitOptions {
  /** How long to keep re-reading the screen, in ms. Default: the screen's default timeout (10s). */
  timeout?: number;
}

/**
 * Finds elements by what the user sees, re-reading the screen until they appear (auto-wait). Chaining
 * (`screen.getByRole('cell').getByText('Pro')`) narrows to elements inside the outer match. Resolution is not strict:
 * several matches act on the first in screen order unless you pick one with `nth`.
 */
export interface Locator {
  getByText(text: string | RegExp, opts?: TextOptions): Locator;
  getByLabel(label: string | RegExp, opts?: TextOptions): Locator;
  getByRole(role: Role, opts?: TextOptions & { name?: string | RegExp }): Locator;
  getByType(type: string): Locator;
  getByTestId(id: string): Locator;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  /** Current matches, without waiting. */
  count(): Promise<number>;
  all(): Promise<ScreenElement[]>;
  isVisible(): Promise<boolean>;
  /** Wait until the locator matches (state visible, default) or stops matching (hidden). Throws element_not_found. */
  waitFor(opts?: WaitOptions & { state?: "visible" | "hidden" }): Promise<void>;
  /** The matched element (waits for it). */
  element(opts?: WaitOptions): Promise<ScreenElement>;
  /** Its text, label or value (waits for it). */
  text(opts?: WaitOptions): Promise<string>;
  tap(opts?: WaitOptions): Promise<void>;
  longPress(opts?: WaitOptions & { duration?: number }): Promise<void>;
  /** Tap to focus, then type. Does not clear what the field already holds. */
  fill(text: string, opts?: WaitOptions): Promise<void>;
  readonly description: string;
}

export interface Screen {
  getByText(text: string | RegExp, opts?: TextOptions): Locator;
  getByLabel(label: string | RegExp, opts?: TextOptions): Locator;
  getByRole(role: Role, opts?: TextOptions & { name?: string | RegExp }): Locator;
  getByType(type: string): Locator;
  getByTestId(id: string): Locator;
  /** The raw element list (one fresh read). */
  elements(): Promise<ScreenElement[]>;
  /** One read to look several elements up in and tap where it found them (a read takes seconds on an emulator).
   * An unreadable screen gives `ok: false` and no elements instead of throwing. adapterApi 2. */
  snapshot(): Promise<ScreenSnapshot>;
  tap(x: number, y: number): Promise<void>;
  swipe(direction: SwipeDirection, opts?: { from?: { x: number; y: number }; distance?: number }): Promise<void>;
  /** Type into whatever has focus. */
  type(text: string): Promise<void>;
  /** Default wait for locators, ms. */
  setDefaultTimeout(ms: number): void;
}

export interface ScreenSnapshot {
  readonly ok: boolean;
  readonly elements: ScreenElement[];
  /** Visible texts in screen order. */
  readonly texts: string[];
  readonly size: { width: number; height: number };
  /** Matches like getByText / getByTestId, within this read. */
  byText(text: string | RegExp, opts?: TextOptions): ScreenElement | undefined;
  byTestId(id: string): ScreenElement | undefined;
  /** Tap the middle of an element of this read. */
  tap(element: ScreenElement): Promise<void>;
}

export interface Expectation {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  toHaveText(text: string | RegExp, opts?: WaitOptions & TextOptions): Promise<void>;
}

/** Polling assertions; a failure throws `expectation_failed`. */
export type Expect = (locator: Locator) => Expectation;

export interface DeviceHandle {
  readonly id: string;
  /** android | ios (lazy: asks mobilecli). */
  platform(): Promise<"android" | "ios" | "unknown">;
  /** The first of this app's `packages` installed on the device; throws app_not_installed. */
  package(): Promise<string>;
  /** Launch an app (default: this app's package). */
  launch(pkg?: string, opts?: { locale?: string }): Promise<void>;
  terminate(pkg?: string): Promise<void>;
  /** terminate + launch. */
  restart(pkg?: string): Promise<void>;
  /** Open a URL, including the app's own deep-link scheme. */
  openUrl(url: string): Promise<void>;
  pressButton(name: ButtonName): Promise<void>;
  back(): Promise<void>;
  foreground(): Promise<{ packageName: string; appName: string }>;
  listApps(): Promise<Array<{ packageName: string; appName: string }>>;
  /** Device log lines (NDJSON strings), filtered with key=value / key!=value. */
  logs(opts?: { filters?: string[]; limit?: number; timeoutMs?: number }): Promise<string[]>;
}

/** Sibling commands: `apps.run('dreamface-app', 'open', { screen: 'home' })` or `apps['dreamface-app'].open({...})`. */
export interface Apps {
  run(app: string, command: string, args?: Record<string, unknown>): Promise<unknown>;
  [app: string]: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> | unknown;
}

/** What `run` receives. */
export interface AdapterContext {
  args: Record<string, unknown>;
  device: DeviceHandle;
  screen: Screen;
  expect: Expect;
  apps: Apps;
  /** This app's folder name and its package names from app.json / the descriptor. */
  app: { name: string; packages: string[] };
  signal?: AbortSignal;
}

export interface AdapterDescriptor {
  description: string;
  access: Access;
  /** Agent-facing result shape. `rows` may include nextCursor; `value` is one object/scalar. */
  result?: { kind: "rows" | "value"; description: string; fields?: Record<string, string>; paginated?: boolean };
  /** Package names / bundle ids of the app; defaults to `packages` in the app's app.json. */
  packages?: string[];
  args?: Arg[];
  /** aliases resolve to this command */
  aliases?: string[];
  /** `host`: run by the application hosting the agent (e.g. a login with credentials the agent never sees); left out of
   * `apps_search`, still runnable with `app_run`. Default `agent`. adapterApi 2. */
  audience?: "agent" | "host";
  run(ctx: AdapterContext): Promise<unknown>;
}

/** `<app>/app.json`: what the host needs to know about an app (all fields optional). */
export interface AppManifest {
  aliases?: string[];
  packages?: string[];
  /** The account its `login` role signs in to; defaults to the app name (a site adapter may share it). adapterApi 2. */
  account?: string;
  /** Standard roles and the commands that implement them, e.g. { login: 'login', map: 'sitemap' }. adapterApi 2. */
  roles?: Record<string, string>;
  /** Agent-facing usage notes, given to agents working on this app. adapterApi 2. */
  guide?: string;
}

/** Validate + return an adapter descriptor. Pure: no registration, no side effects. */
export function defineAdapter(descriptor: AdapterDescriptor): AdapterDescriptor;

export class AdapterError extends Error { code: string; hint?: string; constructor(code: string, message: string, hint?: string); }
export const errors: {
  auth(message?: string, hint?: string): AdapterError;
  empty(message?: string): AdapterError;
  argument(message: string, hint?: string): AdapterError;
  upstream(message: string, hint?: string): AdapterError;
  notInstalled(message?: string, hint?: string): AdapterError;
  notFound(message: string, hint?: string): AdapterError;
  expectation(message: string, hint?: string): AdapterError;
};
