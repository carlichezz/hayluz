const REPO_OWNER = 'carlichezz';
const REPO_NAME = 'hayluz';
const ISSUE_TITLE = 'Hay Luz en el CEINPET?';
const OFFLINE_THRESHOLD_MIN = 45;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/telegram') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const update = await request.json();
      handleTelegramUpdate(update, env).catch(e => console.error('Telegram error:', e));
      return new Response('OK');
    }

    if (url.pathname === '/github') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const body = await request.text();
      const event = request.headers.get('x-github-event') || '';
      handleGithubWebhook(event, body, env).catch(e => console.error('GitHub webhook error:', e));
      return new Response('OK');
    }

    if (url.pathname === '/setup') {
      const result = await setupTelegramWebhook(request, env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('HayLuz Bot running', { status: 200 });
  },

  async scheduled(event, env) {
    await cronCheck(env).catch(e => console.error('Cron error:', e));
  },
};

// ─── TELEGRAM ───

async function handleTelegramUpdate(update, env) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const status = await getIssueStatusFromAPI();

  switch (text) {
    case '/start':
      await addSubscriber(chatId, env);
      await sendTelegram(chatId,
        '👋 <b>Bienvenido a HayLuzBot</b>\n\n'
        + 'Te notificaré cuando <b>vuelva la luz</b> en CEINPET.\n\n'
        + 'Usa /status para ver el estado actual.', env);
      break;

    case '/status':
      if (status.isOnline) {
        await sendTelegram(chatId,
          '⚡ <b>EN LÍNEA</b> ✅\n\n'
          + `🖥️ ${status.hostname}\n`
          + `📡 ${status.ip}\n`
          + `🕐 Actualizado hace ${status.minutesAgo} min`, env);
      } else {
        await sendTelegram(chatId,
          '❌ <b>SIN CORRIENTE</b> 🔴\n\n'
          + `⏱️ Sin conexión desde hace ${status.minutesAgo} min`, env);
      }
      break;
  }
}

// ─── GITHUB WEBHOOK (INSTANTANEO - 0 llamadas API) ───

async function handleGithubWebhook(event, body, env) {
  const payload = JSON.parse(body);
  const issue = payload.issue;
  if (!issue || issue.title !== ISSUE_TITLE) return;
  if (!['opened', 'reopened', 'edited'].includes(payload.action)) return;
  if (payload.action === 'edited' && !payload.changes?.body) return;

  console.log('Webhook: issue actualizado');
  const status = parseIssueBody(issue.body);
  await checkAndNotify(status, env);
}

// ─── CRON (FALLBACK cada 2 min) ───

async function cronCheck(env) {
  console.log('Cron: verificando estado...');
  const status = await getIssueStatusFromAPI();
  await checkAndNotify(status, env);
}

// ─── CORE ───

function parseIssueBody(body) {
  const data = JSON.parse(body);
  const now = Date.now();
  const lastUpdate = new Date(data.timestamp).getTime();
  const minutesAgo = Math.floor((now - lastUpdate) / 60000);

  return {
    isOnline: minutesAgo < OFFLINE_THRESHOLD_MIN,
    hostname: data.hostname || 'Desconocido',
    ip: data.ip || 'Desconocida',
    minutesAgo,
    lastUpdate,
  };
}

async function getIssueStatusFromAPI() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=all`
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const issues = await res.json();
  const issue = issues.find(i => i.title === ISSUE_TITLE);
  if (!issue) throw new Error('Issue no encontrado');
  return parseIssueBody(issue.body);
}

async function checkAndNotify(status, env) {
  const stateStr = await env.KV.get('state');
  const state = stateStr ? JSON.parse(stateStr) : { phase: 'online', offlineSince: null };

  if (!status.isOnline) {
    if (state.phase !== 'offline') {
      console.log('Transición a OFFLINE');
      state.phase = 'offline';
      state.offlineSince = status.lastUpdate;
      await env.KV.put('state', JSON.stringify(state));
    }
    return;
  }

  if (state.phase === 'offline') {
    console.log('¡Volvió la luz! Notificando...');
    const durationMin = Math.floor((Date.now() - state.offlineSince) / 60000);
    const h = Math.floor(durationMin / 60);
    const m = durationMin % 60;

    const msg =
      '⚡ <b>¡Volvió la luz en CEINPET!</b> ⚡\n\n'
      + `🖥️ ${status.hostname}\n`
      + `📡 ${status.ip}\n`
      + `⏱️ Apagón: ${h}h ${m}m\n`
      + `🕐 Recuperado hace ${status.minutesAgo} min`;

    await notifyAllSubscribers(msg, env);

    state.phase = 'online';
    state.offlineSince = null;
    await env.KV.put('state', JSON.stringify(state));
  }
}

// ─── HELPERS ───

async function addSubscriber(chatId, env) {
  const subsStr = await env.KV.get('subscribers');
  const subs = subsStr ? JSON.parse(subsStr) : [];
  if (!subs.includes(chatId)) {
    subs.push(chatId);
    await env.KV.put('subscribers', JSON.stringify(subs));
    console.log(`Nuevo suscriptor: ${chatId}`);
  }
}

async function notifyAllSubscribers(message, env) {
  const subsStr = await env.KV.get('subscribers');
  const subs = subsStr ? JSON.parse(subsStr) : [];
  if (subs.length === 0) {
    console.log('No hay suscriptores');
    return;
  }
  console.log(`Notificando a ${subs.length} suscriptores`);
  await Promise.allSettled(subs.map(chatId => sendTelegram(chatId, message, env)));
}

async function sendTelegram(chatId, text, env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Telegram error (${chatId}):`, err);
  }
}

async function setupTelegramWebhook(request, env) {
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/telegram`;
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`,
  );
  return await res.json();
}
