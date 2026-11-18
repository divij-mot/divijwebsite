// The canvases and 3D scenes take their colours from the page's CSS tokens
// (site.css :root), so the whole site follows one palette.
const root = () => getComputedStyle(document.documentElement);

/** a colour token, e.g. "#0a2cf0" */
export const token = (name, fallback) => root().getPropertyValue(name).trim() || fallback;

