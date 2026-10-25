import { domainToASCII } from 'node:url';
import { z } from 'zod';

const limit = z.number().int().min(1).max(200).default(50);
const offset = z.number().int().min(0).max(1000000).default(0);
const type = z.enum(['allow', 'deny']);
const kind = z.enum(['exact', 'regex']);
const comment = z.string().max(512).default('');
const groups = z.array(z.number().int().min(0)).min(1).max(64).default([0]);
const domain = z.string().min(1).max(253)
  .refine(value => !/[\/\\?#%@:\s\[\]]/.test(value), 'Use a DNS name without URL syntax.')
  .transform(value => domainToASCII(value).toLowerCase())
  .refine(value => value.length > 0 && value.length <= 253 && value.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), 'Use an exact DNS name without a URL or wildcard.');
const address = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, 'Use an HTTP(S) list URL without credentials or fragments.');

function page(data, key, start, size) {
  const items = data[key];
  if (!Array.isArray(items)) throw new Error('Unexpected Pi-hole collection response.');
  return { [key]: items.slice(start, start + size), total: items.length,
    next_offset: start + size < items.length ? start + size : null };
}

export function createTools(api) {
  const read = (name, description, shape, execute) => ({ name, description,
    schema: z.object(shape).strict(), readOnly: true, execute });
  const write = (name, description, shape, execute) => ({ name, description,
    schema: z.object(shape).strict(), readOnly: false, execute });
  return [
    read('get_status', 'Read Pi-hole blocking status, aggregate query statistics and installed versions.', {}, async () => ({
      blocking: await api.request('GET', 'dns/blocking'),
      summary: await api.request('GET', 'stats/summary'),
      version: await api.request('GET', 'info/version')
    })),
    read('get_queries', 'Inspect recent DNS queries. Browsing data is private. Client identity is omitted unless include_clients=true; never commit results.',
      { limit, offset, domain: domain.optional(), include_clients: z.boolean().default(false) }, async args => {
        const params = new URLSearchParams({ length: String(args.limit), start: String(args.offset) });
        if (args.domain) params.set('domain', args.domain);
        const data = await api.request('GET', `queries?${params}`);
        if (!Array.isArray(data.queries)) throw new Error('Unexpected Pi-hole queries response.');
        return { ...data, queries: data.queries.slice(0, args.limit).map(query => {
          const { client, upstream, ...rest } = query;
          return args.include_clients ? query : rest;
        }) };
      }),
    read('get_top_domains', 'Read the most queried or blocked domains; this exposes private browsing data.',
      { limit, blocked: z.boolean().default(true) }, args => api.request('GET',
        `stats/top_domains?${new URLSearchParams({ count: String(args.limit), blocked: String(args.blocked) })}`)),
    read('list_domains', 'Read allow/deny domain rules with pagination. Regex rules are readable; mutations support exact DNS names.',
      { type: type.optional(), kind: kind.optional(), domain: domain.optional(), limit, offset }, async args => {
        const path = ['domains', args.type, args.kind, args.domain].filter(Boolean).map(encodeURIComponent).join('/');
        return page(await api.request('GET', path), 'domains', args.offset, args.limit);
      }),
    write('add_domain', 'Add one exact allow/deny domain rule. Affects clients in the selected group IDs (default group 0). Inspect existing rules first.',
      { type, domain, comment, groups }, args => api.request('POST', `domains/${args.type}/exact`, {
        domain: args.domain, comment: args.comment, groups: args.groups, enabled: true
      })),
    write('remove_domain', 'Delete one exact allow/deny domain rule. Read the rule and its groups first; affects DNS filtering immediately.',
      { type, domain }, args => api.request('DELETE', `domains/${args.type}/exact/${encodeURIComponent(args.domain)}`)),
    read('list_subscriptions', 'Read blocklist and allowlist subscriptions with pagination.',
      { limit, offset }, async args => page(await api.request('GET', 'lists'), 'lists', args.offset, args.limit)),
    write('add_subscription', 'Add a blocklist/allowlist URL. Pi-hole will download it during the next gravity refresh. Only add a source the user trusts.',
      { address, type: z.enum(['block', 'allow']).default('block'), comment, groups }, args =>
        api.request('POST', `lists?type=${args.type}`, { address: args.address, comment: args.comment, groups: args.groups, enabled: true })),
    write('set_subscription_enabled', 'Enable or disable an existing subscription, preserving its comment and groups. Refresh gravity afterwards to rebuild downloaded lists.',
      { address, type: z.enum(['block', 'allow']).default('block'), enabled: z.boolean() }, async args => {
        const path = `lists/${encodeURIComponent(args.address)}?type=${args.type}`;
        const data = await api.request('GET', path);
        const item = data.lists?.find(list => list.address === args.address && list.type === args.type);
        if (!item) throw new Error('Subscription not found.');
        return api.request('PUT', path, { enabled: args.enabled, comment: item.comment, groups: item.groups });
      }),
    write('remove_subscription', 'Delete a blocklist/allowlist subscription. Read it first. Refresh gravity afterwards to rebuild downloaded lists.',
      { address, type: z.enum(['block', 'allow']).default('block') }, args =>
        api.request('DELETE', `lists/${encodeURIComponent(args.address)}?type=${args.type}`)),
    read('list_groups', 'Read group IDs, names and enabled status before assigning domain rules or subscriptions.',
      { limit, offset }, async args => page(await api.request('GET', 'groups'), 'groups', args.offset, args.limit)),
    write('set_blocking', 'Enable blocking or pause it temporarily for ALL clients using this Pi-hole. Pauses automatically end; default 300 seconds, maximum 3600.',
      { enabled: z.boolean(), seconds: z.number().int().min(1).max(3600).default(300) }, args =>
        api.request('POST', 'dns/blocking', { blocking: args.enabled, timer: args.enabled ? null : args.seconds })),
    write('refresh_gravity', 'Download subscribed lists and rebuild gravity for all Pi-hole clients. May take two minutes. Review output for failed downloads even on HTTP success. On timeout, check the dashboard before retrying; the operation may still finish.',
      {}, () => api.request('POST', 'action/gravity', undefined, { text: true, deadline: 120 }))
  ];
}

export async function executeTool(tool, args) {
  try {
    const result = await tool.execute(tool.schema.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof z.ZodError
      ? 'Invalid arguments. Check the tool schema; no operation was performed.' : error.message }] };
  }
}
