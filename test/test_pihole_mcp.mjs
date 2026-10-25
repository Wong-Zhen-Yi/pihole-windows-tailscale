import test from 'node:test';
import assert from 'node:assert/strict';
import { PiholeClient, runDocker } from '../pihole-mcp/client.mjs';
import { createTools, executeTool } from '../pihole-mcp/tools.mjs';

const labels = JSON.stringify({ 'com.docker.compose.project': 'pihole-windows', 'com.docker.compose.service': 'pihole' });
const tool = (api, name) => createTools(api).find(item => item.name === name);

test('reject invalid arguments and extra fields before invoking Docker', async () => {
  const api = { request() { assert.fail('Must not reach API'); } };
  for (const [name, args] of [
    ['set_blocking', { enabled: false, seconds: 0 }],
    ['set_blocking', { enabled: false, seconds: 3601 }],
    ['set_blocking', { enabled: false, seconds: 300, command: 'anything' }],
    ['add_domain', { type: 'deny', domain: '$(touch /tmp/injected)' }],
    ['add_domain', { type: 'deny', domain: '*.example.com' }],
    ['add_domain', { type: 'deny', domain: 'https://example.com' }],
    ['remove_domain', { type: 'deny', domain: 'example.com/path' }],
    ['remove_domain', { type: 'deny', domain: 'example.com?query' }],
    ['remove_domain', { type: 'deny', domain: 'example.com#fragment' }],
    ['remove_domain', { type: 'deny', domain: 'a%2eb.example' }],
    ['add_subscription', { address: 'file:///etc/passwd' }],
    ['add_subscription', { address: 'https://user:password@example.com/list' }],
    ['get_queries', { limit: 201 }],
    ['list_domains', { offset: -1 }]
  ]) assert.equal((await executeTool(tool(api, name), args)).isError, true, name);
});

test('timed pauses and enable payloads have correct scope and defaults', async () => {
  const calls = [];
  const api = { request: async (...args) => { calls.push(args); return {}; } };
  const control = tool(api, 'set_blocking');
  await executeTool(control, { enabled: false });
  await executeTool(control, { enabled: true });
  assert.deepEqual(calls, [
    ['POST', 'dns/blocking', { blocking: false, timer: 300 }],
    ['POST', 'dns/blocking', { blocking: true, timer: null }]
  ]);
  assert.equal(control.readOnly, false);
});

test('exact domain writes preserve groups and comments without interpolating commands', async () => {
  let captured;
  const api = { request: async (...args) => { captured = args; return {}; } };
  const result = await executeTool(tool(api, 'add_domain'), {
    type: 'allow', domain: 'EXAMPLE.COM', groups: [2], comment: 'A "quote"; $(literal)'
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, ['POST', 'domains/allow/exact', {
    domain: 'example.com', groups: [2], enabled: true, comment: 'A "quote"; $(literal)'
  }]);
});

test('subscription toggle preserves metadata and targets encoded URL and list type', async () => {
  const calls = [];
  const address = 'https://example.com/list?q=a&x=b';
  const api = { request: async (...args) => {
    calls.push(args);
    return { lists: [{ address, type: 'block', groups: [0, 2], comment: 'preserve' }] };
  } };
  await executeTool(tool(api, 'set_subscription_enabled'), { address, enabled: false });
  assert.equal(calls[0][1], `lists/${encodeURIComponent(address)}?type=block`);
  assert.deepEqual(calls[1], ['PUT', calls[0][1], { enabled: false, groups: [0, 2], comment: 'preserve' }]);
});

test('query output is bounded, filtered and omits client identity by default', async () => {
  let path;
  const api = { request: async (method, value) => {
    path = value;
    return { queries: [{ domain: 'example.com', client: { ip: '192.0.2.1' }, upstream: '192.0.2.2' }, { domain: 'second.example' }] };
  } };
  const result = await executeTool(tool(api, 'get_queries'), { limit: 1, offset: 2, domain: 'example.com' });
  assert.equal(path, 'queries?length=1&start=2&domain=example.com');
  assert.deepEqual(JSON.parse(result.content[0].text).queries, [{ domain: 'example.com' }]);
  const explicit = await executeTool(tool(api, 'get_queries'), { include_clients: true });
  assert.equal(JSON.parse(explicit.content[0].text).queries[0].client.ip, '192.0.2.1');
});

test('collections paginate and exact removal cannot become a bulk deletion', async () => {
  const calls = [];
  const api = { request: async (...args) => { calls.push(args); return { domains: [1, 2, 3] }; } };
  const result = await executeTool(tool(api, 'list_domains'), { limit: 1, offset: 1 });
  assert.deepEqual(JSON.parse(result.content[0].text), { domains: [2], total: 3, next_offset: 2 });
  await executeTool(tool(api, 'remove_domain'), { type: 'deny', domain: 'example.com' });
  assert.deepEqual(calls[1], ['DELETE', 'domains/deny/exact/example.com']);
});

test('Docker transport validates labels, uses argument arrays, and keeps credentials inside container', async () => {
  const calls = [];
  const api = new PiholeClient({ runner: async (args, options) => {
    calls.push({ args, options });
    return args[0] === 'inspect' ? labels : '{"blocking":"enabled"}\n200';
  } });
  assert.deepEqual(await api.request('GET', 'dns/blocking'), { blocking: 'enabled' });
  assert.deepEqual(calls[1].args.slice(0, 8), ['exec', '-i', 'pihole-windows-pihole-1', 'sh', '-s', '--', 'GET', 'dns/blocking']);
  assert.match(calls[1].options.input, /--rawfile password \/etc\/pihole\/cli_pw/);
  assert.match(calls[1].options.input, /trap cleanup EXIT/);
  assert.match(calls[1].options.input, /127\.0\.0\.1/);
  assert.ok(!calls[1].args.join(' ').includes('password'));
  const wrong = new PiholeClient({ runner: async () => '{}' });
  await assert.rejects(wrong.request('GET', 'dns/blocking'), /outside Compose project/);
  assert.throws(() => new PiholeClient({ container: '-other' }), /Invalid container/);
  assert.throws(() => new PiholeClient({ port: '80;whoami' }), /Invalid API port/);
});

test('API errors, malformed JSON and partial writes are errors and are never retried', async () => {
  for (const response of ['denied\n403', 'not json\n200', '{}', '{"processed":{"errors":[{"error":"duplicate"}]}}\n201']) {
    let writes = 0;
    const api = new PiholeClient({ runner: async args => {
      if (args[0] === 'inspect') return labels;
      writes++;
      return response;
    } });
    await assert.rejects(api.request('POST', 'domains/deny/exact', { domain: 'example.com' }));
    assert.equal(writes, 1);
  }
});

test('unsupported endpoints never reach Docker; DELETE 204 and gravity text work', async () => {
  const api = new PiholeClient({ runner: async args => args[0] === 'inspect' ? labels : '\n204' });
  await assert.rejects(api.request('POST', 'config/dns'), /Unsupported/);
  await assert.rejects(api.request('GET', '../auth'), /Unsupported/);
  assert.deepEqual(await api.request('DELETE', 'domains/deny/exact/example.com'), { success: true });
  const textApi = new PiholeClient({ runner: async args => args[0] === 'inspect' ? labels : 'x'.repeat(13000) + '\n200' });
  const result = await textApi.request('POST', 'action/gravity', undefined, { text: true });
  assert.equal(result.output.length, 12000);
  assert.equal(result.truncated, true);
});

test('requests serialize and recover after a failed request', async () => {
  let active = 0;
  let peak = 0;
  let attempts = 0;
  const api = new PiholeClient({ runner: async args => {
    if (args[0] === 'inspect') return labels;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return ++attempts === 1 ? '{}\n500' : '{}\n200';
  } });
  const results = await Promise.allSettled([api.request('GET', 'dns/blocking'), api.request('GET', 'stats/summary')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(peak, 1);
});

test('process failures do not expose Docker stderr or invocation details', async () => {
  await assert.rejects(runDocker(['definitely-not-a-docker-subcommand']), error =>
    /Docker request failed/.test(error.message) && !error.message.includes('definitely-not'));
});
