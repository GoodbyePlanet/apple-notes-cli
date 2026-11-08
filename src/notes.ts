import { runJxa } from "./jxa.js";

// Everything inside the template strings below runs in osascript (JXA), not Node.

export interface FolderInfo {
  account: string;
  name: string;
  count: number;
}

export interface NoteSummary {
  id: string;
  name: string;
  folder: string;
  account: string;
  modified: string;
  locked: boolean;
}

export interface NoteDetail extends NoteSummary {
  created: string;
  body: string;
  plaintext: string;
  attachments: number;
}

const TRASH = "Recently Deleted";

/** JXA helpers shared by scripts that take a note reference (id, short id or title). */
const RESOLVE = `
const TRASH = ${JSON.stringify(TRASH)};
function describe(n) {
  return n.id() + "  [" + n.container().name() + "]  " + n.name();
}
function resolveNote(app, ref) {
  let matches;
  if (ref.indexOf("x-coredata://") === 0) {
    const n = app.notes.byId(ref);
    try { n.name(); } catch (e) { throw new Error("NOT_FOUND: No note with id " + ref); }
    return n;
  }
  if (/^p\\d+$/.test(ref)) {
    // Short id: the last path component of the full x-coredata id.
    const ids = app.notes.id().filter(function (id) { return id.endsWith("/" + ref); });
    matches = ids.map(function (id) { return app.notes.byId(id); });
  } else {
    matches = app.notes.whose({ name: ref })();
  }
  matches = matches.filter(function (n) { return n.container().name() !== TRASH; });
  if (matches.length === 0) throw new Error("NOT_FOUND: No note matching \\"" + ref + "\\"");
  if (matches.length > 1) {
    throw new Error("AMBIGUOUS: " + matches.length + " notes match \\"" + ref + "\\"; use an id:\\n" +
      matches.map(describe).join("\\n"));
  }
  return matches[0];
}`;

function withResolve(fn: string): string {
  return `(function () { ${RESOLVE}\n return ${fn}; })()`;
}

export function listFolders(): Promise<FolderInfo[]> {
  return runJxa(`(args, app) => {
    const out = [];
    app.accounts().forEach(function (acc) {
      acc.folders().forEach(function (f) {
        out.push({ account: acc.name(), name: f.name(), count: f.notes.length });
      });
    });
    return out;
  }`);
}

export interface ListOptions {
  folder?: string;
  query?: string;
}

/**
 * List notes, newest first. With `query`, only notes whose title or text contains it
 * (case-insensitive). Notes in "Recently Deleted" are skipped unless asked for by folder.
 */
export async function listNotes(opts: ListOptions = {}): Promise<NoteSummary[]> {
  const notes = await runJxa<NoteSummary[]>(
    `(args, app) => {
      const out = [];
      const wanted = args.folder ? args.folder.toLowerCase() : null;
      let folderSeen = false;
      app.accounts().forEach(function (acc) {
        acc.folders().forEach(function (f) {
          const name = f.name();
          if (wanted ? name.toLowerCase() !== wanted : name === ${JSON.stringify(TRASH)}) return;
          folderSeen = true;
          const spec = args.query
            ? f.notes.whose({ _or: [{ name: { _contains: args.query } }, { plaintext: { _contains: args.query } }] })
            : f.notes;
          // Bulk property reads: one Apple Event per property instead of one per note.
          const ids = spec.id();
          if (ids.length === 0) return;
          const names = spec.name();
          const mods = spec.modificationDate();
          const locked = spec.passwordProtected();
          for (let i = 0; i < ids.length; i++) {
            out.push({ id: ids[i], name: names[i], folder: name, account: acc.name(), modified: mods[i], locked: locked[i] });
          }
        });
      });
      if (wanted && !folderSeen) throw new Error("NOT_FOUND: No folder named \\"" + args.folder + "\\"");
      return out;
    }`,
    opts,
  );
  return notes.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function getNote(ref: string): Promise<NoteDetail> {
  return runJxa(
    withResolve(`(args, app) => {
      const n = resolveNote(app, args.ref);
      const folder = n.container();
      const locked = n.passwordProtected();
      if (locked) throw new Error("LOCKED: \\"" + n.name() + "\\" is password-protected; unlock it in Notes first");
      return {
        id: n.id(), name: n.name(), folder: folder.name(), account: folder.container().name(),
        created: n.creationDate(), modified: n.modificationDate(), locked: locked,
        body: n.body(), plaintext: n.plaintext(), attachments: n.attachments.length,
      };
    }`),
    { ref },
  );
}

export function createNote(html: string, folder?: string): Promise<{ id: string; name: string; folder: string }> {
  return runJxa(
    `(args, app) => {
      let target = null;
      if (args.folder) {
        const wanted = args.folder.toLowerCase();
        app.accounts().forEach(function (acc) {
          acc.folders().forEach(function (f) {
            if (!target && f.name().toLowerCase() === wanted) target = f;
          });
        });
        if (!target) throw new Error("NOT_FOUND: No folder named \\"" + args.folder + "\\"");
      } else {
        target = app.defaultAccount().defaultFolder();
      }
      const n = app.make({ new: "note", withProperties: { body: args.html }, at: target });
      return { id: n.id(), name: n.name(), folder: target.name() };
    }`,
    { html, folder },
  );
}

/** Replace a note's whole body. Notes derives the title from the first line. */
export function setBody(id: string, html: string): Promise<{ id: string; name: string }> {
  return runJxa(
    withResolve(`(args, app) => {
      const n = resolveNote(app, args.id);
      if (n.passwordProtected()) throw new Error("LOCKED: note is password-protected");
      n.body = args.html;
      return { id: n.id(), name: n.name() };
    }`),
    { id, html },
  );
}
