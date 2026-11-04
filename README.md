# kafen-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents read [卡粉论坛 DocOfCard](https://forum.docofcard.com/), a Discourse forum about credit cards, banking and payments.

The forum requires an account to read anything. kafen-mcp signs in with a Discourse **User API key** issued through the forum's own device authorization page: you approve it once in your browser, and the key is limited to the `read` scope, so the server can browse but never post, like, or change settings.

## Tools

| Tool | What it does |
| --- | --- |
| `list_topics` | Latest / new / unread / top / hot feeds, optionally filtered by category and tag, paginated |
| `read_topic` | A topic's posts as Markdown (author, time, reply target, likes, reactions, polls); accepts ids or URLs and pages by post number |
| `search` | Full-text search with Discourse filters (`@user`, `#category`, `tags:`, `in:title`, `status:solved`, `after:`, `order:latest` …) |
| `list_categories` | Category tree with slugs, ids, topic counts and descriptions |
| `get_user` | Profile, stats, bio and recent topics/replies of a user |
| `list_notifications` | The signed-in account's notifications (does not mark them read) |
| `view_image` | Fetches a screenshot or image from a post and returns it to the model |
| `login` / `auth_status` | Start the browser authorization from inside the agent and check which account is active |

Post HTML is converted to compact Markdown: images link to the original upload (with the forum's AI caption as alt text when available), quotes name their source post, and oneboxes collapse to a titled link.

## Setup

Requires Node.js 22 or newer.

```sh
git clone https://github.com/ChrAlpha/kafen-mcp.git
cd kafen-mcp
pnpm install
pnpm build
```

### Authorize

```sh
node dist/cli.mjs login
```

The command prints a link and a confirmation code. Open the link in a browser where you are logged in to the forum, check the code, and click **Authorize**. The key is stored in `$XDG_CONFIG_HOME/kafen-mcp/credentials.json` (usually `~/.config/kafen-mcp/`, `%APPDATA%\kafen-mcp\` on Windows) with `0600` permissions.

You can skip this step and let the agent call the `login` tool instead; it returns the same link and code for you to open, and `auth_status` waits for the approval.

```sh
node dist/cli.mjs status   # which account is active
node dist/cli.mjs logout   # revoke the key on the forum and delete it locally
```

The key also appears under **Preferences → Apps** on your forum profile (`/my/preferences/apps`), where it can be revoked at any time.

### Register with an MCP client

Claude Code:

```sh
claude mcp add kafen -- node /absolute/path/to/kafen-mcp/dist/cli.mjs
```

Claude Desktop, Cursor and other clients that use an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "kafen": {
      "command": "node",
      "args": ["/absolute/path/to/kafen-mcp/dist/cli.mjs"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kafen]
command = "node"
args = ["/absolute/path/to/kafen-mcp/dist/cli.mjs"]
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAFEN_BASE_URL` | `https://forum.docofcard.com` | Forum to read; any Discourse site with user API keys enabled works |
| `KAFEN_MCP_CONFIG_DIR` | `$XDG_CONFIG_HOME/kafen-mcp` | Where `credentials.json` lives |
| `KAFEN_USER_API_KEY` | — | Use this key instead of the credential store (for CI or containers) |
| `KAFEN_USER_API_CLIENT_ID` | `kafen-mcp` | Client id the key in `KAFEN_USER_API_KEY` was issued to |

## Rate limits

Discourse allows about 50 requests per minute and 4,000 per day for each User API key. The client keeps itself under 45 requests per minute, waits out short `429` responses once, and reports longer waits to the agent instead of blocking. Most tools cost one request; `read_topic` with a large `limit` and `get_user` cost up to three.

## Development

```sh
pnpm typecheck
pnpm test                 # unit tests
pnpm build && KAFEN_E2E=1 KAFEN_BASE_URL=https://meta.discourse.org pnpm test e2e
```

The end-to-end suite drives the built server over stdio against a live forum. To run it against DocOfCard, log in first and pass the same `KAFEN_MCP_CONFIG_DIR`.

## License

[MIT](LICENSE)
