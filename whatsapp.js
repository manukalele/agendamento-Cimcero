/**
 * whatsapp.js
 * Adapter Baileys para Electron.
 * O import do Baileys Ã© lazy (dentro de iniciarWhatsapp) para nÃ£o
 * travar o boot caso os mÃ³dulos nativos ainda nÃ£o estejam rebuilados.
 * Exporta: iniciarWhatsapp, desligarWhatsappGracioso, encerrarWhatsapp,
 *          obterStatusWhatsapp, enviarMensagem, enviarPdf
 */

'use strict'
const fs   = require('fs')
const path = require('path')

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SUPRESSÃƒO DE WARNINGS â€” bufferutil e utf-8-validate sÃ£o otimizaÃ§Ãµes
// opcionais do Baileys. Removidos das dependÃªncias para eliminar a
// necessidade de compilador nativo (Visual Studio Build Tools).
// O Baileys funciona normalmente sem eles â€” apenas ignora os warnings.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _emitOriginal = process.emit.bind(process)
process.emit = function(event, ...args) {
  if (
    event === 'warning' &&
    args[0]?.message &&
    (
      args[0].message.includes('bufferutil') ||
      args[0].message.includes('utf-8-validate') ||
      args[0].message.includes('utf8-validate')
    )
  ) return false
  return _emitOriginal(event, ...args)
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 1. CONFIGURAÃ‡ÃƒO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CONFIG = {
  SESSION_DIR        : (global.USER_DATA ? path.join(global.USER_DATA, 'baileys_session') : path.resolve('./baileys_session')),
  RECONNECT_INTERVAL : 5_000,
  MAX_RECONNECT_TRIES: 10,
  QUEUE_SEND_MIN_MS  : 5_000,
  QUEUE_SEND_MAX_MS  : 13_000,
  QUEUE_MAX_RETRIES  : 3,
  QUEUE_RETRY_BASE_MS: 10_000,
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 2. LOGGER ESTRUTURADO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LOG_LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' };

function log(level, context, message, extra = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level, context, message, ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === LOG_LEVELS.ERROR) {
    console.error(line);
  } else {
    console.log(line);
  }
}

const logger = {
  info : (ctx, msg, extra) => log(LOG_LEVELS.INFO,  ctx, msg, extra),
  warn : (ctx, msg, extra) => log(LOG_LEVELS.WARN,  ctx, msg, extra),
  error: (ctx, msg, extra) => log(LOG_LEVELS.ERROR, ctx, msg, extra),
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 3. ESTADO DE SAÃšDE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const APP_STATUS = {
  CONNECTING   : 'connecting',
  CONNECTED    : 'conectado',
  DISCONNECTED : 'disconnected',
  RECONNECTING : 'reconnecting',
};

let sessionReady = false;
let stopRequested = false;
let isStarting = false;
let reconnectTimer = null;

const healthState = {
  status           : APP_STATUS.DISCONNECTED,
  startedAt        : Date.now(),
  lastError        : null,
  lastReconnectAt  : null,
  reconnectAttempts: 0,
};

function setStatus(newStatus, error = null) {
  const prev = healthState.status;
  healthState.status = newStatus;
  if (error) {
    healthState.lastError = {
      message  : error.message || String(error),
      timestamp: new Date().toISOString(),
    };
  }
  if (newStatus === APP_STATUS.RECONNECTING) {
    healthState.lastReconnectAt   = new Date().toISOString();
    healthState.reconnectAttempts += 1;
    sessionReady = false;
  }
  logger.info('health', `Status: ${prev} â†’ ${newStatus}`, {
    reconnectAttempts: healthState.reconnectAttempts,
  });
}

function obterStatusWhatsapp() {
  return healthState.status;
}

function limparTimerReconexao() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 4. FILA DE ENVIO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const sendQueue  = [];
let queueRunning = false;

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processQueue(socketRef) {
  if (queueRunning) return;
  queueRunning = true;
  logger.info('queue', 'Processamento da fila iniciado');

  while (sendQueue.length > 0) {
    if (healthState.status !== APP_STATUS.CONNECTED) {
      logger.warn('queue', 'Socket nÃ£o conectado. Aguardando...', { status: healthState.status });
      await sleep(5_000);
      continue;
    }

    const item = sendQueue[0];

    if (item.tipo === 'pdf' && !sessionReady) {
      const elapsed = Date.now() - healthState.startedAt;
      if (elapsed < 30_000) {
        logger.warn('queue', 'SessÃ£o ainda sincronizando. Aguardando antes de enviar mÃ­dia...');
        await sleep(5_000);
        continue;
      }
      logger.warn('queue', 'Timeout de sincronizaÃ§Ã£o atingido. Liberando envio de mÃ­dia.');
      sessionReady = true;
    }

    try {
      logger.info('queue', 'Processando item da fila', {
        numero: item.numero, tipo: item.tipo, tentativa: item._attempts,
      });

      if (item.tipo === 'pdf') {
        await sendPdf(socketRef.current, item);
      } else {
        await sendTexto(socketRef.current, item);
      }

      sendQueue.shift();

      if (sendQueue.length > 0) {
        const delay = randomDelay(CONFIG.QUEUE_SEND_MIN_MS, CONFIG.QUEUE_SEND_MAX_MS);
        logger.info('queue', `PrÃ³ximo envio em ${delay}ms`);
        await sleep(delay);
      }
    } catch (err) {
      item._attempts = (item._attempts || 0) + 1;
      logger.error('queue', `Falha no envio (tentativa ${item._attempts})`, { erro: err.message });

      if (item._attempts >= CONFIG.QUEUE_MAX_RETRIES) {
        logger.error('queue', 'Limite de tentativas atingido. Descartando item.', { numero: item.numero });
        sendQueue.shift();
      } else {
        const backoff = CONFIG.QUEUE_RETRY_BASE_MS * Math.pow(2, item._attempts - 1);
        logger.warn('queue', `Backoff de ${backoff}ms antes de nova tentativa`);
        await sleep(backoff);
      }
    }
  }

  queueRunning = false;
  logger.info('queue', 'Fila processada. Aguardando novos itens.');
}

function enqueue(item, socketRef) {
  item._attempts = 0;
  sendQueue.push(item);
  logger.info('queue', 'Item adicionado Ã  fila', {
    numero: item.numero, tipo: item.tipo, tamanho: sendQueue.length,
  });
  processQueue(socketRef).catch(err =>
    logger.error('queue', 'Erro crÃ­tico no processamento da fila', { erro: err.message })
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 5. ENVIO DE TEXTO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sendTexto(sock, { numero, mensagem }) {
  const { isJidUser } = await import('@whiskeysockets/baileys');
  const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
  if (!isJidUser(jid)) throw new Error(`JID invÃ¡lido: ${jid}`);
  try {
    await sock.sendMessage(jid, { text: mensagem });
    logger.info('sendTexto', 'Mensagem enviada com sucesso', { jid });
  } catch (err) {
    logger.error('sendTexto', 'Falha ao enviar mensagem', { jid, erro: err.message });
    throw err;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 6. ENVIO DE PDF
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sendPdf(sock, { numero, caminhoArquivo, arquivoBuffer = null, fileName = null, caption = '' }) {
  const { isJidUser } = await import('@whiskeysockets/baileys');

  let jid;
  try {
    const results = await sock.onWhatsApp(numero);
    const result  = results?.[0];
    if (!result?.exists) throw new Error(`Numero nao esta no WhatsApp: ${numero}`);
    jid = result.jid;
    logger.info('sendPdf', `Numero validado. JID canonico: ${jid}`);
  } catch (err) {
    if (err.message.includes('nao esta no WhatsApp')) throw err;
    jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    logger.warn('sendPdf', `onWhatsApp falhou. Usando JID manual: ${jid}`, { erro: err.message });
  }

  if (!isJidUser(jid)) throw new Error(`JID invalido: ${jid}`);

  let pdfBuffer = null;
  let pdfFileName = String(fileName || '').trim();

  if (Buffer.isBuffer(arquivoBuffer)) {
    pdfBuffer = arquivoBuffer;
    if (!pdfFileName) pdfFileName = `guia-${Date.now()}.pdf`;
  } else {
    const caminho = path.resolve(String(caminhoArquivo || ''));
    if (!caminhoArquivo || !fs.existsSync(caminho)) {
      throw new Error(`Arquivo nao encontrado: ${caminho}`);
    }
    pdfBuffer = fs.readFileSync(caminho);
    if (!pdfFileName) pdfFileName = path.basename(caminho);
  }

  try {
    const sent = await sock.sendMessage(jid, {
      document: pdfBuffer, mimetype: 'application/pdf', fileName: pdfFileName, caption,
    });

    const msgId = sent?.key?.id;
    if (msgId) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          sock.ev.off('messages.update', handler);
          logger.warn('sendPdf', 'Timeout aguardando ACK. Assumindo entregue.', { jid });
          resolve();
        }, 15_000);

        function handler(updates) {
          for (const update of updates) {
            if (update.key?.id === msgId && (update.update?.status ?? 0) >= 2) {
              clearTimeout(timeout);
              sock.ev.off('messages.update', handler);
              resolve();
            }
          }
        }
        sock.ev.on('messages.update', handler);
      });
    }

    logger.info('sendPdf', 'PDF enviado e confirmado', { jid, arquivo: pdfFileName });
  } catch (err) {
    logger.error('sendPdf', 'Falha ao enviar PDF', { jid, erro: err.message });
    throw err;
  }
}
// 7. HANDLER DE CONEXÃƒO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function emitirStatus(status) {
  if (typeof global.emitirIPC === 'function') {
    global.emitirIPC('whatsapp-status', status);
  }
}

// Preenchidas pelo createSession apÃ³s o import lazy do Baileys
let _Boom            = null;
let _DisconnectReason = null;

function handleConnectionUpdate(update, reconnectFn) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    logger.info('connection', 'QR Code gerado.');
    if (typeof global.emitirIPC === 'function') global.emitirIPC('whatsapp-qr', qr);
    emitirStatus('aguardando_qr');
  }

  if (connection === 'open') {
    limparTimerReconexao();
    setStatus(APP_STATUS.CONNECTED);
    healthState.reconnectAttempts = 0;
    sessionReady = false;
    logger.info('connection', 'Conectado ao WhatsApp.');
    emitirStatus('conectado');
  }

  if (connection === 'close') {
    if (stopRequested) {
      logger.info('connection', 'Desconexao solicitada pelo operador.');
      setStatus(APP_STATUS.DISCONNECTED, lastDisconnect?.error || null);
      emitirStatus('disconnected');
      return;
    }

    const reason = _Boom ? new _Boom(lastDisconnect?.error)?.output?.statusCode : 0;
    const isLogout = _DisconnectReason ? reason === _DisconnectReason.loggedOut : false;

    if (isLogout) {
      logger.error('connection', 'Logout detectado. Sessao encerrada.');
      setStatus(APP_STATUS.DISCONNECTED, lastDisconnect?.error);
      emitirStatus('disconnected');
      return;
    }

    const shouldReconnect = healthState.reconnectAttempts < CONFIG.MAX_RECONNECT_TRIES;
    if (shouldReconnect) {
      setStatus(APP_STATUS.RECONNECTING, lastDisconnect?.error);
      logger.warn('connection', `Reconectando em ${CONFIG.RECONNECT_INTERVAL}ms...`, {
        reason, tentativa: healthState.reconnectAttempts + 1,
      });
      emitirStatus('reconnecting');
      limparTimerReconexao();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectFn();
      }, CONFIG.RECONNECT_INTERVAL);
    } else {
      setStatus(APP_STATUS.DISCONNECTED, lastDisconnect?.error);
      logger.error('connection', 'Numero maximo de tentativas atingido.');
      emitirStatus('disconnected');
    }
  }
}

const socketRef = { current: null };

async function createSession(reconnectFn) {
  // Baileys Ã© ESM-only ("type":"module"), DEVE usar import() dinÃ¢mico
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
  _DisconnectReason = baileys.DisconnectReason;

  // @hapi/boom Ã© CJS, require() funciona normal
  const hapi = require('@hapi/boom');
  _Boom = hapi.Boom;

  if (!fs.existsSync(CONFIG.SESSION_DIR)) {
    fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
    logger.info('session', `DiretÃ³rio de sessÃ£o criado: ${CONFIG.SESSION_DIR}`);
  } else {
    logger.info('session', `Reutilizando sessÃ£o existente: ${CONFIG.SESSION_DIR}`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.SESSION_DIR);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    logger.info('session', `Baileys versÃ£o remota: ${version.join('.')}`);
  } catch (err) {
    version = [2, 3000, 1015901307];
    logger.warn('session', `Fallback de versÃ£o: ${version.join('.')}`, { erro: err.message });
  }

  const sock = makeWASocket({
    version,
    auth             : state,
    printQRInTerminal: false,
    logger           : {
      level: 'silent',
      child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }),
      trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
    },
    generateHighQualityLinkPreview: false,
    syncFullHistory               : false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', update => handleConnectionUpdate(update, reconnectFn));
  sock.ev.on('messaging-history.set', () => {
    sessionReady = true;
    logger.info('session', 'SessÃ£o sincronizada â€” envio de mÃ­dia liberado.');
  });

  socketRef.current = sock;
  logger.info('session', 'Socket criado e eventos registrados.');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 9. API PÃšBLICA
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function enviarPdf(numero, caminhoArquivo, caption = '') {
  return new Promise((resolve) => {
    try {
      if (
        caminhoArquivo &&
        typeof caminhoArquivo === 'object' &&
        (Buffer.isBuffer(caminhoArquivo.arquivoBuffer) || caminhoArquivo.caminhoArquivo)
      ) {
        enqueue({
          tipo: 'pdf',
          numero,
          caminhoArquivo: caminhoArquivo.caminhoArquivo || null,
          arquivoBuffer: Buffer.isBuffer(caminhoArquivo.arquivoBuffer) ? caminhoArquivo.arquivoBuffer : null,
          fileName: caminhoArquivo.fileName || null,
          caption: caminhoArquivo.caption ?? caption
        }, socketRef);
      } else {
        enqueue({ tipo: 'pdf', numero, caminhoArquivo, caption }, socketRef);
      }
      resolve({ sucesso: true });
    } catch (err) {
      resolve({ sucesso: false, erro: err.message });
    }
  });
}

function enviarMensagem(numero, mensagem) {
  return new Promise((resolve) => {
    try {
      enqueue({ tipo: 'texto', numero, mensagem }, socketRef);
      resolve({ sucesso: true });
    } catch (err) {
      resolve({ sucesso: false, erro: err.message });
    }
  });
}

async function iniciarWhatsapp() {
  if (isStarting) {
    logger.info('bootstrap', 'Inicializacao ja em andamento.');
    return;
  }

  const hasSocketAtivo = !!socketRef.current;
  if (
    hasSocketAtivo &&
    (healthState.status === APP_STATUS.CONNECTED ||
     healthState.status === APP_STATUS.CONNECTING ||
     healthState.status === APP_STATUS.RECONNECTING)
  ) {
    logger.info('bootstrap', 'WhatsApp ja esta conectado/conectando.');
    return;
  }

  stopRequested = false;
  isStarting = true;

  async function connect() {
    if (stopRequested) return;
    try {
      setStatus(APP_STATUS.CONNECTING);
      emitirStatus('connecting');
      await createSession(connect);
    } catch (err) {
      if (stopRequested) return;
      logger.error('bootstrap', 'Erro ao criar sessao', { erro: err.message });
      setStatus(APP_STATUS.RECONNECTING, err);
      limparTimerReconexao();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, CONFIG.RECONNECT_INTERVAL);
    }
  }

  try {
    await connect();
    logger.info('bootstrap', 'WhatsApp iniciado. Aguardando conexao...');
  } finally {
    isStarting = false;
  }
}

let stopInFlight = null;

async function pararWhatsappInterno({ fazerLogout = false, apagarSessao = false, motivo = 'shutdown' } = {}) {
  if (stopInFlight) return stopInFlight;

  stopInFlight = (async () => {
    logger.info('shutdown', `${fazerLogout ? 'Logout explicito' : 'Desligamento gracioso'} solicitado`, {
      motivo,
      apagarSessao,
    });

    stopRequested = true;
    limparTimerReconexao();

    sendQueue.length = 0;
    queueRunning = false;
    sessionReady = false;
    healthState.reconnectAttempts = 0;

    const sock = socketRef.current;
    socketRef.current = null;
    if (sock) {
      if (fazerLogout) {
        try {
          if (typeof sock.logout === 'function') {
            await sock.logout();
          }
        } catch (err) {
          logger.warn('logout', 'Falha ao executar logout do socket', { erro: err.message });
        }
      }
      try {
        if (sock.ws && typeof sock.ws.close === 'function') {
          sock.ws.close();
        }
      } catch (err) {
        logger.warn('shutdown', 'Falha ao fechar websocket', { erro: err.message });
      }
    }

    if (apagarSessao && fs.existsSync(CONFIG.SESSION_DIR)) {
      try {
        fs.rmSync(CONFIG.SESSION_DIR, { recursive: true, force: true });
        logger.info('session', 'Sessao removida: ' + CONFIG.SESSION_DIR);
      } catch (err) {
        logger.warn('session', 'Falha ao remover sessao: ' + err.message);
      }
    } else if (!apagarSessao) {
      logger.info('session', 'Sessao preservada em: ' + CONFIG.SESSION_DIR);
    }

    setStatus(APP_STATUS.DISCONNECTED);
    emitirStatus('disconnected');
  })();

  try {
    await stopInFlight;
  } finally {
    stopInFlight = null;
  }
}

async function desligarWhatsappGracioso() {
  return pararWhatsappInterno({
    fazerLogout: false,
    apagarSessao: false,
    motivo: 'encerramento_app',
  });
}

async function encerrarWhatsapp({ apagarSessao = true } = {}) {
  return pararWhatsappInterno({
    fazerLogout: true,
    apagarSessao,
    motivo: 'logout_operador',
  });
}

module.exports = {
  iniciarWhatsapp,
  desligarWhatsappGracioso,
  encerrarWhatsapp,
  obterStatusWhatsapp,
  enviarMensagem,
  enviarPdf
}
