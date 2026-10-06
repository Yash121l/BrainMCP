// The app directory behind one-click connect. FEATURED is hand-checked: every URL
// answered an MCP request on 2026-10-06 (74 apps; sign-in re-checked the same day), and `auth` says how it signs in:
//   oauth  - one click: BrainMCP registers itself and sends you to the provider
//   token  - paste an API token (token_help says where to make one)
//   app    - the provider needs an OAuth app you register with them (client id/secret)
//   none   - public, no sign-in
//   restricted - the provider lets only its approved apps (Claude, Cursor, ...) sign in
//            to its MCP server; shown with a note instead of a Connect button
// scripts/check-catalog.mjs re-runs the real registration and sign-in check.
// Anything else comes from the official MCP Registry, searched live.

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

const app = (id, name, category, url, auth, description, extra = {}) => ({ id, name, category, url, auth, description, ...extra });

export const FEATURED = [
  app('figma', 'Figma', 'Design', 'https://mcp.figma.com/mcp', 'restricted', 'Read designs, frames, components and variables.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet. Instead, turn on the Dev Mode MCP server in the Figma desktop app and add it as a local server through the bridge: command npx, args -y mcp-remote http://127.0.0.1:3845/mcp.',
  }),
  app('canva', 'Canva', 'Design', 'https://mcp.canva.com/mcp', 'restricted', 'Find, create and export Canva designs.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('miro', 'Miro', 'Design', 'https://mcp.miro.com/', 'oauth', 'Read and edit Miro boards.'),
  app('gamma', 'Gamma', 'Design', 'https://mcp.gamma.app/mcp', 'restricted', 'Generate decks and documents.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('linear', 'Linear', 'Work', 'https://mcp.linear.app/mcp', 'oauth', 'Issues, projects, cycles and comments.'),
  app('notion', 'Notion', 'Work', 'https://mcp.notion.com/mcp', 'oauth', 'Search and edit pages and databases.'),
  app('atlassian', 'Jira & Confluence', 'Work', 'https://mcp.atlassian.com/v1/mcp', 'oauth', 'Jira issues and Confluence pages.'),
  app('monday', 'monday.com', 'Work', 'https://mcp.monday.com/mcp', 'restricted', 'Boards, items and updates.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('airtable', 'Airtable', 'Work', 'https://mcp.airtable.com/mcp', 'oauth', 'Bases, tables and records.'),
  app('granola', 'Granola', 'Meetings', 'https://mcp.granola.ai/mcp', 'oauth', 'Meeting notes and transcripts.'),
  app('fireflies', 'Fireflies', 'Meetings', 'https://api.fireflies.ai/mcp', 'oauth', 'Call transcripts and summaries.'),
  app('calendly', 'Calendly', 'Meetings', 'https://mcp.calendly.com', 'oauth', 'Event types and bookings.'),
  app('attio', 'Attio', 'Sales', 'https://mcp.attio.com/mcp', 'oauth', 'CRM records, lists and notes.'),
  app('intercom', 'Intercom', 'Sales', 'https://mcp.intercom.com/mcp', 'restricted', 'Conversations and contacts.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('stripe', 'Stripe', 'Finance', 'https://mcp.stripe.com', 'oauth', 'Customers, payments and invoices.'),
  app('paypal', 'PayPal', 'Finance', 'https://mcp.paypal.com/mcp', 'oauth', 'Orders, invoices and disputes.'),
  app('square', 'Square', 'Finance', 'https://mcp.squareup.com/mcp', 'restricted', 'Payments, catalog and customers.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('ramp', 'Ramp', 'Finance', 'https://mcp.ramp.com/mcp', 'oauth', 'Cards, spend and reimbursements.'),
  app('mercury', 'Mercury', 'Finance', 'https://mcp.mercury.com/mcp', 'oauth', 'Bank accounts and transactions.'),
  app('github', 'GitHub', 'Engineering', 'https://api.githubcopilot.com/mcp/', 'token', 'Repositories, issues and pull requests.', {
    token_help: 'Create a fine-grained personal access token at github.com/settings/personal-access-tokens and paste it here.',
    token_url: 'https://github.com/settings/personal-access-tokens/new',
  }),
  app('gitlab', 'GitLab', 'Engineering', 'https://gitlab.com/api/v4/mcp', 'oauth', 'Projects, issues and merge requests.'),
  app('sentry', 'Sentry', 'Engineering', 'https://mcp.sentry.dev/mcp', 'oauth', 'Issues, events and releases.'),
  app('vercel', 'Vercel', 'Engineering', 'https://mcp.vercel.com', 'restricted', 'Projects, deployments and logs.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('netlify', 'Netlify', 'Engineering', 'https://netlify-mcp.netlify.app/mcp', 'oauth', 'Sites, deploys and forms.'),
  app('supabase', 'Supabase', 'Engineering', 'https://mcp.supabase.com/mcp', 'oauth', 'Projects, tables and SQL.'),
  app('neon', 'Neon', 'Engineering', 'https://mcp.neon.tech/mcp', 'oauth', 'Postgres projects and branches.'),
  app('prisma', 'Prisma Postgres', 'Engineering', 'https://mcp.prisma.io/mcp', 'oauth', 'Databases and migrations.'),
  app('posthog', 'PostHog', 'Engineering', 'https://mcp.posthog.com/mcp', 'oauth', 'Product analytics and feature flags.'),
  app('semgrep', 'Semgrep', 'Engineering', 'https://mcp.semgrep.ai/mcp', 'oauth', 'Code scanning findings.'),
  app('jam', 'Jam', 'Engineering', 'https://mcp.jam.dev/mcp', 'oauth', 'Bug reports with replays.'),
  app('dropbox', 'Dropbox', 'Files', 'https://mcp.dropbox.com/mcp', 'app', 'Files and folders.', {
    token_help: 'Dropbox does not let apps register themselves: create an app at dropbox.com/developers (scoped access), add the redirect URL shown below, then paste its app key and secret.',
    token_url: 'https://www.dropbox.com/developers/apps',
  }),
  app('zapier', 'Zapier', 'Automation', 'https://mcp.zapier.com/api/mcp/mcp', 'oauth', 'Run the actions you set up in Zapier.'),
  app('apify', 'Apify', 'Automation', 'https://mcp.apify.com', 'oauth', 'Run scrapers and actors.'),
  app('deepwiki', 'DeepWiki', 'Knowledge', 'https://mcp.deepwiki.com/mcp', 'none', 'Docs for any public GitHub repository.'),
  app('context7', 'Context7', 'Knowledge', 'https://mcp.context7.com/mcp', 'none', 'Up-to-date library documentation.'),
  app('cloudflare-docs', 'Cloudflare Docs', 'Knowledge', 'https://docs.mcp.cloudflare.com/mcp', 'none', 'Search Cloudflare documentation.'),
  app('huggingface', 'Hugging Face', 'Knowledge', 'https://huggingface.co/mcp', 'none', 'Models, datasets and Spaces.'),
  app('exa', 'Exa', 'Knowledge', 'https://mcp.exa.ai/mcp', 'none', 'Web search for agents.'),
  app('todoist', 'Todoist', 'Work', 'https://ai.todoist.net/mcp', 'oauth', 'Tasks, projects and due dates.'),
  app('clickup', 'ClickUp', 'Work', 'https://mcp.clickup.com/mcp', 'oauth', 'Tasks, docs and spaces.'),
  app('coda', 'Coda', 'Work', 'https://coda.io/apis/mcp', 'oauth', 'Docs, tables and formulas.'),
  app('cal', 'Cal.com', 'Meetings', 'https://mcp.cal.com/mcp', 'restricted', 'Bookings and availability.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('affinity', 'Affinity', 'Sales', 'https://mcp.affinity.co/mcp', 'app', 'Relationship CRM: people, companies, deals.', {
    token_help: 'Affinity accepts registered OAuth apps only: ask your Affinity admin for an MCP OAuth client, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://support.affinity.co/',
  }),
  app('plain', 'Plain', 'Sales', 'https://mcp.plain.com/mcp', 'oauth', 'Support threads and customers.'),
  app('klaviyo', 'Klaviyo', 'Marketing', 'https://mcp.klaviyo.com/mcp', 'oauth', 'Campaigns, flows and audiences.'),
  app('ahrefs', 'Ahrefs', 'Marketing', 'https://api.ahrefs.com/mcp/mcp', 'oauth', 'SEO keywords, backlinks and rankings.'),
  app('similarweb', 'Similarweb', 'Marketing', 'https://mcp.similarweb.com/mcp', 'oauth', 'Website traffic and market intelligence.'),
  app('wix', 'Wix', 'Marketing', 'https://mcp.wix.com/mcp', 'oauth', 'Sites, stores and bookings.'),
  app('sanity', 'Sanity', 'Marketing', 'https://mcp.sanity.io', 'oauth', 'Structured content and documents.'),
  app('pitchbook', 'PitchBook', 'Research', 'https://mcp.pitchbook.com/mcp', 'restricted', 'Companies, deals and investors.', {
    note: 'The provider lets only approved apps (such as Claude, Cursor and VS Code) sign in to its MCP server, and BrainMCP is not on that list yet.',
  }),
  app('crunchbase', 'Crunchbase', 'Research', 'https://mcp.crunchbase.com/mcp', 'app', 'Company and funding data.', {
    token_help: 'Crunchbase accepts registered OAuth apps only: create one in the Crunchbase data platform, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://data.crunchbase.com/',
  }),
  app('standardmetrics', 'Standard Metrics', 'Finance', 'https://mcp.standardmetrics.io/mcp', 'oauth', 'Portfolio company metrics and reporting.'),
  app('xero', 'Xero', 'Finance', 'https://mcp.xero.com/mcp', 'app', 'Invoices, contacts and accounts.', {
    token_help: 'Create an app at developer.xero.com, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://developer.xero.com/app/manage',
  }),
  app('motherduck', 'MotherDuck', 'Data', 'https://api.motherduck.com/mcp', 'oauth', 'Query DuckDB databases in the cloud.'),
  app('hex', 'Hex', 'Data', 'https://app.hex.tech/mcp', 'oauth', 'Notebooks, projects and data apps.'),
  app('mixpanel', 'Mixpanel', 'Data', 'https://mcp.mixpanel.com/mcp', 'oauth', 'Events, funnels and retention.'),
  app('amplitude', 'Amplitude', 'Data', 'https://mcp.amplitude.com/mcp', 'oauth', 'Product analytics and charts.'),
  app('axiom', 'Axiom', 'Data', 'https://mcp.axiom.co/mcp', 'oauth', 'Logs and event queries.'),
  app('grafana', 'Grafana Cloud', 'Engineering', 'https://mcp.grafana.com/mcp', 'oauth', 'Dashboards, alerts and metrics.'),
  app('pagerduty', 'PagerDuty', 'Engineering', 'https://mcp.pagerduty.com/mcp', 'app', 'Incidents, schedules and on-call.', {
    token_help: 'Register an OAuth app in PagerDuty (Integrations → App Registration), add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://developer.pagerduty.com/',
  }),
  app('buildkite', 'Buildkite', 'Engineering', 'https://mcp.buildkite.com/mcp', 'oauth', 'Pipelines, builds and jobs.'),
  app('heroku', 'Heroku', 'Engineering', 'https://mcp.heroku.com/mcp', 'oauth', 'Apps, dynos and add-ons.'),
  app('render', 'Render', 'Engineering', 'https://mcp.render.com/mcp', 'app', 'Services, deploys and logs.', {
    token_help: 'Render accepts registered OAuth apps only: create one in the Render dashboard, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://dashboard.render.com/',
  }),
  app('postman', 'Postman', 'Engineering', 'https://mcp.postman.com/mcp', 'oauth', 'Collections, requests and APIs.'),
  app('cloudflare', 'Cloudflare', 'Engineering', 'https://bindings.mcp.cloudflare.com/mcp', 'oauth', 'Workers, KV, R2 and D1 in your account.'),
  app('cloudflare-observability', 'Cloudflare Observability', 'Engineering', 'https://observability.mcp.cloudflare.com/mcp', 'oauth', 'Worker logs and analytics.'),
  app('cloudflare-radar', 'Cloudflare Radar', 'Research', 'https://radar.mcp.cloudflare.com/mcp', 'oauth', 'Internet traffic and trends.'),
  app('tavily', 'Tavily', 'Knowledge', 'https://mcp.tavily.com/mcp/', 'oauth', 'Web search and extraction.'),
  app('firecrawl', 'Firecrawl', 'Knowledge', 'https://mcp.firecrawl.dev/mcp', 'none', 'Scrape and crawl websites.'),
  app('browserbase', 'Browserbase', 'Automation', 'https://mcp.browserbase.com/mcp', 'none', 'Cloud browsers for agents.'),
  app('slack', 'Slack', 'Chat', 'https://mcp.slack.com/mcp', 'app', 'Channels, messages and search.', {
    token_help: 'Slack only allows registered apps: create one at api.slack.com/apps, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://api.slack.com/apps',
  }),
  app('hubspot', 'HubSpot', 'Sales', 'https://mcp.hubspot.com/', 'app', 'Contacts, companies and deals.', {
    token_help: 'Create a HubSpot MCP auth app (Development → MCP Auth Apps), add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://developers.hubspot.com/',
  }),
  app('asana', 'Asana', 'Work', 'https://mcp.asana.com/v2/mcp', 'app', 'Tasks, projects and portfolios.', {
    token_help: 'Register an app in the Asana developer console, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://app.asana.com/0/my-apps',
  }),
  app('box', 'Box', 'Files', 'https://mcp.box.com', 'app', 'Files, folders and Box AI.', {
    token_help: 'Create a Box platform app with OAuth 2.0, add the redirect URL shown below, then paste its client id and secret.',
    token_url: 'https://app.box.com/developers/console',
  }),
];

export const featuredById = (id) => FEATURED.find((a) => a.id === id) || null;

const cache = new Map();

/** Search the official MCP Registry for remote (streamable HTTP) servers. */
export async function searchRegistry(query, limit = 20) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const hit = cache.get(q);
  if (hit && hit.at > Date.now() - 10 * 60000) return hit.items;
  const url = `${REGISTRY}?search=${encodeURIComponent(q)}&limit=${Math.min(50, limit * 2)}`;
  let body;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    body = res.ok ? await res.json() : null;
  } catch {
    body = null;
  }
  const items = [];
  const seen = new Set();
  for (const entry of body?.servers || []) {
    const s = entry.server || entry;
    const remote = (s.remotes || []).find((r) => r.type === 'streamable-http' && /^https:\/\//.test(r.url || ''));
    if (!remote || seen.has(remote.url) || /\{[^}]+\}/.test(remote.url)) continue;
    seen.add(remote.url);
    const headers = (remote.headers || []).filter((h) => h?.name);
    const secretHeader = headers.find((h) => h.isSecret || /authorization|key|token/i.test(h.name));
    items.push({
      id: `registry:${s.name}`,
      name: s.title || String(s.name).split('/').pop(),
      registry_name: s.name,
      category: 'From the MCP Registry',
      url: remote.url,
      auth: secretHeader ? 'token' : 'detect',
      header_name: secretHeader && !/^authorization$/i.test(secretHeader.name) ? secretHeader.name : null,
      description: String(s.description || '').slice(0, 200),
      repository: s.repository?.url || null,
      verified: false,
    });
    if (items.length >= limit) break;
  }
  cache.set(q, { at: Date.now(), items });
  return items;
}
