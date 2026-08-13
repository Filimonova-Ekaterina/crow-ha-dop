const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright-core');

const IPC_SOCKET = process.env.IPC_SOCKET || '/tmp/browser_ctl.sock';
// Persistent token store. /data persists for a Home Assistant add-on; standalone
// runs need a mounted volume here to survive container recreation.
const TOKEN_DIR = process.env.TOKEN_DIR || '/data/tokens';
const START_URL = process.env.START_URL || '';

let socket = null;
let session = null;
let page = null;
let currentUrl = '';
let HA_USER = process.env.HA_USER || 'admin';
let HA_PASS = process.env.HA_PASS || 'password';
let loginInProgress = false;

let CLIENT_ID = '';          // ?id=<dev> from the client; keys the token file
let lastSavedTokens = null;  // last hassTokens string written (debounce)
let capturing = false;       // captureToken() re-entry guard
let warnedNoId = false;

const ANTI_ANIMATION_SCRIPT = `
(function() {
  const css = '* { animation: none !important; transition: none !important; cursor: none !important; } input, textarea, [contenteditable="true"] { caret-color: transparent !important; } *:focus, *:focus-visible { outline: none !important; box-shadow: none !important; } ::-webkit-scrollbar { display: none !important; } body { -ms-overflow-style: none !important; scrollbar-width: none !important; }';
  function injectToNode(node) {
    if (node.querySelector && node.querySelector('#rpi-anti-anim')) return;
    const style = document.createElement('style');
    style.id = 'rpi-anti-anim';
    style.innerHTML = css;
    if (node.prepend) node.prepend(style);
    else node.appendChild(style);
  }
  if (document.head) injectToNode(document.head);
})();
(function() {
  const originalOpen = window.open;
  window.open = function(url, name, specs, replace) {
    if (url) {
      window.location.href = url;
    }
    return window;
  };
})();
`;

const INPUT_TRACKING_SCRIPT = `
(function() {
  if (window.__crowInputTrackingInstalled) return;
  window.__crowInputTrackingInstalled = true;

  function deepActiveElement(root) {
    let active = (root || document).activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function inputState() {
    const el = deepActiveElement(document);
    if (!el) return { visible: false, mode: 'text' };
    const tag = String(el.tagName || '').toLowerCase();
    const editable = tag === 'textarea' ||
      (tag === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image',
        'radio', 'range', 'reset', 'submit'].includes(String(el.type || '').toLowerCase())) ||
      el.isContentEditable;
    if (!editable || el.disabled || el.readOnly) return { visible: false, mode: 'text' };

    const type = String(el.type || '').toLowerCase();
    const inputMode = String(el.inputMode || el.getAttribute('inputmode') || '').toLowerCase();
    const numeric = type === 'number' || type === 'tel' ||
      ['numeric', 'decimal'].includes(inputMode);
    return { visible: true, mode: numeric ? 'number' : 'text' };
  }

  let last = '';
  function report() {
    const state = inputState();
    const serialized = JSON.stringify(state);
    if (serialized === last) return;
    last = serialized;
    if (window.__crowReportInputState) window.__crowReportInputState(state);
  }

  document.addEventListener('focusin', () => setTimeout(report, 0), true);
  document.addEventListener('focusout', () => setTimeout(report, 0), true);
  document.addEventListener('pointerup', () => setTimeout(report, 50), true);
  window.__crowReportInputStateNow = report;
  report();
})();
`;

function send(obj) {
  const line = JSON.stringify(obj);
  console.log('[JS->IPC]', line);
  if (socket && !socket.destroyed) {
    socket.write(line + '\n');
  } else {
    console.error('[JS] IPC socket is not connected');
  }
}

// --- Per-device HA session token persistence ---------------------------------
// After a successful login the HA frontend stores `hassTokens` (access_token +
// non-expiring refresh_token) in localStorage. We persist that blob keyed by the
// client id and re-inject it on the next run so the frontend boots authenticated
// and the credential autologin is skipped. SECURITY: hassTokens contains a
// refresh_token (full account access) and is stored in plaintext.

function tokenPath(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe) return null;
  return path.join(TOKEN_DIR, safe + '.json');
}

function loadToken(id) {
  const p = tokenPath(id);
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    JSON.parse(raw); // validate it is well-formed before injecting
    console.log('[JS] Loaded stored session token for id=' + id);
    return raw;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[JS] loadToken failed:', e.message);
    return null;
  }
}

function saveToken(id, rawTokens) {
  const p = tokenPath(id);
  if (!p) {
    if (!warnedNoId) {
      console.error('[JS] No client id — token persistence disabled');
      warnedNoId = true;
    }
    return;
  }
  if (rawTokens === lastSavedTokens) return; // unchanged, skip disk write
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(p, rawTokens, { mode: 0o600 });
    lastSavedTokens = rawTokens;
    console.log('[JS] Saved session token for id=' + id);
  } catch (e) {
    console.error('[JS] saveToken failed:', e.message);
  }
}

async function injectToken(rawTokens) {
  try {
    await page.evaluate((t) => {
      window.localStorage.setItem('hassTokens', t);
    }, rawTokens);
    return true;
  } catch (e) {
    console.error('[JS] injectToken failed:', e.message);
    return false;
  }
}

// Read hassTokens off the authenticated page and persist it. The frontend writes
// the blob a moment after the post-login redirect, so retry briefly.
async function captureToken() {
  if (!CLIENT_ID || capturing) return;
  capturing = true;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let raw;
      try {
        raw = await page.evaluate(() => window.localStorage.getItem('hassTokens'));
      } catch (e) {
        console.error('[JS] captureToken failed:', e.message);
        return;
      }
      if (raw) {
        saveToken(CLIENT_ID, raw);
        return;
      }
      await page.waitForTimeout(1000);
    }
  } finally {
    capturing = false;
  }
}

async function performLogin() {
  if (loginInProgress) return;
  if (!HA_USER || !HA_PASS) return;
  if (!currentUrl.includes('/auth/authorize')) return;

  loginInProgress = true;

  try {
    await page.waitForLoadState('load');
    await page.waitForTimeout(5000);
    console.log('[JS] Typing username...');
    await page.keyboard.type(HA_USER, { delay: 50 });
    send({ type: 'request_full_frame' });
    await page.waitForTimeout(200);

    console.log('[JS] Pressing Tab...');
    await page.keyboard.press('Tab');
    send({ type: 'request_full_frame' });
    await page.waitForTimeout(200);

    console.log('[JS] Typing password...');
    await page.keyboard.type(HA_PASS, { delay: 50 });
    send({ type: 'request_full_frame' });
    await page.waitForTimeout(300);

    console.log('[JS] Pressing Enter to submit...');
    await page.keyboard.press('Enter');
    send({ type: 'request_full_frame' });
  } catch (e) {
    console.error('[JS] Login failed:', e.message);
  } finally {
    setTimeout(() => {
      loginInProgress = false;
    }, 2000);
  }
}

async function handleNavigation(url) {
  currentUrl = url;
  console.log('[JS] Navigated to:', currentUrl);
  send({ type: 'current_url', url: currentUrl });
  send({ type: 'request_full_frame' });

  if (currentUrl.includes('/auth/authorize')) {
    performLogin();
  } else {
    // Reached the app authenticated — persist the fresh session for next run.
    captureToken();
  }
}

async function handleMessage(msg) {
  // console.log('[IPC->JS]', msg);

  try {
    if (msg.type === 'configure') {
      if (msg.user) HA_USER = msg.user;
      if (msg.pass) HA_PASS = msg.pass;
      if (msg.id !== undefined) CLIENT_ID = msg.id;

      if (msg.w && msg.h) {
        await page.setViewportSize({
          width: msg.w,
          height: msg.h
        }).catch(() => {});
      }

      // Re-injecting a stored session skips the credential login. If the token
      // is stale/revoked HA redirects to /auth/authorize and the autologin
      // fallback (in handleNavigation) takes over.
      const stored = loadToken(CLIENT_ID);
      if (stored && await injectToken(stored)) {
        console.log('[JS] Injected stored session, reloading authenticated');
        const target = START_URL || currentUrl;
        if (target) {
          await session.send('Page.navigate', { url: target }).catch(() => {});
        }
        return;
      }

      if (currentUrl.includes('/auth/authorize')) {
        performLogin();
      }
      return;
    }

    if (msg.type === 'touch') {
      const point = { x: msg.x, y: msg.y, id: 1 };

      if (msg.kind === 'down') {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point]
        });
      } else if (msg.kind === 'move') {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point]
        });
      } else if (msg.kind === 'up') {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: []
        });
        await page.waitForTimeout(50);
        await page.evaluate(() => window.__crowReportInputStateNow?.()).catch(() => {});
      } else if (msg.kind === 'tap') {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point]
        });
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: []
        });
        await page.waitForTimeout(50);
        await page.evaluate(() => window.__crowReportInputStateNow?.()).catch(() => {});
      }
      return;
    }

    if (msg.type === 'open_url') {
      if (msg.url && msg.url.startsWith('crow-key://')) {
        const command = msg.url.slice('crow-key://'.length);
        if (command === 'blur') {
          await page.evaluate(() => {
            let el = document.activeElement;
            while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
            if (el && typeof el.blur === 'function') el.blur();
          });
        } else if (command.startsWith('text/')) {
          const hex = command.slice(5);
          if (/^(?:[0-9a-f]{2})+$/i.test(hex)) {
            const bytes = Uint8Array.from(hex.match(/../g), value => parseInt(value, 16));
            await page.keyboard.insertText(new TextDecoder().decode(bytes));
          }
        } else if (['Backspace', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(command)) {
          await page.keyboard.press(command);
        }
        send({ type: 'request_full_frame' });
        return;
      }
      if (msg.url && msg.url !== 'self-test' && currentUrl !== msg.url) {
        await session.send('Page.navigate', { url: msg.url }).catch(() => {});
      } else {
        send({ type: 'request_full_frame' });
      }
      return;
    }

    console.log('[JS] Unknown IPC message type:', msg.type);
  } catch (e) {
    console.error('[JS] command failed:', e.message);
  }
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  page = context.pages()[0];
  session = await context.newCDPSession(page);

  await session.send('Page.enable');
  await page.exposeFunction('__crowReportInputState', (state) => {
    const visible = !!(state && state.visible);
    const mode = state && state.mode === 'number' ? 'number' : 'text';
    send({
      type: 'current_url',
      url: visible ? `crow-keyboard://show?mode=${mode}` : 'crow-keyboard://hide'
    });
  });
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: ANTI_ANIMATION_SCRIPT + '\n' + INPUT_TRACKING_SCRIPT
  });
  await session.send('Runtime.evaluate', {
    expression: ANTI_ANIMATION_SCRIPT + '\n' + INPUT_TRACKING_SCRIPT
  }).catch(() => {});

  session.on('Page.frameNavigated', (evt) => {
    if (evt.frame.parentId) return;
    handleNavigation(evt.frame.url);
  });

  session.on('Page.navigatedWithinDocument', (evt) => {
    handleNavigation(evt.url);
  });

  socket = net.createConnection(IPC_SOCKET);

  socket.on('connect', () => {
    console.log('[JS] IPC connected:', IPC_SOCKET);
  });

  socket.on('error', (e) => {
    console.error('[JS] IPC error:', e.message);
  });

  socket.on('close', () => {
    console.error('[JS] IPC closed');
    process.exit(1);
  });

  const rl = readline.createInterface({
    input: socket,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error('[JS] bad IPC JSON:', line);
      return;
    }
    handleMessage(msg);
  });
}

main().catch((e) => {
  console.error('[JS] fatal:', e.message);
  process.exit(1);
});
