import { buildDag } from "./dag-builder";
import { DagInput } from "./types";

async function main(): Promise<void> {
  const input = await readStdin();

  let dagInput: DagInput;
  try {
    dagInput = JSON.parse(input);
  } catch {
    process.stderr.write("Error: Invalid JSON input\n");
    process.exit(1);
  }

  if (!dagInput.systemUrl || !dagInput.objectName) {
    process.stderr.write("Error: systemUrl and objectName are required\n");
    process.exit(1);
  }

  try {
    const result = await buildDag(dagInput);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

main();
