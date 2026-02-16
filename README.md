# ABAP Documentation Generator

Eclipse plugin that generates LLM-powered documentation for ABAP objects and packages. It analyzes source code and dependencies via the ADT API, builds a dependency graph, and produces structured technical documentation using configurable LLM providers.

## Features

- **Single Object Documentation** — Generate documentation for an individual ABAP class, interface, function group, program, or CDS view with full dependency context
- **Package Documentation** — Document an entire ABAP package: objects are clustered by dependency relationships (Union-Find with hub filtering), summarized bottom-up, triaged for relevance, and assembled into a cohesive package overview
- **Interactive Chat** — Ask follow-up questions about generated documentation in a built-in chat view
- **Export** — Save documentation as Markdown, PDF, or DOCX
- **Multi-LLM Support** — Works with Gemini, OpenAI, and any OpenAI-compatible provider (e.g., Ollama, LM Studio, vLLM)
- **Two-Model Strategy** — Use a fast/cheap model for dependency summarization and a capable model for final documentation generation
- **Token Budget** — Set a maximum token limit to control LLM costs

## How It Works

### Single Object
1. Fetches the object's source code and its dependencies via the ABAP ADT API
2. Builds a dependency DAG (directed acyclic graph) using [abaplint](https://github.com/abaplint/abaplint) for ABAP parsing
3. Summarizes each dependency in topological order (leaves first, parallel by level) using the summary model
4. Generates full documentation for the target object using the doc model, with all dependency summaries as context
5. The doc model has access to tools (`get_source`, `get_where_used`) to fetch additional context from the ABAP system on demand

### Package
1. Discovers all objects in the package (and sub-packages up to configurable depth)
2. Fetches source code for all objects and builds an internal dependency graph
3. Detects functional clusters using Union-Find on internal dependency edges, with hub filtering to prevent utility objects from merging unrelated groups
4. Summarizes each object, then each cluster
5. Triages which objects deserve full documentation (LLM-based)
6. Generates individual documentation for selected objects and a package overview

## Supported Object Types

CLAS, INTF, PROG, FUGR, TABL, DDLS, VIEW, DTEL, DOMA, TTYP, DCLS, DDLX, BDEF, SRVD, ENHO, ENHS, XSLT, MSAG, TRAN

## Installation

### Prerequisites
- Eclipse 2024-06 or newer with [ABAP Development Tools (ADT)](https://tools.hana.ondemand.com/#abap) installed
- Node.js 20 or newer installed on your machine
- Access to an ABAP system via ADT (RFC/HTTP)

### Install from Update Site
1. In Eclipse, go to **Help > Install New Software...**
2. Add this URL as a repository: `https://yahornovik.github.io/abap-doc-generator/`
3. Select **ABAP Documentation Generator** and follow the installation wizard

## Configuration

Open **Window > Preferences > ABAP Doc Generator** to configure:

| Setting | Description |
|---------|-------------|
| System URL | Your ABAP system ADT endpoint |
| Client | SAP client number |
| Username / Password | ABAP system credentials |
| Summary LLM Provider | Provider for dependency summaries (`gemini`, `openai`, `openai-compatible`) |
| Summary LLM Model | Model name (e.g., `gemini-2.5-flash`, `gpt-4.1-mini`) |
| Summary LLM API Key | API key for the summary provider |
| Doc LLM Provider | Provider for full documentation generation |
| Doc LLM Model | Model name (e.g., `gemini-2.5-pro`, `gpt-4.1`) |
| Doc LLM API Key | API key for the doc provider |
| Max Total Tokens | Token budget across all LLM calls (0 = unlimited) |
| Documentation Template | `default`, `minimal`, `detailed`, `api-reference`, or `custom` |
| Sub-Package Depth | How deep to recurse into sub-packages (0-5) |

For `openai-compatible` providers, also set the **Base URL** field to your endpoint.

## Usage

| Command | Shortcut | Description |
|---------|----------|-------------|
| Generate ABAP Documentation | `Ctrl+Shift+D` | Generate docs for the object in the active editor |
| Generate Package Documentation | `Ctrl+Shift+P` | Generate docs for a selected package |
| Show Dependency Diagram | `Ctrl+Shift+G` | Show a visual Mermaid dependency diagram |
| Save Documentation | `Ctrl+Shift+S` | Export current documentation to file |
| Open ABAP Doc Chat | `Ctrl+Shift+C` | Open the interactive chat view |

All commands are also available from the **ABAP Doc** menu in the menu bar and from the right-click context menu.

## Building from Source

### Prerequisites
- Node.js 20+
- JDK 21
- Maven 3.9+

### Build

```bash
# Build the Node.js backend
cd dag-builder
npm ci
npm run build
cd ..

# Copy the bundle into the plugin
mkdir -p com.abap.doc.plugin/node
cp dag-builder/bundle/dag-builder.js com.abap.doc.plugin/node/

# Build the Eclipse plugin with Maven Tycho
mvn clean verify
```

The P2 update site will be in `com.abap.doc.updatesite/target/repository/`.

## Architecture

```
abap-doc-generator/
├── dag-builder/              # Node.js backend (TypeScript)
│   └── src/
│       ├── index.ts          # CLI entry point (reads JSON from stdin)
│       ├── dag-builder.ts    # Dependency DAG construction via ADT API
│       ├── doc-generator.ts  # Single object documentation pipeline
│       ├── package-doc-generator.ts  # Package documentation pipeline
│       ├── package-graph.ts  # Package graph building + Union-Find clustering
│       ├── llm-client.ts     # LLM provider abstraction (Gemini/OpenAI)
│       ├── agent-loop.ts     # Agentic tool-use loop for doc generation
│       ├── prompts.ts        # All LLM prompt templates
│       ├── chat-handler.ts   # Chat conversation handler
│       └── exporter.ts       # PDF/DOCX export
├── com.abap.doc.plugin/      # Eclipse plugin (Java)
│   └── src/com/abap/doc/plugin/
│       ├── handler/          # Command handlers (UI orchestration)
│       ├── dag/              # DagRunner (Java ↔ Node.js bridge)
│       ├── chat/             # Chat view (SWT)
│       └── preferences/      # Preference page
├── com.abap.doc.feature/     # Eclipse feature definition
├── com.abap.doc.updatesite/  # P2 update site
└── .github/workflows/        # CI/CD: build + deploy to GitHub Pages
```

The Eclipse plugin (Java/SWT) handles the UI and orchestration. It spawns the Node.js backend as a subprocess, passing JSON via stdin and reading results from stdout. The Node.js side handles all ABAP source fetching (via `abap-adt-api`), parsing (via `@abaplint/core`), and LLM communication.

## License

[MIT](LICENSE)
