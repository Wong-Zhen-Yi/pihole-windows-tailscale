/* global pihole */
const $ = id => document.getElementById(id);
let current;
let pending = false;
let view = 'overview';
const descriptions = {
  overview: ['Pi-hole overview', 'A home for your local DNS controls.'],
  settings: ['Make it yours', 'Startup and deployment preferences for this PC.'],
  activity: ['Desktop activity', 'A clear view of what this app has done.']
};

function navigate(next) {
  view = next;
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== next;
  for (const button of document.querySelectorAll('.nav')) {
    button.classList.toggle('active', button.dataset.view === next);
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('crumb').textContent = next.toUpperCase();
  $('page-title').textContent = descriptions[next][0];
  $('page-description').textContent = descriptions[next][1];
}

function activityList(element, entries) {
  element.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = 'Your desktop activity will appear here.'; element.append(empty); return;
  }
  for (const entry of entries) {
    const row = document.createElement('div'); row.className = 'activity-row';
    const dot = document.createElement('span'); dot.className = 'activity-dot';
    const message = document.createElement('span'); message.textContent = entry.message;
    const time = document.createElement('time'); time.dateTime = entry.time;
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.append(dot, message, time); element.append(row);
  }
}

function render(state) {
  current = state;
  const busy = pending || state.operating;
  const { phase, deployment } = state;
  const running = phase === 'running';
  const labels = {
    checking: ['Checking', 'Getting things ready', 'Checking Docker Desktop and your Pi-hole container…'],
    running: ['Running', 'Pi-hole is running', 'Your container is online. Open the dashboard to check filtering and query activity.'],
    stopped: ['Stopped', 'A quiet moment', 'Pi-hole is stopped. Start it to resume DNS service for connected devices.'],
    missing: ['Not set up', 'Ready for your first launch', 'Choose your deployment preferences, then start Pi-hole using the Windows launcher.'],
    offline: ['Docker offline', 'Let’s get connected', 'Start Pi-hole to open Docker Desktop and wait for its Linux engine.'],
    error: ['Needs attention', 'A little attention needed', state.message || 'Check Docker Desktop and the setup guide.']
  };
  const text = labels[phase] || labels.error;
  $('status-badge').textContent = busy ? 'Working…' : text[0];
  $('status-badge').className = `badge ${running ? 'green' : phase === 'error' ? 'red' : ''}`;
  $('service-title').textContent = busy ? 'Working on it…' : text[1];
  $('service-description').textContent = busy ? (state.activity[0]?.message || 'Please wait for the operation to finish.') : text[2];
  $('status-dot').classList.toggle('online', running);
  $('service-detail').textContent = running ? 'Container running · verify DNS from your clients' : 'Settings and databases stay in the Pi-hole data volume';
  $('start').disabled = busy || running || phase === 'checking';
  $('stop').disabled = busy || !running;
  $('dashboard').disabled = busy || !running || !deployment?.dashboardUrl;
  $('refresh').disabled = busy;
  $('engine-value').textContent = state.engine ? 'Connected' : phase === 'checking' ? 'Checking…' : 'Unavailable';
  $('mode-value').textContent = (deployment?.mode || state.settings.mode) === 'Tailscale' ? 'Tailscale' : 'Local / LAN';
  $('mode-detail').textContent = deployment ? 'Detected from the existing container' : 'Preference for a new container';
  $('health-value').textContent = !deployment ? '—' : deployment.health === 'healthy' ? 'Healthy' : deployment.health === 'starting' ? 'Starting…' : deployment.health === 'unhealthy' ? 'Unhealthy' : 'Not reported';
  $('launch-startup').checked = state.startup.enabled;
  $('startup-detail').textContent = state.startup.enabled && !state.startup.active ? 'Windows has disabled this startup entry. Enable it in Settings > Apps > Startup.' : 'This applies after you sign in, not before Windows login.';
  $('auto-start').checked = state.settings.autoStart;
  $('mode').value = state.settings.mode;
  $('repository-path').textContent = state.settings.repository || 'No folder selected. Choose the repository before creating a container.';
  $('startup-summary').textContent = state.startup.enabled ? (state.startup.active ? 'Launch at sign-in is on.' : 'Startup is registered, but disabled in Windows.') + (state.settings.autoStart ? ' Pi-hole will also start when the app opens.' : ' Pi-hole auto-start is off.') : 'Launch at sign-in is off. Set up your preferred startup behavior.';
  for (const id of ['launch-startup', 'auto-start', 'mode', 'choose-repository']) $(id).disabled = busy;
  activityList($('recent-activity'), state.activity.slice(0, 3));
  activityList($('full-activity'), state.activity);
}

async function request(callback, success) {
  if (pending) return;
  pending = true;
  $('notice').hidden = true;
  if (current) render(current);
  try {
    const result = await callback();
    if (!result.ok) throw new Error(result.error);
    if (result.data?.settings) current = result.data;
    if (success) { $('notice').textContent = success; $('notice').hidden = false; }
  } catch (error) {
    $('notice').textContent = error.message; $('notice').hidden = false;
  } finally {
    pending = false;
    if (current) render(current);
  }
}

for (const button of document.querySelectorAll('.nav')) button.addEventListener('click', () => navigate(button.dataset.view));
$('startup-settings').addEventListener('click', () => navigate('settings'));
$('all-activity').addEventListener('click', () => navigate('activity'));
$('refresh').addEventListener('click', () => request(() => pihole.getState()));
$('start').addEventListener('click', () => request(() => pihole.start()));
$('stop').addEventListener('click', () => request(() => pihole.stop()));
$('dashboard').addEventListener('click', () => request(() => pihole.openDashboard()));
$('choose-repository').addEventListener('click', () => request(() => pihole.chooseRepository()));
$('guide').addEventListener('click', () => request(() => pihole.openGuide()));
$('quit').addEventListener('click', () => pihole.quit());
$('launch-startup').addEventListener('change', event => {
  const enabled = event.target.checked;
  request(() => pihole.setStartup(enabled));
});
for (const id of ['auto-start', 'mode']) $(id).addEventListener('change', () => {
  const next = { autoStart: $('auto-start').checked, mode: $('mode').value };
  request(() => pihole.saveSettings(next), 'Preferences saved. They apply the next time this app starts Pi-hole.');
});
pihole.onState(state => render(state));
request(() => pihole.getState());
