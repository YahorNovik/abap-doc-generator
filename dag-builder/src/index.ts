import { buildDag } from "./dag-builder";
import { generateDocumentation } from "./doc-generator";

async function main(): Promise<void> {
  const raw = await readStdin();

  let input: any;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write("Error: Invalid JSON input\n");
    process.exit(1);
  }

  if (!input.systemUrl || !input.objectName) {
    process.stderr.write("Error: systemUrl and objectName are required\n");
    process.exit(1);
  }

  try {
    if (input.command === "generate-doc") {
      if (!input.summaryLlm || !input.docLlm) {
        process.stderr.write("Error: summaryLlm and docLlm configs are required for generate-doc\n");
        process.exit(1);
      }
      const result = await generateDocumentation(input);
      process.stdout.write(JSON.stringify(result));
    } else {
      // Default: build-dag (backward compatible)
      const result = await buildDag(input);
      process.stdout.write(JSON.stringify(result));
    }
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
