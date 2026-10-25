import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('./bridge.sh', import.meta.url), 'utf8');

export function runDocker(args, { input, timeout = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // execFile errors include arguments/stdout/stderr. Never forward those.
        if (error) reject(new Error('Docker request failed or timed out. Check Docker Desktop, the Pi-hole container and CLI authentication. A timed-out write may still finish; inspect state before retrying.'));
        else resolve(stdout);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class PiholeClient {
  constructor({ container = process.env.PIHOLE_MCP_CONTAINER || 'pihole-windows-pihole-1',
    port = process.env.PIHOLE_MCP_API_PORT || '80', runner = runDocker } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new Error('Invalid container name.');
    if (!/^\d+$/.test(String(port)) || +port < 1 || +port > 65535) throw new Error('Invalid API port.');
    this.container = container;
    this.port = String(port);
    this.runner = runner;
    this.queue = Promise.resolve();
  }

  request(method, path, body, { text = false, deadline = 20 } = {}) {
    // Serialize API sessions and writes. Do not automatically retry mutations.
    const result = this.queue.then(async () => {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) ||
          !/^(stats\/summary|stats\/top_domains\?[^\s]*|info\/version|dns\/blocking|queries\?[^\s]*|domains(?:\/[^\s?#]*)?|lists(?:\/[^\s?#]*)?(?:\?[^\s]*)?|groups|action\/gravity)$/.test(path)) {
        throw new Error('Unsupported Pi-hole API operation.');
      }
      const labels = JSON.parse(await this.runner(['inspect', '--format', '{{json .Config.Labels}}', this.container]));
      if (labels?.['com.docker.compose.project'] !== 'pihole-windows' || labels?.['com.docker.compose.service'] !== 'pihole') {
        throw new Error('Refusing a container outside Compose project pihole-windows, service pihole.');
      }
      const output = await this.runner(['exec', '-i', this.container, 'sh', '-s', '--', method, path,
        body === undefined ? '' : JSON.stringify(body), this.port, String(deadline)],
      { input: bridge, timeout: (deadline + 20) * 1000 });
      const match = /\n(\d{3})$/.exec(output);
      if (!match) throw new Error('Pi-hole returned an invalid HTTP response.');
      const status = Number(match[1]);
      if (status < 200 || status >= 300) throw new Error(`Pi-hole returned HTTP ${status}. Check the dashboard and requested item. No automatic retry was performed.`);
      const payload = output.slice(0, match.index);
      if (text) return { output: payload.slice(-12000), truncated: payload.length > 12000 };
      if (status === 204) return { success: true };
      let data;
      try { data = JSON.parse(payload); } catch { throw new Error('Expected Pi-hole v6 JSON response.'); }
      if (data.error || data.processed?.errors?.length) throw new Error('Pi-hole rejected all or part of the change. Read the item back before retrying.');
      return data;
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
