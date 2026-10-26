#!/usr/bin/env node
/**
 * technical-minimal-web MCP server
 *
 * Exposes the Technical Minimal theme pack (the demo in ../index.html) over the
 * Model Context Protocol. The single source of truth is index.html itself: every
 * tool parses the token blocks from that file at call time, so the server can never
 * drift from the demo. Zero framework code in the repo, vanilla JS + official SDK.
 *
 * Transport: stdio (run by OpenCode / Claude / any MCP client as a local process).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "..", "index.html");

const THEMES = ["light", "mango", "limoncello", "aperol", "spritz", "dark", "cactus"];
const NAMES = {
  light: "Light", mango: "Mango", limoncello: "Limoncello", aperol: "Aperol",
  spritz: "Aperol Spritz", dark: "Dark", cactus: "Cactus",
};

/* ---------- parse the demo (source of truth) ---------- */
function src() { return readFileSync(DEMO, "utf8"); }

function tokensOf(raw) {
  /* drop the highlighted <pre> snippet in section 02 — it repeats the blocks with <span>s */
  const text = raw.replace(/<pre>[\s\S]*?<\/pre>/g, "");
  const out = {};
  /* :root, [data-theme="light"] { … }  and  [data-theme="mango"] { … } */
  const re = /:root\s*,\s*\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}|\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1] || m[3];
    const body = (m[2] || m[4]).trim();
    const vars = {};
    for (const v of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    out[key] = vars;
  }
  return out;
}

function cssBlock(raw, theme) {
  const text = raw.replace(/<pre>[\s\S]*?<\/pre>/g, "");
  const re = new RegExp(`[^\\n]*\\[data-theme="${theme}"\\]\\s*\\{[^}]*\\}`, "m");
  const m = text.match(re);
  if (!m) return null;
  const i = text.indexOf(m[0]);
  const lineStart = text.lastIndexOf("\n", i) + 1;
  return text.slice(lineStart, text.indexOf("}", i) + 1);
}

function rootBlock(raw) {
  const text = raw.replace(/<pre>[\s\S]*?<\/pre>/g, "");
  const m = text.match(/:root\s*,\s*\[data-theme="light"\]\s*\{[^}]*\}/);
  return m ? m[0] : null;
}

function fluidSteps(text) {
  const base = (text.match(/^\s*html\s*\{[^\n]*font-size[^\n]*$/gm) || []).map((s) => s.trim());
  const media = (text.match(/^\s*@media[^\n]*html\s*\{[^\n]*font-size[^\n]*$/gm) || [])
    .map((s) => s.trim())
    .sort((a, b) => parseInt(/\(min-width:(\d+)/.exec(a)?.[1] || 0) - parseInt(/\(min-width:(\d+)/.exec(b)?.[1] || 0));
  return base.concat(media);
}

function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function text(t) {
  return { content: [{ type: "text", text: t }] };
}

/* ---------- server ---------- */
const server = new McpServer({ name: "technical-minimal-web", version: "2.0.0" });

const themeArg = z
  .enum(THEMES, { description: "Theme key" })
  .describe("Theme key: " + THEMES.join(", "));

server.registerTool(
  "list_themes",
  {
    title: "List themes",
    description:
      "The 7 Technical Minimal themes (key, display name, background, LED accent) parsed from the demo.",
    inputSchema: {},
  },
  async () => {
    const t = tokensOf(src());
    return json(
      THEMES.map((k) => ({
        key: k,
        name: NAMES[k],
        bg: t[k]?.["--bg"] ?? null,
        surface: t[k]?.["--surface"] ?? null,
        accent: t[k]?.["--accent"] ?? null,
        text: t[k]?.["--text"] ?? null,
        muted: t[k]?.["--muted"] ?? null,
      }))
    );
  }
);

server.registerTool(
  "get_theme_tokens",
  {
    title: "Get theme tokens",
    description:
      "CSS token block of one theme ([data-theme=\"…\"] { … }) — background, hairlines, text, accent, dot grid. Copy into your stylesheet.",
    inputSchema: { theme: themeArg },
  },
  async ({ theme }) => {
    const b = cssBlock(src(), theme);
    return b
      ? text(b)
      : { content: [{ type: "text", text: `theme not found: ${theme}` }], isError: true };
  }
);

server.registerTool(
  "get_tokens_css",
  {
    title: "Get full tokens.css",
    description:
      "Full token stylesheet for pasting into a project: :root/light block + all 7 [data-theme] blocks, exactly as shipped in index.html.",
    inputSchema: {
      theme: z
        .enum(THEMES)
        .optional()
        .describe("Optional: also return this single block separately"),
    },
  },
  async ({ theme } = {}) => {
    const s = src();
    const root = rootBlock(s);
    const blocks = THEMES.map((k) => cssBlock(s, k)).filter(Boolean);
    const out = [root, ...blocks].filter(Boolean).join("\n\n");
    return theme
      ? text(out + `\n\n/* --- requested ${theme} --- */\n` + (cssBlock(s, theme) || ""))
      : text(out);
  }
);

server.registerTool(
  "get_fluid_type",
  {
    title: "Get fluid type steps",
    description:
      "The html{font-size} breakpoint steps (phone → tablet → desktop → TV 1080p → 4K) that drive every rem-based role in the pack.",
    inputSchema: {},
  },
  async () => json({ steps: fluidSteps(src()) })
);

server.registerTool(
  "get_demo",
  {
    title: "Get demo info",
    description:
      "Paths, URL parameters (?theme= ?nosplash=1 ?noanim=1) and the theme cycle of the single-file demo.",
    inputSchema: {},
  },
  async () =>
    json({
      demo: DEMO,
      readme: join(HERE, "..", "README.md"),
      url: "https://github.com/mich-de/technical-minimal-web_2.0",
      cycle: THEMES,
      params: {
        "?theme=<key>": "deep-link a theme",
        "?nosplash=1": "skip the boot splash (print / screenshots)",
        "?noanim=1": "freeze all animations (print / screenshots)",
      },
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
