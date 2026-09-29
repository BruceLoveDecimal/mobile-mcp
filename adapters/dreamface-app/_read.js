// Reading values off a screen by layout: shared by the read commands.

const textOf = (e) => (e.text ?? e.label ?? '').trim();

/** The screen size, from the elements that cover it. */
export function screenSize(elements) {
  let width = 0;
  let height = 0;
  for (const e of elements) {
    width = Math.max(width, e.rect.x + e.rect.width);
    height = Math.max(height, e.rect.y + e.rect.height);
  }
  return { width, height };
}

/** The number shown directly above `label` (Purchase Credits lays out "0" over "Total Credits"), or null. */
export function numberAbove(elements, label) {
  const target = elements.find((e) => textOf(e) === label);
  if (!target) return null;
  const center = target.rect.x + target.rect.width / 2;
  const above = elements
    .filter((e) => /^\d[\d,]*$/.test(textOf(e)))
    .filter((e) => e.rect.y + e.rect.height <= target.rect.y + 2)
    .filter((e) => Math.abs(e.rect.x + e.rect.width / 2 - center) < target.rect.width)
    .sort((a, b) => b.rect.y - a.rect.y);
  return above.length ? Number(textOf(above[0]).replace(/,/g, '')) : null;
}

/** Elements whose text is a tag ("New", "NEW", "Beta") next to or above `e`. */
export function tagsNear(elements, e, { right = 120, up = 90 } = {}) {
  const end = e.rect.x + e.rect.width;
  return elements
    .filter((t) => /^(new|beta|hot)$/i.test(textOf(t)))
    .filter((t) => t.rect.x >= end - 10 && t.rect.x <= end + right && Math.abs(t.rect.y - e.rect.y) <= up)
    .map(textOf);
}

export { textOf };
