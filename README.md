# ABAP Documentation Generator

Eclipse plugin that generates LLM-powered documentation for ABAP objects and packages. It analyzes source code and dependencies via the ADT API, builds a dependency graph, and produces structured technical documentation using configurable LLM providers.

## How It Works

### Single Object
1. Fetches the object's source code and dependencies via the ADT API
2. Builds a dependency DAG using [abaplint](https://github.com/abaplint/abaplint) for ABAP parsing
3. Summarizes each dependency in topological order using the summary model
4. Generates full documentation using the doc model, with all dependency summaries as context
5. The doc model can call tools (`get_source`, `get_where_used`) to fetch additional context on demand

### Package
1. Discovers all objects in the package and sub-packages (configurable depth)
2. Builds an internal dependency graph and detects functional clusters using Union-Find
3. Summarizes objects and clusters, triages which objects deserve full documentation
4. Generates individual docs for selected objects and a package overview

## Installation

### Prerequisites
- Eclipse 2024-06+ with [ADT](https://tools.hana.ondemand.com/#abap) installed
- Node.js 20+
- Access to an ABAP system via ADT

### Install from Update Site
1. In Eclipse: **Help > Install New Software...**
2. Add repository: `https://yahornovik.github.io/abap-doc-generator/`
3. Select **ABAP Documentation Generator** and complete the wizard

## Configuration

Open **Window > Preferences > ABAP Doc Generator** to set your SAP connection, LLM providers (summary + doc models), API keys, token budget, and sub-package depth.

## Usage

Right-click an ABAP object or package in the editor and select from the **ABAP Doc** context menu:

- **Generate ABAP Documentation** (`Ctrl+Shift+D`) — Docs for the active object
- **Generate Package Documentation** (`Ctrl+Shift+P`) — Docs for a package
- **Show Dependency Diagram** (`Ctrl+Shift+G`) — Mermaid dependency diagram
- **Save Documentation** (`Ctrl+Shift+S`) — Export to file
- **Open ABAP Doc Chat** (`Ctrl+Shift+C`) — Interactive chat

## Building from Source

```bash
# Build Node.js backend
cd dag-builder && npm ci && npm run build && cd ..

# Copy bundle into plugin
mkdir -p com.abap.doc.plugin/node
cp dag-builder/bundle/dag-builder.js com.abap.doc.plugin/node/

# Build Eclipse plugin
mvn clean verify
```

The P2 update site will be in `com.abap.doc.updatesite/target/repository/`.

## License

[MIT](LICENSE)
