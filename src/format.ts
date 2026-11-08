import { marked, type Token } from "marked";
import TurndownService from "turndown";

/**
 * Apple Notes stores bodies as a restricted HTML dialect:
 *   - every line is a <div>…</div>, blank lines are <div><br></div>
 *   - the first line is the note title (bold, 24px)
 *   - lists are plain <ul>/<ol>, inline styles are <b>, <i>, <u>, <strike>, <tt>
 * These helpers convert between that and Markdown, treating "one div = one line".
 */

const BLANK_LINE = "<div><br></div>";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  br: "",
});
turndown.addRule("strike", {
  filter: (node) => ["STRIKE", "S", "DEL"].includes(node.nodeName),
  replacement: (content) => `~~${content}~~`,
});
turndown.addRule("tt", {
  filter: (node) => node.nodeName === "TT",
  replacement: (content) => "`" + content + "`",
});
// Notes' underline has no Markdown equivalent; keep the text.
turndown.addRule("underline", {
  filter: "u",
  replacement: (content) => content,
});

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Split a Notes body into its top-level blocks (divs, lists, tables …). */
function splitBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<(div|ul|ol|table|h[1-6]|p|pre|blockquote)\b[^>]*>/gi;
  let pos = 0;
  while (pos < html.length) {
    re.lastIndex = pos;
    const m = re.exec(html);
    if (!m) {
      const rest = html.slice(pos).trim();
      if (rest) blocks.push(rest);
      break;
    }
    const tag = m[1].toLowerCase();
    // Find the matching close tag, accounting for nesting of the same tag.
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    tagRe.lastIndex = m.index;
    let depth = 0;
    let end = html.length;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    const before = html.slice(pos, m.index).trim();
    if (before) blocks.push(before);
    blocks.push(html.slice(m.index, end));
    pos = end;
  }
  return blocks;
}

function isBlankBlock(block: string): boolean {
  return /^<div[^>]*>\s*(<br\s*\/?>)?\s*<\/div>$/i.test(block.trim());
}

/** Split a Notes body into its title block and the rest. */
export function splitTitle(html: string): { titleHtml: string; restHtml: string } {
  const blocks = splitBlocks(html);
  if (blocks.length === 0) return { titleHtml: "", restHtml: "" };
  return { titleHtml: blocks[0], restHtml: blocks.slice(1).join("\n") };
}

/** Convert a Notes body to Markdown. The first line becomes a `# Title` heading. */
export function notesHtmlToMarkdown(html: string, title?: string): string {
  const blocks = splitBlocks(html);
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    if (isBlankBlock(block)) {
      lines.push("");
      return;
    }
    let md = turndown.turndown(block).replace(/\s+$/, "");
    if (i === 0 && title !== undefined) {
      md = `# ${title}`;
    }
    lines.push(md);
  });
  return (
    lines
      .join("\n")
      // turndown pads list markers ("-   a"); use a single space.
      .replace(/^(\s*)([-*+]|\d+\.)\s{2,}/gm, "$1$2 ")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

/**
 * Convert Markdown to Notes HTML.
 * Each source line becomes its own <div>, blank lines become <div><br></div>,
 * and lists/code blocks/tables are rendered by `marked`.
 */
export function markdownToNotesHtml(md: string): string {
  const tokens = marked.lexer(md.replace(/\r\n/g, "\n"));
  const out: string[] = [];
  for (const token of tokens) {
    out.push(...renderToken(token));
  }
  // Drop trailing blank lines.
  while (out.length && out[out.length - 1] === BLANK_LINE) out.pop();
  return out.join("\n");
}

function renderToken(token: Token): string[] {
  switch (token.type) {
    case "space": {
      // A space token holds the run of blank lines between blocks.
      const n = Math.max(1, (token.raw.match(/\n/g)?.length ?? 1) - 1);
      return Array(n).fill(BLANK_LINE);
    }
    case "heading": {
      const inline = marked.parseInline(token.text) as string;
      return [token.depth === 1 ? `<h1>${inline}</h1>` : `<div><b>${inline}</b></div>`];
    }
    case "paragraph":
    case "text": {
      // Keep the author's line breaks: one div per line.
      return token.text.split("\n").map((line: string) => {
        const inline = marked.parseInline(line) as string;
        return inline.trim() ? `<div>${inline}</div>` : BLANK_LINE;
      });
    }
    case "hr":
      return ["<div>—</div>"];
    default:
      // Lists, code blocks, tables, blockquotes, raw HTML.
      return [(marked.parser([token]) as string).trim()];
  }
}

/** A title line in the HTML form Notes understands. */
export function titleHtml(title: string): string {
  return `<h1>${escapeHtml(title)}</h1>`;
}
