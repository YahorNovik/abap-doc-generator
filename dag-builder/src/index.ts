import { buildDag, createConnectedClient } from "./dag-builder";
import { generateDocumentation } from "./doc-generator";
import { generatePackageDocumentation, triagePackage } from "./package-doc-generator";
import { handleChat } from "./chat-handler";
import { listPackageObjects } from "./package-graph";
import { exportPdf, exportDocx } from "./exporter";
import { ListObjectsResult } from "./types";

async function main(): Promise<void> {
  const raw = await readStdin();

  let input: any;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write("Error: Invalid JSON input\n");
    process.exit(1);
  }

  if (input.command === "export-pdf" || input.command === "export-docx") {
    if (!input.markdown) {
      process.stderr.write("Error: markdown is required for export commands\n");
      process.exit(1);
    }
  } else if (!input.systemUrl || (!input.objectName && !input.packageName)) {
    process.stderr.write("Error: systemUrl and objectName (or packageName) are required\n");
    process.exit(1);
  }

  try {
    if (input.command === "export-pdf") {
      const buffer = await exportPdf(input.markdown, input.title ?? "Documentation");
      process.stdout.write(JSON.stringify({ data: buffer.toString("base64") }));
    } else if (input.command === "export-docx") {
      const buffer = await exportDocx(input.markdown, input.title ?? "Documentation");
      process.stdout.write(JSON.stringify({ data: buffer.toString("base64") }));
    } else if (input.command === "list-package-objects") {
      if (!input.packageName) {
        process.stderr.write("Error: packageName is required for list-package-objects\n");
        process.exit(1);
      }
      const client = await createConnectedClient(
        input.systemUrl, input.username, input.password, input.client,
      );
      try {
        const maxDepth = input.maxSubPackageDepth ?? 2;
        const data = await listPackageObjects(client, input.packageName, maxDepth);
        const result: ListObjectsResult = {
          packageName: input.packageName,
          objects: data.objects,
          subPackages: data.subPackages,
          errors: data.errors,
        };
        process.stdout.write(JSON.stringify(result));
      } finally {
        try { await client.disconnect(); } catch { /* ignore */ }
      }
    } else if (input.command === "triage-package") {
      if (!input.summaryLlm) {
        process.stderr.write("Error: summaryLlm config is required for triage-package\n");
        process.exit(1);
      }
      if (!input.packageName) {
        process.stderr.write("Error: packageName is required for triage-package\n");
        process.exit(1);
      }
      const result = await triagePackage(input);
      process.stdout.write(JSON.stringify(result));
    } else if (input.command === "generate-package-doc") {
      if (!input.summaryLlm || !input.docLlm) {
        process.stderr.write("Error: summaryLlm and docLlm configs are required for generate-package-doc\n");
        process.exit(1);
      }
      if (!input.packageName) {
        process.stderr.write("Error: packageName is required for generate-package-doc\n");
        process.exit(1);
      }
      const result = await generatePackageDocumentation(input);
      process.stdout.write(JSON.stringify(result));
    } else if (input.command === "generate-doc") {
      if (!input.summaryLlm || !input.docLlm) {
        process.stderr.write("Error: summaryLlm and docLlm configs are required for generate-doc\n");
        process.exit(1);
      }
      const result = await generateDocumentation(input);
      process.stdout.write(JSON.stringify(result));
    } else if (input.command === "chat") {
      if (!input.docLlm) {
        process.stderr.write("Error: docLlm config is required for chat\n");
        process.exit(1);
      }
      const result = await handleChat(input);
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
