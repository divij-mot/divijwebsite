/** Every character of a link becomes a two-faced disc that turns over on hover. */
export function flipify(el) {
  if (el.dataset.flipped) return;
  el.dataset.flipped = "1";
  const text = el.textContent.trim();
  const link = el.closest("a, button");
  if (link && !link.hasAttribute("aria-label")) link.setAttribute("aria-label", link.textContent.trim().replace(/\s+/g, " "));
  let i = 0;
  el.innerHTML = text
    .split(" ")
    .map(
      (w) =>
        `<span class="fw" aria-hidden="true">${[...w]
          .map((c) => `<span class="f" style="--i:${i++}"><span>${c}</span><span>${c}</span></span>`)
          .join("")}</span>`
    )
    .join(" ");
}
