// Starts the API (node --watch) and the Vite dev server together; Ctrl+C stops both.
import { spawn } from "node:child_process";

const procs = [
  ["api", "\x1b[33m", "npm run dev:api"],
  ["web", "\x1b[36m", "npm run dev:web"],
].map(([name, color, cmd]) => {
  const p = spawn(cmd, { shell: true, stdio: ["inherit", "pipe", "pipe"], env: process.env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (d) => out.write(String(d).replace(/^(?=.)/gm, prefix)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    stopAll(code ?? 0);
  });
  return p;
});

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
