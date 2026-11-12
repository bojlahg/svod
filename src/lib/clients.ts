/**
 * Where a brain can be plugged in.
 *
 * One thing worth stating plainly, because it is the most common confusion:
 * MCP is a client feature, not a model feature. Kimi, DeepSeek and GLM are
 * models — you use them inside one of the clients below. A model on its own
 * has nothing to connect to.
 *
 * Every snippet here is taken from that client's own documentation. A config
 * that does not work is worse than no page at all.
 */

export type Family = "cli" | "editor" | "desktop";

export interface Client {
  id: string;
  name: string;
  vendor: string;
  family: Family;
  /** How the config is written. */
  format: "command" | "json" | "toml";
  /** Where it lives, for the ones that use a file. */
  path?: string;
  /** `{URL}` and `{TOKEN}` are replaced at render time. */
  snippet: string;
  note?: string;
  docs: string;
}

const URL_PLACEHOLDER = "{URL}";
const TOKEN_PLACEHOLDER = "{TOKEN}";

export const CLIENTS: Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    family: "cli",
    format: "command",
    snippet: `claude mcp add --transport http svod ${URL_PLACEHOLDER} \\\n  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
    note: "One command, nothing to edit. This is the path we test against.",
    docs: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    family: "cli",
    format: "toml",
    path: "~/.codex/config.toml",
    snippet: `[mcp_servers.svod]\nurl = "${URL_PLACEHOLDER}"\nbearer_token_env_var = "SVOD_TOKEN"`,
    note: "Reads the token from an environment variable rather than the file — export SVOD_TOKEN in your shell profile.",
    docs: "https://developers.openai.com/codex/mcp",
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    vendor: "Moonshot",
    family: "cli",
    format: "command",
    snippet: `kimi mcp add --transport http \\\n  --header "Authorization:Bearer ${TOKEN_PLACEHOLDER}" \\\n  svod ${URL_PLACEHOLDER}`,
    note: "Config lands in ~/.kimi/mcp.json. Note the header takes no space after the colon.",
    docs: "https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/reference/kimi-mcp.md",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    vendor: "Alibaba",
    family: "cli",
    format: "json",
    path: "~/.qwen/settings.json",
    snippet: `{
  "mcpServers": {
    "svod": {
      "httpUrl": "${URL_PLACEHOLDER}",
      "headers": { "Authorization": "Bearer ${TOKEN_PLACEHOLDER}" },
      "timeout": 30000
    }
  }
}`,
    note: "Qwen Code wants httpUrl, not url — the one field that differs from every other client here.",
    docs: "https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/",
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    family: "editor",
    format: "json",
    path: "~/.cursor/mcp.json  ·  or .cursor/mcp.json per project",
    snippet: `{
  "mcpServers": {
    "svod": {
      "url": "${URL_PLACEHOLDER}",
      "headers": { "Authorization": "Bearer ${TOKEN_PLACEHOLDER}" }
    }
  }
}`,
    note: "Supports ${env:SVOD_TOKEN} in place of the token if you would rather not keep it in the file.",
    docs: "https://cursor.com/docs/mcp",
  },
  {
    id: "vscode",
    name: "VS Code",
    vendor: "Microsoft",
    family: "editor",
    format: "json",
    path: ".vscode/mcp.json",
    snippet: `{
  "servers": {
    "svod": {
      "type": "http",
      "url": "${URL_PLACEHOLDER}",
      "headers": { "Authorization": "Bearer ${TOKEN_PLACEHOLDER}" }
    }
  }
}`,
    note: "Copilot agent mode. Note the key is servers, not mcpServers.",
    docs: "https://code.visualstudio.com/docs/copilot/chat/mcp-servers",
  },
  {
    id: "cline",
    name: "Cline · Roo Code",
    vendor: "open source",
    family: "editor",
    format: "json",
    path: "cline_mcp_settings.json  ·  via the MCP Servers panel",
    snippet: `{
  "mcpServers": {
    "svod": {
      "type": "streamableHttp",
      "url": "${URL_PLACEHOLDER}",
      "headers": { "Authorization": "Bearer ${TOKEN_PLACEHOLDER}" }
    }
  }
}`,
    docs: "https://docs.cline.bot/mcp/connecting-to-a-remote-server",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    vendor: "Anthropic",
    family: "desktop",
    format: "json",
    path: "Settings → Connectors → Add custom connector",
    snippet: `{
  "mcpServers": {
    "svod": {
      "url": "${URL_PLACEHOLDER}",
      "headers": { "Authorization": "Bearer ${TOKEN_PLACEHOLDER}" }
    }
  }
}`,
    docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
  },
];

export function renderSnippet(client: Client, url: string, token: string): string {
  return client.snippet
    .replaceAll(URL_PLACEHOLDER, url)
    .replaceAll(TOKEN_PLACEHOLDER, token);
}

/**
 * Models people ask about that are not clients. Listing them stops the
 * "does svod support Kimi?" question, which is really "which client do I run
 * Kimi in?".
 */
export interface ModelNote {
  name: string;
  vendor: string;
  verdict: string;
}

export const MODELS: ModelNote[] = [
  {
    name: "Kimi K2",
    vendor: "Moonshot",
    verdict: "Use Kimi CLI above, or point Claude Code at Moonshot's endpoint.",
  },
  {
    name: "Qwen3-Coder",
    vendor: "Alibaba",
    verdict: "Use Qwen Code above.",
  },
  {
    name: "GLM",
    vendor: "Z.ai · Zhipu",
    verdict: "No agent of its own. Run it inside Claude Code or Cline.",
  },
  {
    name: "DeepSeek",
    vendor: "DeepSeek",
    verdict: "No agent of its own. Run it inside Cline, Cursor or Claude Code.",
  },
  {
    name: "MiniMax M2",
    vendor: "MiniMax",
    verdict: "No agent of its own. Run it inside a client from the list.",
  },
  {
    name: "Wan",
    vendor: "Alibaba",
    verdict:
      "Video generation — it has no tools and no agent loop, so there is nothing for a brain to attach to.",
  },
];
