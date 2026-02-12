import { ToolDefinition } from "./types";

/**
 * Tools available to the documentation agent during final doc generation.
 */
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "get_source",
    description:
      "Fetch the ABAP source code of an object by name. " +
      "Use this to inspect the implementation of classes, interfaces, programs, or function groups " +
      "that you need to understand in more detail for documentation.",
    parameters: {
      type: "object",
      properties: {
        object_name: {
          type: "string",
          description: "The ABAP object name, e.g. ZCL_MY_CLASS or ZIF_MY_INTERFACE.",
        },
      },
      required: ["object_name"],
    },
  },
  {
    name: "get_where_used",
    description:
      "Get the where-used list for an ABAP object. " +
      "Returns objects that reference the given object. " +
      "Use this to understand how an object is consumed across the codebase.",
    parameters: {
      type: "object",
      properties: {
        object_name: {
          type: "string",
          description: "The ABAP object name to look up, e.g. ZCL_MY_CLASS.",
        },
      },
      required: ["object_name"],
    },
  },
];

/**
 * Convert provider-agnostic tool definitions to OpenAI format.
 */
export function toOpenAITools(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Convert provider-agnostic tool definitions to Gemini format.
 * Gemini requires uppercase type names (OBJECT, STRING, etc.).
 */
export function toGeminiTools(tools: ToolDefinition[]): any[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: uppercaseTypes(t.parameters),
      })),
    },
  ];
}

function uppercaseTypes(schema: any): any {
  if (schema == null || typeof schema !== "object") return schema;
  const result: any = { ...schema };
  if (typeof result.type === "string") {
    result.type = result.type.toUpperCase();
  }
  if (result.properties) {
    const newProps: any = {};
    for (const [key, val] of Object.entries(result.properties)) {
      newProps[key] = uppercaseTypes(val);
    }
    result.properties = newProps;
  }
  return result;
}
