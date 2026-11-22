const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { exec, execFile, spawn } = require('child_process');

const store = new Store();

// Open a URL in the Windows browser (works from both native Windows and WSL)
function openUrl(url) {
  // Escape special chars for cmd.exe
  const safe = url.replace(/&/g, '^&');
  exec(`cmd.exe /c start "" "${safe}"`, (err) => {
    if (err) {
      // Fallback to Electron's built-in opener
      shell.openExternal(url);
    }
  });
}

// ─── Spotify OAuth Config ────────────────────────────────────────────────────
// Fill these in after creating your Spotify Developer App
// at https://developer.spotify.com/dashboard
const SPOTIFY_CLIENT_ID = store.get('clientId', '');
const SPOTIFY_CLIENT_SECRET = store.get('clientSecret', '');
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-library-modify',
  'user-library-read',
].join(' ');

// ─── Global State ────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let authServer = null;
let pollInterval = null;
let tokens = {
  access_token: store.get('access_token', null),
  refresh_token: store.get('refresh_token', null),
  expires_at: store.get('expires_at', 0),
};

// ─── App Lifecycle ───────────────────────────────────────────────────────────
// A second Windows launch must not crash on the profile lock. It asks the
// running player to show itself, which is what `npm start` does on restart.
const primaryInstance = process.platform !== 'win32' || app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  if (process.platform === 'win32') {
    app.on('second-instance', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow().catch((err) => console.error(err));
        return;
      }
      if (!mainWindow.isVisible()) mainWindow.show();
      dockWindow();
    });
  }

  app.whenReady().then(async () => {
    // WSLg windows are painted underneath the Windows taskbar and get shoved
    // back onto the desktop. Hand off to the native Windows runtime so the
    // widget can actually sit in the taskbar.
    if (isWsl()) {
      try {
        await handoffToWindowsElectron();
        app.exit(0);
      } catch (err) {
        console.error('Could not start the Windows player:', err.message);
        app.exit(1);
      }
      return;
    }

    await createWindow();
    createTray();
    startTrayWatch();

    screen.on('display-metrics-changed', () => dockWindow());
    screen.on('display-added', () => dockWindow());
    screen.on('display-removed', () => dockWindow());

    if (tokens.access_token) {
      startPolling();
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopPolling();
  stopTrayWatch();
  if (authServer) authServer.close();
});

// ─── Taskbar dock geometry ───────────────────────────────────────────────────
// Sit flush inside the taskbar, immediately left of the system tray
// (clock, battery, volume, wifi).
const WIDGET_W = 340;
const TRAY_GAP = 8;
let dockRect = null;
let correcting = false;
let userHidden = false;
let windowReady = false;
let restoring = false;
let trayWatch = null;
let pinBoostUntil = 0;

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function execText(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve(stdout.trim());
    });
  });
}

// A WSLg window cannot cover the Windows taskbar. Relaunch the same app
// with the native Windows Electron binary so the HWND can sit in the strip.
async function handoffToWindowsElectron() {
  const localAppData = await execText('cmd.exe', ['/c', 'echo %LOCALAPPDATA%']);
  const appData = await execText('cmd.exe', ['/c', 'echo %APPDATA%']);
  const destUnix = await execText('wslpath', ['-u', `${localAppData}\\spotify-taskbar-player\\electron`]);
  const exeUnix = path.posix.join(destUnix, 'electron.exe');
  if (!fs.existsSync(exeUnix)) {
    throw new Error(`Windows runtime not found at ${exeUnix}`);
  }

  const projectWin = await execText('wslpath', ['-w', path.resolve(__dirname, '..')]);
  const exeWin = await execText('wslpath', ['-w', exeUnix]);
  const userDataWin = `${appData}\\spotify-taskbar-player`;
  const userDataUnix = await execText('wslpath', ['-u', userDataWin]);
  fs.mkdirSync(userDataUnix, { recursive: true });

  // First launch on Windows: keep the Spotify login saved under Linux.
  const srcConfig = path.join(process.env.HOME || '', '.config', 'spotify-taskbar-player', 'config.json');
  const dstConfig = path.join(userDataUnix, 'config.json');
  if (fs.existsSync(srcConfig) && !fs.existsSync(dstConfig)) {
    fs.copyFileSync(srcConfig, dstConfig);
  }

  const dev = process.argv.includes('--dev') ? ' --dev' : '';
  const launcherUnix = path.posix.join(destUnix, 'launch-player.cmd');
  const logUnix = path.posix.join(destUnix, 'launch.log');
  const logWin = await execText('wslpath', ['-w', logUnix]);
  fs.writeFileSync(launcherUnix, [
    '@echo off',
    `echo starting %DATE% %TIME%> "${logWin}"`,
    `pushd "${projectWin}" >> "${logWin}" 2>&1`,
    'if errorlevel 1 exit /b 1',
    `"${exeWin}" . --user-data-dir="${userDataWin}"${dev} >> "${logWin}" 2>&1`,
    '',
  ].join('\r\n'));

  // Replace a player that is still running (including one left behind with no
  // window). A second copy otherwise exits immediately on the profile lock.
  await stopExistingPlayer();
  for (let i = 0; i < 25 && await playerIsRunning(); i++) {
    await sleep(200);
  }

  const launcherWin = await execText('wslpath', ['-w', launcherUnix]);
  // Hidden Start-Process survives this Linux process exiting, and cwd must be
  // a real drive — cmd refuses to start with the project UNC path.
  await execText('powershell.exe', ['-NoProfile', '-Command',
    `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','${launcherWin.replace(/'/g, "''")}' -WorkingDirectory 'C:\\Windows' -WindowStyle Hidden`,
  ]);

  for (let i = 0; i < 30; i++) {
    if (await playerIsRunning()) {
      console.log('Spotify Taskbar Player is running.');
      return;
    }
    await sleep(250);
  }

  let detail = '';
  try { detail = fs.readFileSync(logUnix, 'utf8').trim(); } catch { /* no log */ }
  throw new Error(detail || 'The Windows player exited during startup.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopExistingPlayer() {
  const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object { $_.CommandLine -like '*spotify-taskbar-player*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  try { await execText('powershell.exe', ['-NoProfile', '-Command', ps]); } catch { /* none running */ }
}

async function playerIsRunning() {
  const ps = `
@(
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -like '*spotify-taskbar-player*' -and $_.CommandLine -notlike '*--type=*' }
).Count
`;
  try {
    const n = await execText('powershell.exe', ['-NoProfile', '-Command', ps]);
    return Number(n) > 0;
  } catch {
    return false;
  }
}

function queryTaskbarRects() {
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DockGeom {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
'@
$t = [DockGeom]::FindWindow('Shell_TrayWnd', $null)
if ($t -eq [IntPtr]::Zero) { exit 1 }
$n = [DockGeom]::FindWindowEx($t, [IntPtr]::Zero, 'TrayNotifyWnd', $null)
$a = New-Object DockGeom+RECT
$b = New-Object DockGeom+RECT
[void][DockGeom]::GetWindowRect($t, [ref]$a)
if ($n -ne [IntPtr]::Zero) { [void][DockGeom]::GetWindowRect($n, [ref]$b) }
Write-Output ("{0},{1},{2},{3},{4},{5},{6},{7}" -f $a.L,$a.T,$a.R,$a.B,$b.L,$b.T,$b.R,$b.B)
`;
  return execText('powershell.exe', ['-NoProfile', '-Command', ps]).then((line) => {
    const [tl, tt, tr, tb, nl, nt, nr, nb] = line.split(',').map(Number);
    if ([tl, tt, tr, tb].some(n => Number.isNaN(n))) throw new Error('bad taskbar rect');
    return {
      taskbar: { L: tl, T: tt, R: tr, B: tb },
      tray: nr > nl ? { L: nl, T: nt, R: nr, B: nb } : null,
    };
  });
}

function pxToDip(px, origin, scale) {
  return Math.round(origin + (px - origin * scale) / scale);
}

async function computeDockRect() {
  try {
    return dockRectFromMeasurement(await queryTaskbarRects());
  } catch (err) {
    console.error('Taskbar measure failed:', err.message);
    return dockRectFromMeasurement(null);
  }
}

function rectsFromLine(line) {
  const parts = line.trim().split(',').map(Number);
  if (parts.length < 8 || parts.slice(0, 4).some(n => Number.isNaN(n))) return null;
  const [tl, tt, tr, tb, nl, nt, nr, nb] = parts;
  return {
    taskbar: { L: tl, T: tt, R: tr, B: tb },
    tray: nr > nl ? { L: nl, T: nt, R: nr, B: nb } : null,
  };
}

function dockRectFromMeasurement(rects) {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const bounds = display.bounds;
  const work = display.workArea;

  let taskbarTop = work.y + work.height;
  let taskbarH = bounds.y + bounds.height - taskbarTop;
  let trayLeft = bounds.x + bounds.width - 214;

  if (rects) {
    taskbarTop = pxToDip(rects.taskbar.T, bounds.y, scale);
    taskbarH = pxToDip(rects.taskbar.B, bounds.y, scale) - taskbarTop;
    if (rects.tray) trayLeft = pxToDip(rects.tray.L, bounds.x, scale);
  }

  if (taskbarH < 20) {
    taskbarH = 48;
    taskbarTop = bounds.y + bounds.height - taskbarH;
  }

  let x = trayLeft - TRAY_GAP - WIDGET_W;
  if (x < bounds.x) x = bounds.x;
  return { x, y: taskbarTop, width: WIDGET_W, height: taskbarH };
}

function placeWindow(rect) {
  if (!mainWindow || mainWindow.isDestroyed() || !rect) return;
  // Ignore 1–3px tray jitter while dragging icons out of the overflow.
  if (dockRect
    && Math.abs(rect.x - dockRect.x) < 4
    && Math.abs(rect.y - dockRect.y) < 2
    && Math.abs(rect.width - dockRect.width) < 2
    && Math.abs(rect.height - dockRect.height) < 2) {
    return;
  }
  const b = mainWindow.getBounds();
  const placed = Math.abs(b.x - rect.x) <= 1 && Math.abs(b.y - rect.y) <= 1
    && Math.abs(b.width - rect.width) <= 1 && Math.abs(b.height - rect.height) <= 1;
  dockRect = rect;
  if (placed) return;
  correcting = true;
  mainWindow.setBounds(rect);
  correcting = false;
}

// Taskbar / "Show hidden icons" sinks the widget under Shell_TrayWnd.
function reveal({ boost = true } = {}) {
  if (restoring || userHidden || !windowReady) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  restoring = true;
  if (boost) pinBoostUntil = Date.now() + 2500;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    pinAboveTaskbar({ move: Boolean(dockRect) });
  } finally {
    restoring = false;
  }
}

// Z-order only by default — moving every tick is what made the player flicker
// while dragging icons out of "Show hidden icons".
function pinAboveTaskbar({ move = false } = {}) {
  if (process.platform !== 'win32' || userHidden) return;
  // 0x0050 = SHOW|NOACTIVATE (may move). 0x0053 = NOMOVE|NOSIZE|NOACTIVATE|SHOW.
  const flags = move ? 0x0050 : 0x0053;
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PinBar {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public static IntPtr Player;
  public static bool OnEnum(IntPtr h, IntPtr l) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    if (sb.ToString() == "Spotify Taskbar Player") { Player = h; return false; }
    return true;
  }
}
"@
$enum = [System.Delegate]::CreateDelegate([PinBar+EnumProc], [PinBar].GetMethod('OnEnum'))
[void][PinBar]::EnumWindows($enum, [IntPtr]::Zero)
if ([PinBar]::Player -eq [IntPtr]::Zero) { exit 0 }
$flags = ${flags}
if (($flags -band 2) -eq 0) {
  $t = [PinBar]::FindWindow('Shell_TrayWnd', $null)
  $n = [PinBar]::FindWindowEx($t, [IntPtr]::Zero, 'TrayNotifyWnd', $null)
  $a = New-Object PinBar+RECT
  $b = New-Object PinBar+RECT
  [void][PinBar]::GetWindowRect($t, [ref]$a)
  if ($n -ne [IntPtr]::Zero) { [void][PinBar]::GetWindowRect($n, [ref]$b) }
  $h = [Math]::Max(48, $a.B - $a.T)
  $x = if ($b.R -gt $b.L) { $b.L - 8 - 340 } else { $a.R - 214 - 8 - 340 }
  [void][PinBar]::SetWindowPos([PinBar]::Player, [IntPtr](-1), $x, $a.T, 340, $h, $flags)
} else {
  [void][PinBar]::SetWindowPos([PinBar]::Player, [IntPtr](-1), 0, 0, 0, 0, $flags)
}
`;
  execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    windowsHide: true,
  }, () => {});
}

function startTrayWatch() {
  stopTrayWatch();
  // Measure tray + quiet z-order pin. Only move when the dock slot actually changes.
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DockWatch {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public static IntPtr Player;
  public static int LastX = int.MinValue;
  public static int LastY = int.MinValue;
  public static int LastH = int.MinValue;
  public static bool OnEnum(IntPtr h, IntPtr l) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    if (sb.ToString() == "Spotify Taskbar Player") { Player = h; return false; }
    return true;
  }
}
'@
$enum = [System.Delegate]::CreateDelegate([DockWatch+EnumProc], [DockWatch].GetMethod('OnEnum'))
$tick = 0
while ($true) {
  try {
    $t = [DockWatch]::FindWindow('Shell_TrayWnd', $null)
    if ($t -ne [IntPtr]::Zero) {
      $n = [DockWatch]::FindWindowEx($t, [IntPtr]::Zero, 'TrayNotifyWnd', $null)
      $a = New-Object DockWatch+RECT
      $b = New-Object DockWatch+RECT
      [void][DockWatch]::GetWindowRect($t, [ref]$a)
      if ($n -ne [IntPtr]::Zero) { [void][DockWatch]::GetWindowRect($n, [ref]$b) }
      $height = [Math]::Max(48, $a.B - $a.T)
      $x = if ($b.R -gt $b.L) { $b.L - 8 - 340 } else { $a.R - 214 - 8 - 340 }
      if (-not [DockWatch]::IsWindow([DockWatch]::Player)) {
        [DockWatch]::Player = [IntPtr]::Zero
        [void][DockWatch]::EnumWindows($enum, [IntPtr]::Zero)
      }
      if ([DockWatch]::Player -ne [IntPtr]::Zero) {
        $moved = [Math]::Abs($x - [DockWatch]::LastX) -ge 4 -or $a.T -ne [DockWatch]::LastY -or $height -ne [DockWatch]::LastH
        if ($moved) {
          [void][DockWatch]::SetWindowPos([DockWatch]::Player, [IntPtr](-1), $x, $a.T, 340, $height, 0x0050)
          [DockWatch]::LastX = $x
          [DockWatch]::LastY = $a.T
          [DockWatch]::LastH = $height
        } elseif (($tick % 4) -eq 0) {
          # Quiet topmost reassert — no move/size, avoids flicker while dragging tray icons
          [void][DockWatch]::SetWindowPos([DockWatch]::Player, [IntPtr](-1), 0, 0, 0, 0, 0x0053)
        }
      }
      [Console]::Out.WriteLine(("{0},{1},{2},{3},{4},{5},{6},{7}" -f $a.L,$a.T,$a.R,$a.B,$b.L,$b.T,$b.R,$b.B))
      [Console]::Out.Flush()
    }
  } catch {}
  $tick++
  Start-Sleep -Milliseconds 250
}
`;
  trayWatch = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let buf = '';
  trayWatch.stdout.on('data', (chunk) => {
    const text = (chunk.length > 1 && chunk[1] === 0) ? chunk.toString('utf16le') : chunk.toString('utf8');
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const rects = rectsFromLine(line);
      if (!rects || userHidden) continue;
      placeWindow(dockRectFromMeasurement(rects));
    }
  });
  trayWatch.on('exit', () => {
    trayWatch = null;
    if (!app.isQuitting) {
      setTimeout(() => { if (!trayWatch && !app.isQuitting) startTrayWatch(); }, 1000);
    }
  });
}

function stopTrayWatch() {
  if (!trayWatch) return;
  trayWatch.kill();
  trayWatch = null;
}

async function dockWindow(win = mainWindow) {
  if (!win || win.isDestroyed() || correcting || userHidden) return;
  placeWindow(await computeDockRect());
}

// ─── Main Window ─────────────────────────────────────────────────────────────
async function createWindow() {
  dockRect = await computeDockRect();

  mainWindow = new BrowserWindow({
    ...dockRect,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenu(null);
  // Above the taskbar itself, so the widget is visible inside the strip.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  mainWindow.once('ready-to-show', async () => {
    await dockWindow();
    mainWindow.showInactive();
    windowReady = true;
  });

  // "Show hidden icons" and other tray clicks bury the widget under the bar.
  mainWindow.on('hide', () => reveal({ boost: true }));
  mainWindow.on('blur', () => reveal({ boost: true }));
  mainWindow.on('minimize', () => reveal({ boost: true }));
  // Soft z-order boost only — no move spam (that caused the drag flicker).
  setInterval(() => {
    if (!windowReady || userHidden || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      reveal({ boost: true });
      return;
    }
    if (Date.now() < pinBoostUntil) {
      pinAboveTaskbar({ move: false });
    }
  }, 400);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ─── Tray ────────────────────────────────────────────────────────────────────
function createTrayIcon() {
  // 16×16 solid Spotify green so the overflow menu is not a blank slot.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x1d;
    buf[i * 4 + 1] = 0xb9;
    buf[i * 4 + 2] = 0x54;
    buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Spotify Taskbar Player');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show player', click: () => { userHidden = false; toggleWindow(); } },
    { label: 'Settings', click: openSettings },
    { label: 'Quit', click: () => { app.quit(); } },
  ]));
  tray.on('click', () => {
    userHidden = false;
    toggleWindow();
  });
}

function toggleWindow() {
  userHidden = false;
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.showInactive();
  dockWindow();
  pinBoostUntil = Date.now() + 2500;
  pinAboveTaskbar({ move: true });
}

// ─── Settings Window ─────────────────────────────────────────────────────────
let settingsWindow = null;
function openSettings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 320,
    title: 'Spotify Taskbar Player – Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── OAuth Flow ──────────────────────────────────────────────────────────────
function startAuthFlow(clientId, clientSecret) {
  store.set('clientId', clientId);
  store.set('clientSecret', clientSecret);

  // Start local redirect-capture server
  if (authServer) authServer.close();
  authServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
    const code = url.searchParams.get('code');
    if (!code) { res.end('No code.'); return; }

    res.end('<script>window.close();</script><p>Authorised! You can close this tab.</p>');
    authServer.close();
    authServer = null;

    try {
      await exchangeCode(code, clientId, clientSecret);
      startPolling();
      mainWindow?.webContents.send('auth-success');
    } catch (err) {
      mainWindow?.webContents.send('auth-error', err.message);
    }
  });
  authServer.listen(REDIRECT_PORT);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  openUrl(`https://accounts.spotify.com/authorize?${params}`);
}

async function exchangeCode(code, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  }).toString();

  const data = await spotifyPost('/api/token', body, clientId, clientSecret);
  saveTokens(data);
}

async function refreshAccessToken() {
  const clientId = store.get('clientId');
  const clientSecret = store.get('clientSecret');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  }).toString();

  const data = await spotifyPost('/api/token', body, clientId, clientSecret);
  saveTokens({ ...data, refresh_token: tokens.refresh_token });
}

function saveTokens(data) {
  tokens.access_token = data.access_token;
  tokens.refresh_token = data.refresh_token || tokens.refresh_token;
  tokens.expires_at = Date.now() + (data.expires_in - 60) * 1000;
  store.set('access_token', tokens.access_token);
  store.set('refresh_token', tokens.refresh_token);
  store.set('expires_at', tokens.expires_at);
}

function spotifyPost(path, body, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const req = https.request({
      hostname: 'accounts.spotify.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(raw)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Spotify API Helpers ──────────────────────────────────────────────────────
async function ensureToken() {
  if (tokens.expires_at && Date.now() > tokens.expires_at) {
    await refreshAccessToken();
  }
}

function spotifyGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.spotify.com',
      path: apiPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 204) { resolve(null); return; }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(raw)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function spotifyAction(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.spotify.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Playback Polling ─────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  fetchPlaybackState();
  pollInterval = setInterval(fetchPlaybackState, 1000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function fetchPlaybackState() {
  if (!tokens.access_token) return;
  try {
    await ensureToken();
    const data = await spotifyGet('/v1/me/player');
    if (!data || !data.item) {
      mainWindow?.webContents.send('playback-state', null);
      return;
    }

    const item = data.item;
    const artists = item.artists.map(a => a.name).join(', ');
    const artUrl = item.album.images?.[0]?.url ?? null;
    const duration = item.duration_ms;
    const progress = data.progress_ms;
    const isPlaying = data.is_playing;
    const trackId = item.id;

    // Check if saved (liked)
    const savedRes = await spotifyGet(`/v1/me/tracks/contains?ids=${trackId}`);
    const isSaved = Array.isArray(savedRes) ? savedRes[0] : false;

    mainWindow?.webContents.send('playback-state', {
      trackId,
      title: item.name,
      artist: artists,
      artUrl,
      duration,
      progress,
      isPlaying,
      isSaved,
    });
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-stored-credentials', () => ({
  clientId: store.get('clientId', ''),
  clientSecret: store.get('clientSecret', ''),
  hasToken: !!tokens.access_token,
}));

ipcMain.handle('save-credentials', (_, { clientId, clientSecret }) => {
  store.set('clientId', clientId);
  store.set('clientSecret', clientSecret);
});

ipcMain.handle('start-auth', (_, { clientId, clientSecret }) => {
  startAuthFlow(clientId, clientSecret);
});

ipcMain.handle('logout', () => {
  stopPolling();
  tokens = { access_token: null, refresh_token: null, expires_at: 0 };
  store.delete('access_token');
  store.delete('refresh_token');
  store.delete('expires_at');
  mainWindow?.webContents.send('playback-state', null);
});

ipcMain.handle('play-pause', async () => {
  await ensureToken();
  const state = await spotifyGet('/v1/me/player');
  if (!state) return;
  const endpoint = state.is_playing ? '/v1/me/player/pause' : '/v1/me/player/play';
  await spotifyAction('PUT', endpoint);
});

ipcMain.handle('next-track', async () => {
  await ensureToken();
  await spotifyAction('POST', '/v1/me/player/next');
});

ipcMain.handle('prev-track', async () => {
  await ensureToken();
  await spotifyAction('POST', '/v1/me/player/previous');
});

ipcMain.handle('toggle-save', async (_, { trackId, isSaved }) => {
  await ensureToken();
  const method = isSaved ? 'DELETE' : 'PUT';
  const endpoint = `/v1/me/tracks?ids=${trackId}`;
  await spotifyAction(method, endpoint);
  return !isSaved;
});

ipcMain.handle('seek', async (_, { positionMs }) => {
  await ensureToken();
  await spotifyAction('PUT', `/v1/me/player/seek?position_ms=${positionMs}`);
});

ipcMain.handle('open-spotify', () => {
  openUrl('https://open.spotify.com');
});

ipcMain.handle('open-settings', () => {
  openSettings();
});
