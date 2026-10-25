const path = require('node:path');

(async () => {
  const { packager } = await import('@electron/packager');
  const builds = await packager({
    dir: __dirname, name: 'Pi-hole Desktop', executableName: 'Pi-hole Desktop',
    platform: 'win32', arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    out: path.join(__dirname, 'dist'), asar: true, overwrite: true,
    icon: path.join(__dirname, 'icon.ico'),
    electronVersion: require('./package.json').devDependencies.electron,
    // Explicit allowlist prevents private checkout data or dependencies entering the app.
    ignore: file => !!file && !/^\/(?:package\.json|main\.cjs|preload\.cjs|backend\.cjs|settings\.cjs|index\.html|renderer\.js|styles\.css|icon\.png)$/.test(file.replaceAll('\\', '/')),
    win32metadata: { CompanyName: 'Pi-hole Windows community fork', FileDescription: 'Pi-hole Desktop', ProductName: 'Pi-hole Desktop' }
  });
  console.log(`Built ${builds.join(', ')}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
