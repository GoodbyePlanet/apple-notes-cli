#!/usr/bin/env node
import { Command, Option } from "commander";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { markdownToNotesHtml, notesHtmlToMarkdown, splitTitle, titleHtml } from "./format.js";
import { NotesError } from "./jxa.js";
import { createNote, getNote, listFolders, listNotes, setBody, type NoteDetail, type NoteSummary } from "./notes.js";

const program = new Command();
program
  .name("notes")
  .description("Read, create and edit Apple Notes from the terminal.\n\n" +
    "A <note> can be a title, a full id (x-coredata://…) or a short id (p123) as shown by `notes list`.")
  .version("0.1.0");

// ---------- helpers ----------

function shortId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printNoteTable(notes: NoteSummary[]): void {
  if (notes.length === 0) {
    console.log("No notes found.");
    return;
  }
  const idW = Math.max(...notes.map((n) => shortId(n.id).length));
  const folderW = Math.min(20, Math.max(...notes.map((n) => n.folder.length)));
  for (const n of notes) {
    const folder = n.folder.length > folderW ? n.folder.slice(0, folderW - 1) + "…" : n.folder.padEnd(folderW);
    const title = n.locked ? `${n.name} [locked]` : n.name;
    console.log(`${shortId(n.id).padEnd(idW)}  ${formatDate(n.modified)}  ${folder}  ${title}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Text from --body, --file, or piped stdin (in that order); undefined if none given. */
async function readInput(opts: { body?: string; file?: string }): Promise<string | undefined> {
  if (opts.body !== undefined) return opts.body;
  if (opts.file !== undefined) return opts.file === "-" ? readStdin() : readFileSync(opts.file, "utf8");
  if (!process.stdin.isTTY) {
    const text = await readStdin();
    return text.length ? text : undefined;
  }
  return undefined;
}

function toHtml(text: string, raw: boolean): string {
  return raw ? text : markdownToNotesHtml(text);
}

function openInEditor(content: string, ext: string): string {
  const dir = mkdtempSync(join(tmpdir(), "notes-cli-"));
  const file = join(dir, `note.${ext}`);
  try {
    writeFileSync(file, content);
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const res = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
    if (res.status !== 0) throw new NotesError(`Editor exited with status ${res.status}; note not changed`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Content that Notes keeps outside the HTML body, or that Markdown can't represent. */
function lossyParts(note: NoteDetail): string[] {
  const parts: string[] = [];
  if (note.attachments > 0) parts.push(`${note.attachments} attachment(s)`);
  if (/<table\b/i.test(note.body)) parts.push("a table");
  if (/<img\b/i.test(note.body)) parts.push("an image");
  return parts;
}

// ---------- commands ----------

program
  .command("folders")
  .description("List folders")
  .option("--json", "output JSON")
  .action(async (opts) => {
    const folders = await listFolders();
    if (opts.json) return console.log(JSON.stringify(folders, null, 2));
    const multiAccount = new Set(folders.map((f) => f.account)).size > 1;
    for (const f of folders) {
      const name = multiAccount ? `${f.account}/${f.name}` : f.name;
      console.log(`${String(f.count).padStart(5)}  ${name}`);
    }
  });

program
  .command("list")
  .alias("ls")
  .description("List notes, newest first")
  .option("-f, --folder <name>", "only notes in this folder")
  .option("-n, --limit <n>", "show at most n notes", (v) => parseInt(v, 10), 20)
  .option("-a, --all", "show all notes (ignore --limit)")
  .option("--json", "output JSON")
  .action(async (opts) => {
    let notes = await listNotes({ folder: opts.folder });
    if (!opts.all) notes = notes.slice(0, opts.limit);
    if (opts.json) return console.log(JSON.stringify(notes, null, 2));
    printNoteTable(notes);
  });

program
  .command("search <query>")
  .description("Find notes whose title or text contains <query> (case-insensitive)")
  .option("-f, --folder <name>", "only search this folder")
  .option("--json", "output JSON")
  .action(async (query: string, opts) => {
    const notes = await listNotes({ folder: opts.folder, query });
    if (opts.json) return console.log(JSON.stringify(notes, null, 2));
    printNoteTable(notes);
  });

program
  .command("show <note>")
  .alias("cat")
  .description("Print a note (as Markdown by default)")
  .addOption(new Option("--html", "print the raw HTML body").conflicts("plain"))
  .option("--plain", "print plain text")
  .option("--json", "output JSON with metadata and body")
  .action(async (ref: string, opts) => {
    const note = await getNote(ref);
    if (opts.json) return console.log(JSON.stringify(note, null, 2));
    if (opts.html) { process.stdout.write(note.body); return; }
    if (opts.plain) { process.stdout.write(note.plaintext); return; }
    process.stdout.write(notesHtmlToMarkdown(note.body, note.name));
  });

program
  .command("create")
  .alias("new")
  .description("Create a note. Body comes from --body, --file or stdin (Markdown).")
  .option("-t, --title <title>", "note title (first line)")
  .option("-b, --body <text>", "note body")
  .option("--file <path>", "read body from a file ('-' for stdin)")
  .option("-f, --folder <name>", "folder to create the note in (default: Notes' default folder)")
  .option("-e, --editor", "write the body in $EDITOR")
  .option("--html", "treat the body as raw Notes HTML instead of Markdown")
  .option("--json", "output JSON")
  .action(async (opts) => {
    let text = await readInput(opts);
    if (text === undefined && opts.editor) {
      text = openInEditor(opts.title ? "" : "# Title\n\n", opts.html ? "html" : "md");
    }
    if (!opts.title && !text?.trim()) {
      throw new NotesError("Nothing to create: give --title and/or a body (--body, --file, stdin or --editor)");
    }
    const parts: string[] = [];
    if (opts.title) parts.push(titleHtml(opts.title));
    if (text?.trim()) parts.push(toHtml(text, opts.html));
    const created = await createNote(parts.join("\n"), opts.folder);
    if (opts.json) return console.log(JSON.stringify(created, null, 2));
    console.log(`Created "${created.name}" in ${created.folder} (${shortId(created.id)})`);
  });

program
  .command("edit <note>")
  .description(
    "Edit a note. Replace the body (--body/--file/stdin), --append to it, rename with --title, " +
      "or open it in $EDITOR (default when no other option is given).",
  )
  .option("-b, --body <text>", "replace the body (title is kept)")
  .option("--file <path>", "replace the body from a file ('-' for stdin)")
  .option("-a, --append <text>", "append text to the end of the note")
  .option("-t, --title <title>", "change the title")
  .option("-e, --editor", "edit the whole note in $EDITOR")
  .option("--html", "work with raw Notes HTML instead of Markdown")
  .option("--force", "edit even if the note has attachments/tables that may be lost")
  .action(async (ref: string, opts) => {
    const note = await getNote(ref);
    const explicitBody = opts.body !== undefined || opts.file !== undefined;
    if (opts.editor && (explicitBody || opts.append !== undefined || opts.title !== undefined)) {
      throw new NotesError("--editor can't be combined with --body/--file/--append/--title");
    }
    if (explicitBody && opts.append !== undefined) {
      throw new NotesError("Use either a replacement body (--body/--file) or --append, not both");
    }
    // Piped stdin replaces the body only when no other edit was requested.
    const readsStdin = !opts.editor && opts.append === undefined && opts.title === undefined;
    const replacement = explicitBody || readsStdin ? await readInput(opts) : undefined;
    const useEditor = opts.editor || (replacement === undefined && opts.append === undefined && opts.title === undefined);

    const lossy = lossyParts(note);
    if (lossy.length && !opts.force && !useEditor) {
      throw new NotesError(
        `"${note.name}" contains ${lossy.join(", ")}, which may be lost when the body is rewritten. ` +
          "Re-run with --force to edit anyway.",
      );
    }

    let html: string;
    if (useEditor) {
      const original = opts.html ? note.body : notesHtmlToMarkdown(note.body, note.name);
      const edited = openInEditor(original, opts.html ? "html" : "md");
      if (edited === original) return console.log("No changes.");
      if (!edited.trim()) throw new NotesError("Edited note is empty; not saving (delete it in Notes instead)");
      if (lossy.length && !opts.force && !(await confirm(`Note contains ${lossy.join(", ")} that may be lost. Save anyway?`))) {
        return console.log("Not saved.");
      }
      html = toHtml(edited, opts.html);
    } else {
      const { titleHtml: currentTitle, restHtml } = splitTitle(note.body);
      const title = opts.title !== undefined ? titleHtml(opts.title) : currentTitle;
      let rest = restHtml;
      if (replacement !== undefined) rest = toHtml(replacement, opts.html);
      if (opts.append !== undefined) rest = [restHtml, toHtml(opts.append, opts.html)].filter(Boolean).join("\n");
      html = [title, rest].filter(Boolean).join("\n");
    }

    const saved = await setBody(note.id, html);
    console.log(`Saved "${saved.name}" (${shortId(saved.id)})`);
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof NotesError) {
    console.error(`notes: ${err.message}`);
    process.exit(err.code === "NOT_FOUND" ? 2 : 1);
  }
  console.error(err);
  process.exit(1);
});
