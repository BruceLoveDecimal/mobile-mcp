// Native refs identify a component in a window, not a position in a dump or the hash of an entire screen.
import { CommandError } from "./adapters/errors";
import { roleOf } from "./adapters/screen";
import { ScreenElement, ScreenSize } from "./robot";

export const fieldValue = (e: ScreenElement): string | undefined => e.value ?? e.text;
export const editable = (e: ScreenElement): boolean => e.editable !== false && (e.editable === true || roleOf(e) === "textbox");
export const nativeIdentity = (e: ScreenElement): string => JSON.stringify([
	e.type, e.identifier, e.label, e.name, editable(e) ? undefined : e.text, e.context, e.windowId,
]);

export function rematch(original: ScreenElement, elements: ScreenElement[]): ScreenElement {
	let candidates = elements.filter(e => nativeIdentity(e) === nativeIdentity(original) && (original.visible === false || e.visible !== false));
	if (candidates.length > 1 && editable(original)) {
		// Proxy input nodes can share all semantic fields. Stable dimensions distinguish them without trusting dump order.
		const sameSize = candidates.filter(e => e.rect.width === original.rect.width && e.rect.height === original.rect.height);
		if (sameSize.length === 1) { candidates = sameSize; }
	}
	if (candidates.length !== 1) {
		const message = candidates.length ? "The observed component is no longer unique" : "The observed component is no longer present";
		throw new CommandError("stale_ref", message, "Observe again or narrow a semantic target", { candidates: candidates.slice(0, 5) });
	}
	return candidates[0];
}

export function actionPoint(target: ScreenElement, elements: ScreenElement[], size?: ScreenSize): [number, number] {
	const r = target.rect;
	const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
	if (target.visible === false || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 ||
		(size && size.width > 0 && size.height > 0 && (x >= size.width || y >= size.height))) {
		throw new CommandError("not_visible", "The target has no visible action point; scroll it into view first");
	}
	if (target.enabled === false) { throw new CommandError("not_enabled", "The target is disabled"); }
	const blocker = elements.find(e => e !== target && e.visible !== false && e.enabled !== false &&
		(e.clickable || editable(e) || roleOf(e) === "button") &&
		x >= e.rect.x && y >= e.rect.y && x < e.rect.x + e.rect.width && y < e.rect.y + e.rect.height &&
		!(e.ref && target.ancestorRefs?.includes(e.ref)) && !(target.ref && e.ancestorRefs?.includes(target.ref)) &&
		!(e.ref && target.actionableRef === e.ref));
	// A native dump cannot establish arbitrary z order. Refuse ambiguous overlaps instead of guessing.
	if (blocker) { throw new CommandError("intercepted", "Another actionable element overlaps the target", "Dismiss the overlay and observe again", { blocker }); }
	return [x, y];
}
