/** The 5 syntax examples for the collapsible help (spec: heading, list, link, table, code). */
export const MARKDOWN_HELP_EXAMPLES: { title: string; sample: string }[] = [
  { title: "Heading", sample: "# Recipe title\n\n## Section" },
  { title: "List", sample: "- First step\n- Second step\n\n1. Ordered one\n2. Ordered two" },
  { title: "Link", sample: "[Moon docs](https://example.com/moon)" },
  {
    title: "Table",
    sample: "| Prop | Value |\n| --- | --- |\n| Import | Texture |\n| Mode | Sprite |",
  },
  { title: "Code", sample: "Inline `code` in text.\n\n```csharp\nvar btn = new Button();\n```" },
];
