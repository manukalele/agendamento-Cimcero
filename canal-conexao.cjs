'use strict'

const fs = require('fs')
const path = require('path')
const net = require('net')
const os = require('os')

function criarCanalConexao({
  userDataPath,
  onStatus = () => {},
  onRemoteWaJob = async () => ({ ok: false, error: 'handler_nao_configurado' }),
  onRemoteHostJob = async () => ({ ok: false, error: 'handler_host_nao_configurado' }),
  maxClients = 3
}) {
  const CONFIG_PATH = path.join(userDataPath, 'canal-conexao.json')
  const HEARTBEAT_MS = 10_000
  const RECONNECT_MAX_MS = 15_000
  const JOB_TIMEOUT_MS = 60_000
  const MAX_FRAME_BYTES = 64 * 1024 * 1024

  const configDefault = {
    mode: 'none',
    host: { port: 47820, code: '' },
    client: { host: '', port: 47820, code: '' },
    autoStart: true
  }

  let config = carregarConfig()
  let status = {
    role: 'none',
    state: 'disconnected',
    message: '',
    host: '',
    port: null,
    clientCount: 0,
    transport: 'tcp-ndjson',
    updatedAt: new Date().toISOString()
  }

  let hostServer = null
  let hostClients = new Map()
  let hostNextClientId = 1

  let clientSocket = null
  let clientBuffer = ''
  let clientAuthed = false
  let clientConnected = false
  let clientDesired = false
  let clientReconnectTimer = null
  let clientHeartbeatTimer = null
  let clientReconnectAttempt = 0
  let clientTarget = { host: '', port: 0, code: '' }
  let pendingJobs = new Map()

  function carregarConfig() {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configDefault, null, 2), 'utf-8')
        return { ...configDefault }
      }
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      const normalized = {
        mode: ['none', 'host', 'client'].includes(raw?.mode) ? raw.mode : 'none',
        host: {
          port: Number(raw?.host?.port) || configDefault.host.port,
          code: String(raw?.host?.code || '')
        },
        client: {
          host: String(raw?.client?.host || ''),
          port: Number(raw?.client?.port) || configDefault.client.port,
          code: String(raw?.client?.code || '')
        },
        autoStart: raw?.autoStart !== false
      }
      return normalized
    } catch {
      return { ...configDefault }
    }
  }

  function salvarConfig() {
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
    fs.renameSync(tmp, CONFIG_PATH)
  }

  function setConfig(partial = {}) {
    config = {
      ...config,
      ...partial,
      host: { ...config.host, ...(partial.host || {}) },
      client: { ...config.client, ...(partial.client || {}) }
    }
    salvarConfig()
    return getConfig()
  }

  function getConfig() {
    return JSON.parse(JSON.stringify(config))
  }

  function emitStatus(partial = {}) {
    status = {
      ...status,
      ...partial,
      updatedAt: new Date().toISOString()
    }
    onStatus({ ...status })
  }

  function getStatus() {
    return { ...status }
  }

  function sendJson(socket, payload) {
    if (!socket || socket.destroyed) return false
    try {
      socket.write(JSON.stringify(payload) + '\n')
      return true
    } catch {
      return false
    }
  }

  function parseLines(buffer, onLine) {
    let rest = buffer
    for (;;) {
      const idx = rest.indexOf('\n')
      if (idx === -1) break
      const line = rest.slice(0, idx).trim()
      rest = rest.slice(idx + 1)
      if (!line) continue
      onLine(line)
    }
    return rest
  }

  function safeParse(line) {
    try { return JSON.parse(line) } catch { return null }
  }

  function getLocalIps() {
    const nets = os.networkInterfaces()
    const ips = []
    for (const name of Object.keys(nets)) {
      for (const netInfo of nets[name] || []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal) {
          ips.push(netInfo.address)
        }
      }
    }
    return ips
  }

  function clearClientReconnect() {
    if (clientReconnectTimer) {
      clearTimeout(clientReconnectTimer)
      clientReconnectTimer = null
    }
  }

  function clearClientHeartbeat() {
    if (clientHeartbeatTimer) {
      clearInterval(clientHeartbeatTimer)
      clientHeartbeatTimer = null
    }
  }

  function rejectPendingJobs(errorMessage) {
    for (const [, pending] of pendingJobs) {
      clearTimeout(pending.timer)
      pending.reject(new Error(errorMessage))
    }
    pendingJobs.clear()
  }

  function startClientHeartbeat() {
    clearClientHeartbeat()
    clientHeartbeatTimer = setInterval(() => {
      if (!clientSocket || clientSocket.destroyed || !clientAuthed) return
      sendJson(clientSocket, { type: 'ping', ts: Date.now() })
    }, HEARTBEAT_MS)
  }

  function scheduleReconnect(reason = 'desconectado') {
    if (!clientDesired) return
    clearClientReconnect()
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * Math.pow(2, Math.max(0, clientReconnectAttempt)))
    emitStatus({
      role: 'client',
      state: 'reconnecting',
      message: `reconectando em ${Math.round(delay / 1000)}s (${reason})`,
      host: clientTarget.host,
      port: clientTarget.port,
      clientCount: 0
    })
    clientReconnectTimer = setTimeout(() => {
      clientReconnectTimer = null
      connectClientInternal()
    }, delay)
    clientReconnectAttempt += 1
  }

  function handleClientMessage(msg) {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'auth_ok') {
      clientAuthed = true
      clientConnected = true
      clientReconnectAttempt = 0
      emitStatus({
        role: 'client',
        state: 'connected',
        message: 'conectado ao host',
        host: clientTarget.host,
        port: clientTarget.port,
        clientCount: 0
      })
      startClientHeartbeat()
      return
    }

    if (msg.type === 'auth_error') {
      const reason = String(msg.reason || 'falha na autenticacao')
      clientAuthed = false
      clientConnected = false
      clearClientHeartbeat()
      emitStatus({
        role: 'client',
        state: 'error',
        message: reason,
        host: clientTarget.host,
        port: clientTarget.port,
        clientCount: 0
      })
      if (reason === 'invalid_code') {
        clientDesired = false
      } else {
        scheduleReconnect(reason)
      }
      return
    }

    if (msg.type === 'pong') return

    if (msg.type === 'wa_job_ack' || msg.type === 'host_job_ack') {
      const jobId = String(msg.jobId || '')
      if (!jobId) return
      const pending = pendingJobs.get(jobId)
      if (!pending) return
      if (pending.expectedAckType && pending.expectedAckType !== msg.type) return
      clearTimeout(pending.timer)
      pendingJobs.delete(jobId)
      if (msg.ok) pending.resolve(msg)
      else pending.reject(new Error(String(msg.error || pending.defaultError || 'falha_job')))
    }
  }

  function connectClientInternal() {
    clearClientReconnect()
    clearClientHeartbeat()
    if (!clientDesired) return

    if (!clientTarget.host || !clientTarget.port || !clientTarget.code) {
      emitStatus({
        role: 'client',
        state: 'error',
        message: 'host/porta/codigo obrigatorios',
        host: clientTarget.host,
        port: clientTarget.port,
        clientCount: 0
      })
      return
    }

    clientAuthed = false
    clientConnected = false

    emitStatus({
      role: 'client',
      state: clientReconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      message: clientReconnectAttempt > 0 ? 'tentando reconectar...' : 'conectando...',
      host: clientTarget.host,
      port: clientTarget.port,
      clientCount: 0
    })

    const socket = net.createConnection({
      host: clientTarget.host,
      port: clientTarget.port
    })

    clientSocket = socket
    clientBuffer = ''

    socket.on('connect', () => {
      sendJson(socket, {
        type: 'hello',
        role: 'client',
        code: clientTarget.code,
        version: 1
      })
    })

    socket.on('data', chunk => {
      clientBuffer += chunk.toString('utf8')
      if (clientBuffer.length > MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      clientBuffer = parseLines(clientBuffer, line => {
        const msg = safeParse(line)
        handleClientMessage(msg)
      })
    })

    socket.on('error', err => {
      emitStatus({
        role: 'client',
        state: 'error',
        message: `erro de socket: ${err.message}`,
        host: clientTarget.host,
        port: clientTarget.port,
        clientCount: 0
      })
    })

    socket.on('close', () => {
      const shouldReconnect = clientDesired
      clientAuthed = false
      clientConnected = false
      clearClientHeartbeat()
      clientSocket = null
      rejectPendingJobs('canal desconectado')
      if (shouldReconnect) {
        scheduleReconnect('socket fechado')
      } else {
        emitStatus({
          role: 'client',
          state: 'disconnected',
          message: 'desconectado',
          host: clientTarget.host,
          port: clientTarget.port,
          clientCount: 0
        })
      }
    })
  }

  function destroyClientSocket() {
    clearClientReconnect()
    clearClientHeartbeat()
    if (clientSocket && !clientSocket.destroyed) {
      try { clientSocket.end() } catch {}
      try { clientSocket.destroy() } catch {}
    }
    clientSocket = null
    clientBuffer = ''
    clientAuthed = false
    clientConnected = false
    rejectPendingJobs('canal desconectado')
  }

  async function connectClient({ host, port, code, persistMode = true } = {}) {
    if (hostServer) await stopHost({ persistMode: false })

    const parsedPort = Number(port)
    if (!host || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('host/porta invalidos')
    }
    if (!code || String(code).trim().length < 3) {
      throw new Error('codigo do canal invalido')
    }

    clientDesired = true
    clientTarget = {
      host: String(host).trim(),
      port: parsedPort,
      code: String(code).trim()
    }
    clientReconnectAttempt = 0
    destroyClientSocket()

    emitStatus({
      role: 'client',
      state: 'connecting',
      message: 'conectando...',
      host: clientTarget.host,
      port: clientTarget.port,
      clientCount: 0
    })

    if (persistMode) {
      setConfig({
        mode: 'client',
        client: {
          host: clientTarget.host,
          port: clientTarget.port,
          code: clientTarget.code
        }
      })
    }

    connectClientInternal()
    return getStatus()
  }

  async function disconnectClient({ persistMode = true } = {}) {
    clientDesired = false
    destroyClientSocket()
    emitStatus({
      role: persistMode ? 'none' : 'client',
      state: 'disconnected',
      message: 'desconectado',
      host: clientTarget.host,
      port: clientTarget.port,
      clientCount: 0
    })
    if (persistMode) {
      setConfig({ mode: 'none' })
    }
    return getStatus()
  }

  async function handleHostMessage(ctx, msg) {
    const socket = ctx.socket
    if (!msg || typeof msg !== 'object') return

    if (!ctx.authed) {
      if (msg.type !== 'hello' || msg.role !== 'client') {
        sendJson(socket, { type: 'auth_error', reason: 'invalid_handshake' })
        socket.destroy()
        return
      }
      if (String(msg.code || '') !== String(config.host.code || '')) {
        sendJson(socket, { type: 'auth_error', reason: 'invalid_code' })
        socket.destroy()
        return
      }
      if (hostClients.size >= maxClients) {
        sendJson(socket, { type: 'auth_error', reason: 'host_capacity_reached' })
        socket.destroy()
        return
      }

      ctx.authed = true
      ctx.clientId = `c${hostNextClientId++}`
      hostClients.set(ctx.clientId, ctx)
      sendJson(socket, { type: 'auth_ok', serverTime: Date.now() })
      emitStatus({
        role: 'host',
        state: 'listening',
        message: 'host ativo',
        host: getLocalIps().join(', '),
        port: config.host.port,
        clientCount: hostClients.size
      })
      return
    }

    if (msg.type === 'ping') {
      sendJson(socket, { type: 'pong', ts: Date.now() })
      return
    }

    if (msg.type === 'wa_job_submit') {
      const jobId = String(msg.jobId || '')
      const job = msg.job
      if (!jobId || !job || typeof job !== 'object') {
        sendJson(socket, {
          type: 'wa_job_ack',
          jobId,
          ok: false,
          error: 'payload_invalido'
        })
        return
      }

      try {
        const result = await onRemoteWaJob(job)
        sendJson(socket, {
          type: 'wa_job_ack',
          jobId,
          ok: !!result?.ok,
          error: result?.ok ? null : String(result?.error || 'falha_wa_job')
        })
      } catch (err) {
        sendJson(socket, {
          type: 'wa_job_ack',
          jobId,
          ok: false,
          error: String(err?.message || 'falha_wa_job')
        })
      }
    }

    if (msg.type === 'host_job_submit') {
      const jobId = String(msg.jobId || '')
      const jobType = String(msg.jobType || '').trim()
      const payload = msg.payload
      if (!jobId || !jobType) {
        sendJson(socket, {
          type: 'host_job_ack',
          jobId,
          ok: false,
          error: 'payload_invalido'
        })
        return
      }

      try {
        const result = await onRemoteHostJob({ jobType, payload })
        if (result?.ok) {
          sendJson(socket, {
            type: 'host_job_ack',
            jobId,
            ok: true,
            ...(result && typeof result === 'object' ? result : {})
          })
        } else {
          sendJson(socket, {
            type: 'host_job_ack',
            jobId,
            ok: false,
            error: String(result?.error || 'falha_host_job')
          })
        }
      } catch (err) {
        sendJson(socket, {
          type: 'host_job_ack',
          jobId,
          ok: false,
          error: String(err?.message || 'falha_host_job')
        })
      }
    }
  }

  async function startHost({ port, code, persistMode = true } = {}) {
    if (clientDesired || clientSocket) await disconnectClient({ persistMode: false })
    if (hostServer) await stopHost({ persistMode: false })

    const parsedPort = Number(port)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('porta invalida')
    }
    if (!code || String(code).trim().length < 3) {
      throw new Error('codigo do canal invalido')
    }

    config.host.port = parsedPort
    config.host.code = String(code).trim()

    await new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        const ctx = {
          socket,
          authed: false,
          clientId: null,
          buffer: ''
        }

        socket.on('data', chunk => {
          ctx.buffer += chunk.toString('utf8')
          if (ctx.buffer.length > MAX_FRAME_BYTES) {
            socket.destroy()
            return
          }
          ctx.buffer = parseLines(ctx.buffer, line => {
            const msg = safeParse(line)
            handleHostMessage(ctx, msg)
          })
        })

        socket.on('error', () => {})

        socket.on('close', () => {
          if (ctx.clientId && hostClients.has(ctx.clientId)) {
            hostClients.delete(ctx.clientId)
            emitStatus({
              role: 'host',
              state: 'listening',
              message: 'host ativo',
              host: getLocalIps().join(', '),
              port: config.host.port,
              clientCount: hostClients.size
            })
          }
        })
      })

      server.on('error', err => {
        reject(err)
      })

      server.listen(parsedPort, '0.0.0.0', () => {
        hostServer = server
        resolve()
      })
    })

    if (persistMode) {
      setConfig({
        mode: 'host',
        host: { port: parsedPort, code: String(code).trim() }
      })
    }

    emitStatus({
      role: 'host',
      state: 'listening',
      message: 'host ativo',
      host: getLocalIps().join(', '),
      port: parsedPort,
      clientCount: hostClients.size
    })

    return getStatus()
  }

  async function stopHost({ persistMode = true } = {}) {
    for (const [, client] of hostClients) {
      try { client.socket.destroy() } catch {}
    }
    hostClients.clear()

    if (hostServer) {
      await new Promise(resolve => {
        try {
          hostServer.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    hostServer = null

    emitStatus({
      role: persistMode ? 'none' : 'host',
      state: 'disconnected',
      message: 'host parado',
      host: '',
      port: null,
      clientCount: 0
    })

    if (persistMode) {
      setConfig({ mode: 'none' })
    }

    return getStatus()
  }

  async function sendWaJob(job) {
    if (!clientDesired || !clientConnected || !clientAuthed || !clientSocket || clientSocket.destroyed) {
      throw new Error('canal indisponivel para envio whatsapp')
    }
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingJobs.delete(jobId)
        reject(new Error('timeout aguardando resposta do host'))
      }, JOB_TIMEOUT_MS)
      pendingJobs.set(jobId, {
        resolve,
        reject,
        timer,
        expectedAckType: 'wa_job_ack',
        defaultError: 'falha_wa_job'
      })
      const sent = sendJson(clientSocket, { type: 'wa_job_submit', jobId, job })
      if (!sent) {
        clearTimeout(timer)
        pendingJobs.delete(jobId)
        reject(new Error('falha ao enviar job para host'))
      }
    })
  }

  async function sendHostJob(jobType, payload) {
    if (!clientDesired || !clientConnected || !clientAuthed || !clientSocket || clientSocket.destroyed) {
      throw new Error('canal indisponivel para envio ao host')
    }
    const kind = String(jobType || '').trim()
    if (!kind) throw new Error('jobType obrigatorio')

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingJobs.delete(jobId)
        reject(new Error('timeout aguardando resposta do host'))
      }, JOB_TIMEOUT_MS)
      pendingJobs.set(jobId, {
        resolve,
        reject,
        timer,
        expectedAckType: 'host_job_ack',
        defaultError: 'falha_host_job'
      })
      const sent = sendJson(clientSocket, { type: 'host_job_submit', jobId, jobType: kind, payload })
      if (!sent) {
        clearTimeout(timer)
        pendingJobs.delete(jobId)
        reject(new Error('falha ao enviar job para host'))
      }
    })
  }

  async function restoreFromConfig() {
    config = carregarConfig()
    if (!config.autoStart) return getStatus()
    if (config.mode === 'host' && config.host.code) {
      try {
        await startHost({ port: config.host.port, code: config.host.code, persistMode: false })
      } catch (err) {
        emitStatus({
          role: 'host',
          state: 'error',
          message: `falha ao iniciar host: ${err.message}`,
          host: '',
          port: config.host.port,
          clientCount: 0
        })
      }
      return getStatus()
    }
    if (config.mode === 'client' && config.client.host && config.client.code) {
      try {
        await connectClient({
          host: config.client.host,
          port: config.client.port,
          code: config.client.code,
          persistMode: false
        })
      } catch (err) {
        emitStatus({
          role: 'client',
          state: 'error',
          message: `falha ao conectar cliente: ${err.message}`,
          host: config.client.host,
          port: config.client.port,
          clientCount: 0
        })
      }
    }
    return getStatus()
  }

  async function shutdown() {
    clearClientReconnect()
    clearClientHeartbeat()
    clientDesired = false
    destroyClientSocket()
    await stopHost({ persistMode: false })
    emitStatus({
      role: status.role === 'none' ? 'none' : status.role,
      state: 'disconnected',
      message: 'canal encerrado',
      host: '',
      port: null,
      clientCount: 0
    })
  }

  return {
    getConfig,
    saveConfig: setConfig,
    getStatus,
    startHost,
    stopHost,
    connectClient,
    disconnectClient,
    sendWaJob,
    sendHostJob,
    restoreFromConfig,
    shutdown
  }
}

module.exports = { criarCanalConexao }
