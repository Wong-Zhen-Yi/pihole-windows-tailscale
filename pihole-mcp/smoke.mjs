// Read-only end-to-end MCP handshake and live API check; do not print query data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'pihole-smoke', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'pipe' }));
  const { tools } = await client.listTools();
  if (tools.length !== 13) throw new Error('Expected 13 tools.');
  const result = await client.callTool({ name: 'get_status', arguments: {} });
  if (result.isError) throw new Error(result.content[0].text);
  const status = JSON.parse(result.content[0].text);
  if (!status.summary.queries || !status.version.version || !status.blocking.blocking) throw new Error('Invalid live status.');
  for (const [name, args] of [
    ['list_domains', { limit: 1 }], ['list_subscriptions', { limit: 1 }],
    ['list_groups', { limit: 1 }], ['get_top_domains', { limit: 1 }],
    ['get_queries', { limit: 1, domain: 'example.invalid' }]
  ]) {
    const read = await client.callTool({ name, arguments: args });
    if (read.isError) throw new Error(`${name}: ${read.content[0].text}`);
  }
  const rejected = await client.callTool({ name: 'set_blocking', arguments: { enabled: false, seconds: 0 } });
  if (!rejected.isError) throw new Error('Invalid write was not rejected.');
  console.log(`MCP handshake passed; ${tools.length} tools discovered; live blocking=${status.blocking.blocking}; all read tools passed; invalid write rejected. No private records printed.`);
} finally {
  await client.close();
}
