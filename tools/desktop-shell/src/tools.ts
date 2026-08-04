import { app } from 'electron';

export interface ToolConfig {
  id: string;
  label: string;
  /** Local `npm run dev` address for this tool's Vite dev server. */
  devUrl: string;
  /** Production hosting address (Cloudflare Workers, see wrangler/<tool>.jsonc + .github/workflows/<tool>-deploy.yml). */
  prodUrl: string;
}

export const TOOLS: ToolConfig[] = [
  { id: 'animator', label: 'Animator', devUrl: 'http://localhost:5176', prodUrl: 'https://dd-animator.gamestao.com' },
  { id: 'map-editor', label: 'Map Editor', devUrl: 'http://localhost:5175', prodUrl: 'https://dd-map.gamestao.com' },
];

export const DEFAULT_TOOL_ID = TOOLS[0].id;

/** A packaged install connects to the production hosting address; running `electron .` against source connects to the local dev server. */
export function resolveToolUrl(tool: ToolConfig): string {
  return app.isPackaged ? tool.prodUrl : tool.devUrl;
}
