import sanitizeHtml from "sanitize-html";

/**
 * HTML written in the portal (email bodies, signatures): only simple
 * formatting is kept — no scripts, no event handlers, no styles beyond a few
 * text properties, links to http(s)/mailto/tel only, images from https or
 * inline data (a logo in a signature).
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "div",
    "br",
    "span",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "strike",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "hr",
    "font",
    "table",
    "tbody",
    "tr",
    "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "target"],
    img: ["src", "alt", "width", "height", "style"],
    font: ["color", "face", "size"],
    td: ["style", "colspan", "rowspan"],
    "*": ["style"],
  },
  allowedStyles: {
    "*": {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
      "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i],
      "font-weight": [/^(bold|normal|[1-9]00)$/],
      "font-style": [/^(italic|normal)$/],
      "text-decoration": [/^(underline|line-through|none)$/],
      "font-size": [/^\d{1,2}(\.\d)?(pt|px|em)$/],
      "font-family": [/^[\w\s,'"-]{1,100}$/],
      "text-align": [/^(left|right|center|justify)$/],
      width: [/^\d{1,4}(px|%)$/],
      height: [/^\d{1,4}px$/],
    },
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["https", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  // images: an https address or an inline picture only (no data:text/html; none left without a source)
  exclusiveFilter: (frame) =>
    frame.tag === "img" && !(/^https:\/\//i.test(frame.attribs.src ?? "") || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(frame.attribs.src ?? "")),
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank" } }),
  },
};

export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}

/** Plain text of some HTML (empty body check). */
export function htmlText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .trim();
}
