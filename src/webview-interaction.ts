// Typed WebView UI operations bind an observed AX ref to its document and backend DOM node. No agent JavaScript.
import { setTimeout as sleep } from "node:timers/promises";
import { CommandError, toErrorBody } from "./adapters/errors";
import type { AXNode, CdpPage, Webviews, WebviewSnapshot, WebviewTarget } from "./webview";

interface Binding { target: WebviewTarget; document: string; refs: Map<string, AXNode> }
export interface WebviewAction {
	device: string; packageName: string; pageId: string; snapshotId: string; ref: string;
	action: "click" | "fill" | "type" | "clear" | "press" | "scroll";
	value?: string; direction?: "up" | "down" | "left" | "right"; timeoutMs?: number;
}
export interface WebviewExpectation {
	device: string; packageName: string; pageId: string; snapshotId?: string;
	target: { ref?: string; role?: string; name?: string; text?: string };
	state?: "visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked" | "selected" | "unselected";
	value?: string; timeoutMs?: number;
}
const protectedNode = (n: AXNode) => Boolean(n.properties?.some(p => p.name === "protected" && p.value.value)) ||
	n.role?.value === "textbox" && /password|密码/i.test(n.name?.value ?? "");

export class WebviewInteraction {
	private history = new Map<string, Binding>();
	constructor(private pages: Webviews) {}
	private async document(page: CdpPage): Promise<string> {
		const frame = (await page.send("Page.getFrameTree")).frameTree?.frame;
		if (!frame?.id || !frame.loaderId) { throw new CommandError("webview_protocol_error", "WebView did not identify its current document"); }
		return JSON.stringify([frame.id, frame.loaderId]);
	}
	private async capture(page: CdpPage, maxChars = 20000): Promise<WebviewSnapshot> {
		const document = await this.document(page);
		const refs = new Map<string, AXNode>();
		// Read-only observations remain usable even when a page has no actionable backend DOM nodes.
		const snapshot = await page.observe(maxChars, (node, ref) => { refs.set(ref, node); });
		if (await this.document(page) !== document) { throw new CommandError("stale_ref", "The document changed during observation"); }
		this.history.set(snapshot.id, { target: page.target, document, refs });
		if (this.history.size > 32) { this.history.delete(this.history.keys().next().value!); }
		return snapshot;
	}
	async observe(device: string, packageName: string, pageId?: string, maxChars = 20000, signal?: AbortSignal): Promise<WebviewSnapshot> {
		return this.pages.withPage(device, packageName, pageId, page => this.capture(page, maxChars), signal);
	}
	private binding(args: { device: string; packageName: string; pageId: string; snapshotId?: string }, ref: string): { saved: Binding; node: AXNode } {
		const saved = args.snapshotId ? this.history.get(args.snapshotId) : undefined;
		const node = saved && saved.refs.get(ref);
		if (!saved || !node?.backendDOMNodeId || saved.target.device !== args.device || saved.target.packageName !== args.packageName || saved.target.id !== args.pageId) {
			throw new CommandError("stale_ref", "Use a wN ref and snapshotId from this App page's latest observation");
		}
		return { saved, node };
	}
	private async current(page: CdpPage, saved: Binding, node: AXNode): Promise<void> {
		if (page.target.socket !== saved.target.socket || await this.document(page) !== saved.document) {
			throw new CommandError("stale_ref", "The App page or document changed; observe again");
		}
		const nodes: AXNode[] = (await page.send("Accessibility.getFullAXTree")).nodes ?? [];
		const current = nodes.find(n => n.backendDOMNodeId === node.backendDOMNodeId && !n.ignored);
		if (!current || current.role?.value !== node.role?.value || current.name?.value !== node.name?.value) {
			throw new CommandError("stale_ref", "The observed component was removed or repurposed");
		}
	}
	private async element(page: CdpPage, node: AXNode, fn: string, args: unknown[] = []): Promise<any> {
		const { object } = await page.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
		if (!object?.objectId) { throw new CommandError("stale_ref", "The observed DOM node no longer exists"); }
		try {
			const result = await page.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn,
				arguments: args.map(value => ({ value })), awaitPromise: true, returnByValue: true });
			if (result.exceptionDetails) { throw new CommandError("webview_action_failed", "The target could not perform the UI operation"); }
			return result.result?.value;
		} finally { await page.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {}); }
	}
	async act(args: WebviewAction, signal?: AbortSignal): Promise<Record<string, unknown>> {
		let actionSent = false;
		let snapshot: WebviewSnapshot | undefined;
		let delivery = "not_sent";
		let actual: string | undefined;
		let verified = false;
		const started = Date.now();
		const deadline = AbortSignal.timeout(args.timeoutMs ?? 15000);
		const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
		try {
			const { saved, node } = this.binding(args, args.ref);
			if (["fill", "type"].includes(args.action) && args.value === undefined) { throw new CommandError("invalid_args", `${args.action} needs value`); }
			return await this.pages.withPage(args.device, args.packageName, args.pageId, async page => {
				await this.current(page, saved, node);
				const input = ["fill", "clear", "type"].includes(args.action);
				const info = await this.element(page, node, `async function(input) {
					if (!this.isConnected) return {error:'stale_ref'};
					if (this.disabled || this.getAttribute('aria-disabled') === 'true') return {error:'not_enabled'};
					if(input && !(this.isContentEditable || /^(INPUT|TEXTAREA)$/.test(this.tagName) && !this.readOnly)) return {error:'not_editable'};
					this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
					let old='',stable=false;
					for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,40));const b=this.getBoundingClientRect();const now=[b.x,b.y,b.width,b.height].map(Math.round).join(',');if(now===old){stable=true;break;}old=now;}
					if(!stable)return {error:'not_stable'};
					const b=this.getBoundingClientRect(),s=getComputedStyle(this),x=b.x+b.width/2,y=b.y+b.height/2;
					if(!b.width||!b.height||s.visibility==='hidden'||s.display==='none'||x<0||y<0||x>=innerWidth||y>=innerHeight)return {error:'not_visible'};
					const hit=document.elementFromPoint(x,y);if(!hit||!(hit===this||this.contains(hit)))return {error:'intercepted'};
					return {x,y,value:this.isContentEditable?this.textContent:this.value};
				}`, [input]);
				if (info?.error) { throw new CommandError(info.error, "The WebView target is not actionable"); }
				if (!info || !Number.isFinite(info.x) || !Number.isFinite(info.y)) { throw new CommandError("webview_protocol_error", "No action point returned"); }
				const desired = args.action === "type" ? (info.value ?? "") + args.value! : args.action === "clear" ? "" : args.value;
				if (input) {
					await this.element(page, node, `function(append){this.focus();if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);if(append)r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);}else if(this.setSelectionRange){this.setSelectionRange(append?this.value.length:0,this.value.length);}return true;}`, [args.action === "type"]);
					actionSent = true; delivery = "dispatched";
					if (desired === "") {
						await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
						await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
					} else { await page.send("Input.insertText", { text: args.value }); }
					delivery = "applied";
					for (;;) {
						actual = await this.element(page, node, `function(){return this.isContentEditable?this.textContent:this.value;}`);
						verified = actual === desired;
						if (verified || Date.now() - started >= (args.timeoutMs ?? 15000) - 300) { break; }
						await sleep(100, undefined, { signal: cancellation });
					}
				} else if (args.action === "click") {
					await this.element(page, node, `function(){this.__mobileProbe=false;const on=e=>{if(e.target===this||this.contains(e.target))this.__mobileProbe=true;};this.__mobileProbeCleanup=()=>{document.removeEventListener('pointerdown',on,true);document.removeEventListener('mousedown',on,true);};document.addEventListener('pointerdown',on,true);document.addEventListener('mousedown',on,true);return true;}`);
					actionSent = true; delivery = "dispatched";
					try {
						await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: info.x, y: info.y, button: "left", clickCount: 1 });
						await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.x, y: info.y, button: "left", clickCount: 1 });
						const received = await this.element(page, node, `function(){return this.__mobileProbe===true;}`);
						if (!received) { throw new CommandError("not_delivered", "No pointer event reached this WebView target"); }
						delivery = "received";
					} finally { await this.element(page, node, `function(){this.__mobileProbeCleanup?.();delete this.__mobileProbeCleanup;delete this.__mobileProbe;}`).catch(() => {}); }
				} else if (args.action === "scroll") {
					actionSent = true; delivery = "dispatched";
					const dir = args.direction ?? "down";
					await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: info.x, y: info.y, deltaX: dir === "left" ? -400 : dir === "right" ? 400 : 0, deltaY: dir === "up" ? -400 : dir === "down" ? 400 : 0 });
				} else {
					const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46 };
					if (!args.value || !(args.value in keys)) { throw new CommandError("invalid_args", "press supports Enter, Tab, Escape, Backspace or Delete"); }
					await this.element(page, node, `function(){this.focus();}`);
					actionSent = true; delivery = "dispatched";
					for (const type of ["keyDown", "keyUp"]) { await page.send("Input.dispatchKeyEvent", { type, key: args.value, windowsVirtualKeyCode: keys[args.value] }); }
				}
				snapshot = await this.capture(page);
				const ok = !input || verified;
				return { ok, actionSent, delivery, controlState: verified ? "verified" : "unverified",
					...(input ? { verified, actual: protectedNode(node) ? "******" : actual } : {}), snapshot,
					...(!ok ? { error: { code: "input_mismatch", message: "The actual field value does not match the requested input; do not replay it blindly" } } : {}),
					metrics: { elapsedMs: Date.now() - started } };
			}, cancellation);
		} catch (error) {
			const body = actionSent && (cancellation.aborted || /webview_(closed|timeout|unavailable|protocol_error)/.test(toErrorBody(error).code))
				? { code: "command_outcome_unknown", message: "The WebView action may have applied; observe before retrying" } : toErrorBody(error);
			return { ok: false, actionSent, delivery: body.code === "command_outcome_unknown" ? "unknown" : delivery, controlState: "unverified", snapshot,
				...(actual !== undefined ? { actual: "******", verified: false } : {}), error: body, metrics: { elapsedMs: Date.now() - started } };
		}
	}
	async expect(args: WebviewExpectation, signal?: AbortSignal): Promise<Record<string, unknown>> {
		let snapshot: WebviewSnapshot | undefined;
		const started = Date.now(), budget = args.timeoutMs ?? 5000;
		const deadline = AbortSignal.timeout(budget);
		const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
		try {
			const binding = args.target.ref ? this.binding(args, args.target.ref) : undefined;
			if (!args.target.ref && !args.target.role && !args.target.name && !args.target.text) { throw new CommandError("invalid_target", "Specify ref, role, name or text"); }
			return await this.pages.withPage(args.device, args.packageName, args.pageId, async page => {
				for (;;) {
					if (binding && (page.target.socket !== binding.saved.target.socket || await this.document(page) !== binding.saved.document)) { throw new CommandError("stale_ref", "The observed document changed"); }
					snapshot = await this.capture(page);
					const nodes = [...this.history.get(snapshot.id)!.refs.values()];
					const matches = nodes.filter(n => (!binding || n.backendDOMNodeId === binding.node.backendDOMNodeId) &&
						(!args.target.role || n.role?.value === args.target.role) && (!args.target.name || n.name?.value === args.target.name) &&
						(!args.target.text || (n.name?.value ?? "").includes(args.target.text)));
					const state = args.state ?? "visible";
					const held = state === "hidden" ? matches.length === 0 : matches.length > 0 && matches.every(n => {
						const p = Object.fromEntries((n.properties ?? []).map(p => [p.name, p.value.value]));
						// Chromium omits AXValue for an empty textbox, rather than returning an empty string.
						const value = n.value?.value ?? (n.role?.value === "textbox" ? "" : undefined);
						if (args.value !== undefined && value !== args.value) { return false; }
						if (state === "enabled") { return !p.disabled; } if (state === "disabled") { return Boolean(p.disabled); }
						if (state === "checked" || state === "unchecked") { return p.checked === (state === "checked" ? true : false) || p.checked === (state === "checked" ? "true" : "false"); }
						if (state === "selected" || state === "unselected") { return Boolean(p.selected) === (state === "selected"); }
						return true;
					});
					if (held) { return { ok: true, snapshot, controlState: "verified", metrics: { elapsedMs: Date.now() - started } }; }
					if (Date.now() - started >= budget - 250) { break; }
					await sleep(100, undefined, { signal: cancellation });
				}
				return { ok: false, snapshot, error: { code: "expectation_failed", message: "WebView condition was not met before the deadline" }, metrics: { elapsedMs: Date.now() - started } };
			}, cancellation);
		} catch (error) { return { ok: false, snapshot, error: cancellation.aborted && !signal?.aborted && snapshot ? { code: "expectation_failed", message: "WebView condition was not met before the deadline" } : toErrorBody(error), metrics: { elapsedMs: Date.now() - started } }; }
	}
}
