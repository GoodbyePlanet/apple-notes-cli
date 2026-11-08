import { execFile } from "node:child_process";

export class NotesError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "AMBIGUOUS" | "LOCKED" | "PERMISSION" | "SCRIPT" = "SCRIPT",
  ) {
    super(message);
  }
}

/**
 * Run a JXA script with `osascript -l JavaScript`.
 *
 * `fnSource` must be the source of a function `(args, app) => result`. It runs inside
 * osascript with `app = Application("Notes")`; its return value is JSON-encoded and parsed here.
 * Arguments travel as a JSON string in argv, never spliced into the script source,
 * so quotes/newlines in note text can't break or inject into the script.
 *
 * Inside the script, throw `new Error("NOT_FOUND: …")` (or AMBIGUOUS / LOCKED) to get
 * a typed NotesError on the Node side.
 */
export function runJxa<T>(fnSource: string, args: unknown = {}): Promise<T> {
  const script = `
function run(argv) {
  const app = Application("Notes");
  const args = JSON.parse(argv[0]);
  const fn = ${fnSource};
  const result = fn(args, app);
  return JSON.stringify(result === undefined ? null : result);
}`;
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", script, JSON.stringify(args)],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(toNotesError(stderr || err.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as T);
        } catch {
          reject(new NotesError(`Could not parse osascript output: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

function toNotesError(stderr: string): NotesError {
  if (/-1743|not authori[sz]ed/i.test(stderr)) {
    return new NotesError(
      "Not allowed to control Notes. Enable your terminal under " +
        "System Settings → Privacy & Security → Automation → Notes, then retry.",
      "PERMISSION",
    );
  }
  const m = stderr.match(/Error: (NOT_FOUND|AMBIGUOUS|LOCKED): ([\s\S]*?)(?: \(-?\d+\))?\s*$/);
  if (m) {
    return new NotesError(m[2].trim(), m[1] as NotesError["code"]);
  }
  const msg = stderr.replace(/^.*execution error: /, "").trim();
  return new NotesError(msg || "osascript failed");
}
