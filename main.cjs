'use strict'

// ─────────────────────────────────────────────────────────────
// main.cjs — ponto de entrada do Electron (CommonJS)
//
// Responsabilidades:
//   • Boot: splash → módulos ESM → janelas
//   • Gerenciar cookie de sessão (sem Playwright, sem Express)
//   • Janela da interface interna (agendamentos.html via loadFile)
//   • Janela do sistema externo embutida via <webview>
//   • Repassar QR Code do Baileys ao renderer via IPC
//   • Handlers IPC para as 4 operações de dados (antes no Express)
//   • Tray icon
// ─────────────────────────────────────────────────────────────

const electron = require('electron')
console.log('[Diag] require("electron") retornou:', typeof electron, Object.keys(electron || {}).slice(0, 10))
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = electron
console.log('[Diag] app:', typeof app)
const path   = require('path')
const fs     = require('fs')
const crypto = require('crypto')
const QRCode = require('qrcode')
const { criarCanalConexao } = require('./canal-conexao.cjs')

const APP_PROFILE_RAW = String(process.env.APP_PROFILE || '').trim()
const APP_PROFILE = APP_PROFILE_RAW
  ? APP_PROFILE_RAW.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  : ''

if (APP_PROFILE) {
  const profileUserData = path.join(app.getPath('appData'), 'agendamentos-electron', `profile-${APP_PROFILE}`)
  app.setPath('userData', profileUserData)
  console.log(`[Boot] APP_PROFILE ativo: ${APP_PROFILE}`)
  console.log(`[Boot] userData isolado: ${profileUserData}`)
}

// ─────────────────────────────────────────────────────────────
// Diagnóstico de erros silenciosos
// ─────────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('[ERRO NAO TRATADO]', err))
process.on('unhandledRejection', err => console.error('[PROMISE REJEITADA]', err))
console.log('[Boot] main.cjs carregado')

// ─────────────────────────────────────────────────────────────
// Redireciona cache de GPU para %APPDATA% — evita "Acesso negado (0x5)"
// ─────────────────────────────────────────────────────────────
const _cacheDir = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'agendamentos-electron',
  'GPUCache'
)
app.commandLine.appendSwitch('disk-cache-dir', _cacheDir)

// ─────────────────────────────────────────────────────────────
// BUILD_ID — valor injetado automaticamente pelo prebuild.cjs
// a cada "npm run build". Nunca edite este valor manualmente.
// ─────────────────────────────────────────────────────────────
const BUILD_ID = '1777033018825'

const URL_BASE = 'https://cimcero.pentagono.info'
const URL_DASH = `${URL_BASE}/dash`
const URL_ACMANAGER = `${URL_BASE}/P5fw/acmanager`
const BANCO_FIXO_NOME = 'banco-completo-1776706462033.json'

let splashWindow   = null
let appWindow      = null
let tray           = null
let appWindowReady = false
let pendingQr      = null

let _bancoBackupYmd = null

// ─────────────────────────────────────────────────────────────
// Sync automático do banco (1x por hora, em background)
// ─────────────────────────────────────────────────────────────
const BANCO_SYNC_INTERVAL_MS = 60 * 60 * 1000
const BANCO_SYNC_DELAY_MS = 1200
let _bancoSyncRodando = false
let _bancoSyncUltimoFimMs = 0
let _bancoSyncUltimoResumo = null

// Referências aos módulos ESM — preenchidas após o dynamic import
let _buscarPaciente    = null
let _agendarViaHttp    = null
let _iniciarWhatsapp   = null
let _desligarWhatsappGracioso = null
let _encerrarWhatsapp  = null
let _obterStatus       = null
let _enviarMensagem    = null
let _enviarPdf         = null
let _verificarSessao   = null
let _whatsappStartPromise = null
let _canalService = null
let _shutdownPromise = null
let _allowBeforeQuit = false

// ─────────────────────────────────────────────────────────────
// Caminhos persistentes
// ─────────────────────────────────────────────────────────────
const USER_DATA   = app.getPath('userData')
const SESSAO_PATH = path.join(USER_DATA, 'sessao.json')
const PASTA_GUIAS = path.join(process.env.USERPROFILE || '', 'Downloads', 'Guias baixadas')
const CONTATOS_FORNECEDORES_PATH = path.join(USER_DATA, 'contatos-fornecedores.json')
const CONTATOS_FORNECEDORES_PATH_LEGACY = path.join(__dirname, 'public', 'contatos-fornecedores.json')
const ORCAMENTO_TOKENS_PATH = path.join(USER_DATA, 'orcamento-tokens.json')
const BANCO_SYNC_STATE_PATH = path.join(USER_DATA, 'banco-sync-state.json')
const ORCAMENTO_TOKEN_SCOPE = 'orcamento_v1'
const ORCAMENTO_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000

// Expõe para os módulos ESM antes do dynamic import
global.USER_DATA = USER_DATA
global.APP_DIR   = app.getAppPath()

_canalService = criarCanalConexao({
  userDataPath: USER_DATA,
  maxClients: 3,
  onStatus: (status) => {
    if (typeof global.emitirIPC === 'function') {
      global.emitirIPC('canal-status', status)
    }
  },
  onRemoteWaJob: async (job = {}) => {
    if (!_enviarMensagem || !_enviarPdf || !_obterStatus) {
      return { ok: false, error: 'modulo_whatsapp_nao_inicializado' }
    }

    const statusWhatsapp = _obterStatus()
    if (statusWhatsapp !== 'conectado') {
      return { ok: false, error: `whatsapp_host_desconectado (${statusWhatsapp || 'desconhecido'})` }
    }

    const kind = String(job.kind || '')
    if (kind === 'texto') {
      const envio = await _enviarMensagem(String(job.numero || ''), String(job.mensagem || ''))
      if (envio && envio.sucesso === false) {
        return { ok: false, error: String(envio.erro || 'falha_envio_texto') }
      }
      return { ok: true }
    }

    if (kind === 'pdf') {
      const numero = String(job.numero || '').trim()
      const caption = String(job.caption || '')
      const base64 = String(job.pdfBase64 || '')
      if (!numero || !base64) return { ok: false, error: 'payload_pdf_invalido' }
      const safeFile = String(job.fileName || `canal-${Date.now()}.pdf`).replace(/[<>:"/\\|?*]+/g, '_')
      const arquivoBuffer = Buffer.from(base64, 'base64')
      const envio = await _enviarPdf(numero, { arquivoBuffer, fileName: safeFile, caption })
      if (envio && envio.sucesso === false) {
        return { ok: false, error: String(envio.erro || 'falha_envio_pdf') }
      }
      return { ok: true }
    }

    return { ok: false, error: 'kind_nao_suportado' }
  },
  onRemoteHostJob: async ({ jobType, payload } = {}) => {
    const tipo = String(jobType || '').trim()
    if (!tipo) return { ok: false, error: 'job_type_invalido' }

    if (tipo === 'orc_token_create') {
      const snapshot = _sanitizarSnapshotOrcamento(payload?.snapshot, { exigirExames: true })
      if (!snapshot) return { ok: false, error: 'snapshot_invalido' }
      const registro = _criarTokenOrcamentoLocal({
        snapshot,
        prefix: 'ORC',
        origin: 'host',
        createdByRole: String(payload?.createdByRole || 'client')
      })
      return {
        ok: true,
        token: registro.token,
        expiresAt: registro.expiresAt,
        origin: registro.origin,
        createdByRole: registro.createdByRole
      }
    }

    if (tipo === 'orc_token_fetch') {
      try {
        const registro = _recuperarTokenOrcamentoLocal(payload?.token)
        return {
          ok: true,
          token: registro.token,
          expiresAt: registro.expiresAt,
          origin: registro.origin,
          snapshot: registro.snapshot
        }
      } catch (err) {
        return { ok: false, error: String(err?.message || 'token_invalido') }
      }
    }

    return { ok: false, error: 'job_type_nao_suportado' }
  }
})

// ─────────────────────────────────────────────────────────────
// LIMPEZA DE SESSÕES DE AMBIENTE ANTERIOR
//
// Usa dois mecanismos combinados para detectar um build novo:
//
//   1. BUILD_ID — timestamp único injetado pelo prebuild.cjs em
//      cada "npm run build". Gravado em .app-build-id no userData.
//      Muda a cada build, independentemente da versão.
//
//   2. Versão — fallback adicional via app.getVersion() gravado
//      em .app-version no userData.
//
// Se qualquer um dos dois diferir do valor gravado no userData,
// as sessões são apagadas e os novos valores são gravados.
// Nas execuções seguintes do mesmo build, ambos batem e nada
// é apagado — as sessões criadas pelo usuário são preservadas.
// ─────────────────────────────────────────────────────────────
const MARCA_VERSAO_PATH   = path.join(USER_DATA, '.app-version')
const MARCA_BUILD_ID_PATH = path.join(USER_DATA, '.app-build-id')

function limparSessoesDeAmbienteAnterior() {
  const versaoAtual  = app.getVersion()
  const buildIdAtual = BUILD_ID

  // Lê marcas gravadas pelo build anterior (podem não existir)
  let versaoGravada  = null
  let buildIdGravado = null
  try { versaoGravada  = fs.readFileSync(MARCA_VERSAO_PATH,   'utf-8').trim() } catch { /* ok */ }
  try { buildIdGravado = fs.readFileSync(MARCA_BUILD_ID_PATH, 'utf-8').trim() } catch { /* ok */ }

  const versaoBate  = versaoGravada  === versaoAtual
  const buildIdBate = buildIdGravado === buildIdAtual

  if (versaoBate && buildIdBate) {
    // Mesmo build rodando novamente — sessões são do usuário, preserva
    console.log(`[Boot] Build confirmado (v${versaoAtual} / id:${buildIdAtual}) — sessões preservadas`)
    return
  }

  // Pelo menos um identificador mudou → novo build detectado
  console.log(`[Boot] Novo build detectado:`)
  console.log(`[Boot]   versão:   "${versaoGravada ?? 'nenhuma'}" → "${versaoAtual}"`)
  console.log(`[Boot]   build_id: "${buildIdGravado ?? 'nenhum'}"  → "${buildIdAtual}"`)
  console.log('[Boot] Limpando sessões de ambiente anterior...')

  // 1. Remove sessão do sistema (PHPSESSID)
  if (fs.existsSync(SESSAO_PATH)) {
    try {
      fs.unlinkSync(SESSAO_PATH)
      console.log('[Boot] sessao.json removido')
    } catch (err) {
      console.warn(`[Boot] Falha ao remover sessao.json: ${err.message}`)
    }
  }

  // 2. Remove sessão Baileys (credenciais do WhatsApp)
  const baileysDir = path.join(USER_DATA, 'baileys_session')
  if (fs.existsSync(baileysDir)) {
    try {
      fs.rmSync(baileysDir, { recursive: true, force: true })
      console.log('[Boot] baileys_session/ removido')
    } catch (err) {
      console.warn(`[Boot] Falha ao remover baileys_session/: ${err.message}`)
    }
  }

  // 3. Grava as marcas do build atual — próximas execuções preservarão as sessões
  try {
    fs.mkdirSync(USER_DATA, { recursive: true })
    fs.writeFileSync(MARCA_VERSAO_PATH,   versaoAtual,  'utf-8')
    fs.writeFileSync(MARCA_BUILD_ID_PATH, buildIdAtual, 'utf-8')
    console.log(`[Boot] Marcas de build gravadas (v${versaoAtual} / id:${buildIdAtual})`)
  } catch (err) {
    console.warn(`[Boot] Falha ao gravar marcas de build: ${err.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// Resolve caminho do banco.json (userData tem prioridade)
// ─────────────────────────────────────────────────────────────
function resolverCaminhoBanco() {
  // Em dev: usa direto public/. Em producao (asar): copia para userData e trabalha
  // sempre em um arquivo gravavel, mantendo o mesmo "banco-completo-...json".
  const emUserData = path.join(USER_DATA, BANCO_FIXO_NOME)
  if (fs.existsSync(emUserData)) return emUserData

  const basePath = app.isPackaged ? app.getAppPath() : __dirname
  const emPublic = path.join(basePath, 'public', BANCO_FIXO_NOME)
  if (!fs.existsSync(emPublic)) {
    throw new Error(`${BANCO_FIXO_NOME} nao encontrado em public/`)
  }

  // Primeira execucao: cria copia gravavel no userData
  try {
    fs.mkdirSync(USER_DATA, { recursive: true })
    fs.copyFileSync(emPublic, emUserData)
    console.log('[Boot] Copia do banco criada em userData:', emUserData)
    return emUserData
  } catch (err) {
    // Fallback: ainda permite rodar sem persistir (ex.: permissao negada)
    console.warn('[Boot] Falha ao copiar banco para userData, usando public:', err.message)
    return emPublic
  }
}

// ── Credenciados: HTTP + persistencia no banco-completo ─────────
function _obterPhpsessid() {
  const valor = global.phpsessid
  if (!valor) throw new Error('Sessao nao iniciada — faca login na aba do sistema')
  return valor
}

function _headersAcmanager() {
  return {
    'Cookie':           `PHPSESSID=${_obterPhpsessid()}`,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer':          URL_DASH,
  }
}

function _parsearRespostaJson(texto, contexto) {
  if (String(texto || '').trimStart().startsWith('<')) {
    console.warn(`[Sessao] Resposta HTML detectada em "${contexto}" — sessao expirada ou invalida`)
    global.phpsessid = null
    if (typeof global.emitirIPC === 'function') {
      global.emitirIPC('sessao-expirada')
    }
    throw new Error('Sessao expirada — faca login novamente na aba do sistema')
  }
  try {
    return JSON.parse(texto)
  } catch (err) {
    throw new Error(`Falha ao parsear JSON (${contexto}): ${err.message}`)
  }
}

async function _acmanagerGetJson(paramsObj, contexto) {
  const params = new URLSearchParams(paramsObj || {})
  if (!params.has('_')) params.set('_', String(Date.now()))
  const url = `${URL_ACMANAGER}?${params.toString()}`

  const res = await fetch(url, { headers: _headersAcmanager() })
  if (!res.ok) throw new Error(`Erro HTTP ${res.status} em ${contexto}`)

  const texto = await res.text()
  return _parsearRespostaJson(texto, contexto)
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function _stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function _acmanagerPostTexto(formObj, contexto, opts = {}) {
  const expectedMarker = String(opts?.expectedMarker || '').trim()
  const params = new URLSearchParams(formObj || {})
  if (!params.has('_')) params.set('_', String(Date.now()))

  const res = await fetch(URL_ACMANAGER, {
    method: 'POST',
    headers: {
      ..._headersAcmanager(),
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  })
  if (!res.ok) throw new Error(`Erro HTTP ${res.status} em ${contexto}`)
  const texto = await res.text()

  // Para endpoints que deveriam devolver um HTML específico, validamos um marcador.
  // Se o marcador não aparecer e o HTML parecer ser "tela de login", tratamos como sessão expirada.
  if (expectedMarker && !texto.includes(expectedMarker)) {
    const t = texto.trimStart()
    const pareceLogin = t.startsWith('<!DOCTYPE') || t.startsWith('<html') || t.includes('Sics - Sistema')
    if (pareceLogin) {
      console.warn(`[Sessao] HTML inesperado em "${contexto}" (provável login) — sessão expirada`)
      global.phpsessid = null
      if (typeof global.emitirIPC === 'function') global.emitirIPC('sessao-expirada')
      throw new Error('Sessao expirada — faca login novamente na aba do sistema')
    }
    throw new Error(`HTML inesperado em ${contexto} (marcador ausente: ${expectedMarker})`)
  }

  return texto
}

function _normalizarNomeExame(str) {
  return String(str || '').replace(/\s+/g, ' ').trim()
}

function _parsePrecoNumero(valor) {
  if (valor === null || valor === undefined) return null
  const txt = String(valor).trim()
  if (!txt) return null
  const n = Number(txt.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function _parsePrecoBr(valor) {
  // Aceita "R$ 32,50", "32,50", "32.50", "32"
  const txt = String(valor || '').replace(/\s+/g, ' ').trim()
  if (!txt) return null
  const limpo = txt.replace(/^R\$\s*/i, '').trim()
  return _parsePrecoNumero(limpo)
}

function _extrairFornecedoresRelatorioCredenciados(html) {
  const select = html.match(/<select[^>]*id=['"]rpt-credenciados-prest['"][^>]*>([\s\S]*?)<\/select>/i)
  if (!select) throw new Error('Relatorio: select rpt-credenciados-prest nao encontrado')
  const optText = select[1]
  const optRe = /<option([^>]*)value=['"](\d+)['"][^>]*>([\s\S]*?)<\/option>/gi
  const out = []
  let m
  while ((m = optRe.exec(optText))) {
    const attrs = m[1] || ''
    const forid = String(m[2] || '').trim()
    if (!forid || forid === '0') continue
    const label = _stripTags(m[3] || '')
    if (!label) continue

    // No relatorio existem "prestadores" sem nome (so documento + "-").
    // Esses IDs tendem a retornar HTML incompleto no fornecedores/editar e/ou nome vazio no getdata.
    // Guardrail: nao sincronizar esses IDs para evitar inserir clinicas vazias no banco.
    const parts = label.split('-')
    const tail = parts.length > 1 ? parts.slice(1).join('-').trim() : label.trim()
    if (!tail) continue

    out.push({
      forid,
      label,
      desativadoNoSistema: /text-danger/i.test(attrs),
    })
  }
  return out
}

function _extrairItensFornecedorEditar(html) {
  const tbody = html.match(/<tbody[^>]*id=['"]fornecedor-editar-servicos['"][^>]*>([\s\S]*?)<\/tbody>/i)
  if (!tbody) throw new Error('Fornecedor/editar: tbody fornecedor-editar-servicos nao encontrado')
  const body = tbody[1]

  function _parseAttrs(tagOpen) {
    // Parse de atributos no nivel da tag, ignorando qualquer 'class=' dentro de valores.
    // Ex.: data-loading-text="<i class='fa ...'></i>" nao deve confundir o parser.
    const attrs = {}

    const lt = tagOpen.indexOf('<')
    const gt = tagOpen.lastIndexOf('>')
    const inner = tagOpen.slice(lt + 1, gt >= 0 ? gt : tagOpen.length)

    // Avanca ate depois do nome da tag.
    let i = 0
    while (i < inner.length && !/\s/.test(inner[i])) i++

    while (i < inner.length) {
      while (i < inner.length && /\s/.test(inner[i])) i++
      if (i >= inner.length) break

      let name = ''
      while (i < inner.length) {
        const ch = inner[i]
        if (ch === '=' || /\s/.test(ch)) break
        name += ch
        i++
      }
      name = name.trim()
      while (i < inner.length && /\s/.test(inner[i])) i++

      let value = ''
      if (inner[i] === '=') {
        i++
        while (i < inner.length && /\s/.test(inner[i])) i++
        const q = inner[i]
        if (q === '"' || q === "'") {
          i++
          const startVal = i
          while (i < inner.length && inner[i] !== q) i++
          value = inner.slice(startVal, i)
          if (inner[i] === q) i++
        } else {
          const startVal = i
          while (i < inner.length && !/\s/.test(inner[i])) i++
          value = inner.slice(startVal, i)
        }
      }

      if (name) attrs[name.toLowerCase()] = value
    }

    return attrs
  }

  const trRe = /<tr\b[\s\S]*?<\/tr>/gi
  const out = []
  let trm
  while ((trm = trRe.exec(body))) {
    const trHtml = trm[0]

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
    const tds = []
    let tdm
    while ((tdm = tdRe.exec(trHtml))) tds.push(_stripTags(tdm[1]))
    if (tds.length < 3) continue

    const nome = _normalizarNomeExame(tds[0])
    const preco = _parsePrecoBr(tds[1])
    const validade = String(tds[2] || '').trim()

    // Extrai a tag de abertura do <button ...> respeitando aspas.
    const btnOpenTags = trHtml.match(/<button\b(?:(?:"[^"]*")|(?:'[^']*')|[^'">])*?>/gi) || []
    if (!btnOpenTags.length) continue

    let cls = ''
    let ref = ''
    for (const tagOpen of btnOpenTags) {
      const a = _parseAttrs(tagOpen)
      const c = String(a['class'] || '')
      if (!/\bcred\b/i.test(c)) continue
      const r = String(a['ref'] || '').trim()
      if (!r) continue
      cls = c
      ref = r
      break
    }
    if (!ref) continue

    const enabled = /\bbtn-success\b/i.test(cls) ? true : (/\bbtn-danger\b/i.test(cls) ? false : null)
    out.push({ id: ref, nome, preco, validade, enabled })
  }

  return out
}

function _emitirBancoSync(evento, payload) {
  if (typeof global.emitirIPC !== 'function') return
  try { global.emitirIPC(evento, payload) } catch { /* ignora */ }
}

function _logBancoSync(msg, extra) {
  const base = `[BancoSync] ${msg}`
  if (extra !== undefined) console.log(base, extra)
  else console.log(base)
}

function _logBancoSyncFor(forid, msg, extra) {
  const id = String(forid || '').trim() || '?'
  _logBancoSync(`forid=${id} ${msg}`, extra)
}

function _bancoSyncStateVazio() {
  return {
    lastReportTotal: 0,
    lastReportAt: 0,
    lastReportDisabledCount: 0,
    fornecedores: {},
  }
}

function _carregarBancoSyncState() {
  try {
    const raw = JSON.parse(fs.readFileSync(BANCO_SYNC_STATE_PATH, 'utf-8'))
    const base = raw && typeof raw === 'object' ? raw : {}
    if (!base.fornecedores || typeof base.fornecedores !== 'object') base.fornecedores = {}
    base.lastReportTotal = Number(base.lastReportTotal || 0) || 0
    base.lastReportAt = Number(base.lastReportAt || 0) || 0
    base.lastReportDisabledCount = Number(base.lastReportDisabledCount || 0) || 0
    return base
  } catch {
    return _bancoSyncStateVazio()
  }
}

function _salvarBancoSyncState(state) {
  const base = state && typeof state === 'object' ? state : _bancoSyncStateVazio()
  if (!base.fornecedores || typeof base.fornecedores !== 'object') base.fornecedores = {}
  _escreverJsonAtomico(BANCO_SYNC_STATE_PATH, base)
}

function _bancoSyncStateFornecedor(state, forid) {
  const s = state && typeof state === 'object' ? state : null
  if (!s) return null
  if (!s.fornecedores || typeof s.fornecedores !== 'object') s.fornecedores = {}
  const id = String(forid || '').trim()
  if (!id) return null
  if (!s.fornecedores[id]) {
    s.fornecedores[id] = {
      lastSeenAt: 0,
      lastReportStatus: 'missing',
      consecutiveInactive: 0,
      consecutiveMissing: 0,
      lastLabel: '',
    }
  }
  const rec = s.fornecedores[id]
  if (!rec || typeof rec !== 'object') return null
  rec.lastSeenAt = Number(rec.lastSeenAt || 0) || 0
  rec.consecutiveInactive = Number(rec.consecutiveInactive || 0) || 0
  rec.consecutiveMissing = Number(rec.consecutiveMissing || 0) || 0
  rec.lastReportStatus = String(rec.lastReportStatus || 'missing')
  rec.lastLabel = String(rec.lastLabel || '')
  return rec
}

function _bancoSyncAplicarAtivoClinicaSePreciso(clinica, forid, novoAtivo, resumo) {
  if (!clinica || typeof clinica !== 'object') return false
  const atual = (clinica.ativo !== false)
  const desejado = !!novoAtivo
  if (atual === desejado) return false
  clinica.ativo = desejado
  if (resumo && typeof resumo === 'object') {
    if (desejado) resumo.clinicasAtivadas++
    else resumo.clinicasDesativadas++
  }
  _logBancoSyncFor(forid, `CLINICA ATIVO ALTERADO: ${atual} -> ${desejado} (${clinica.nome || '-'})`)
  return true
}

async function _acmanagerPostTextoBruto(formObj, contexto) {
  const params = new URLSearchParams(formObj || {})
  if (!params.has('_')) params.set('_', String(Date.now()))

  const res = await fetch(URL_ACMANAGER, {
    method: 'POST',
    headers: {
      ..._headersAcmanager(),
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  })
  if (!res.ok) throw new Error(`Erro HTTP ${res.status} em ${contexto}`)
  const texto = await res.text()

  const t = texto.trimStart()
  // Alguns endpoints podem devolver um HTML completo; tratamos como "login" apenas se tiver sinais claros do sistema/login.
  const pareceLogin = t.startsWith('<!DOCTYPE') || t.startsWith('<html') || t.includes('Sics - Sistema')
  if (pareceLogin) {
    const temSics = texto.includes('Sics - Sistema') || texto.includes('SICS') || texto.includes('sics')
    if (temSics) {
      console.warn(`[Sessao] HTML inesperado em "${contexto}" (provavel login) - sessao expirada`)
      global.phpsessid = null
      if (typeof global.emitirIPC === 'function') global.emitirIPC('sessao-expirada')
      throw new Error('Sessao expirada - faca login novamente na aba do sistema')
    }
  }

  return texto
}

async function _bancoSyncConfirmacaoSecundariaInativo(forid) {
  const id = String(forid || '').trim()
  if (!id) return { confirmado: false }

  const out = {
    confirmado: false,
    fonte: null,
    getdata: null,
    editar: null,
  }

  // 1) getdata: enabled=0 ou trash=1
  try {
    const dados = await _acmanagerGetJson({ action: 'fornecedores/getdata', forid: id }, `banco-sync/getdata-confirm(forid=${id})`)
    const enabled = String(dados?.enabled ?? '').trim()
    const trash = String(dados?.trash ?? '').trim()
    out.getdata = { enabled, trash }
    if (enabled === '0' || trash === '1') {
      out.confirmado = true
      out.fonte = 'getdata'
      return out
    }
  } catch (err) {
    out.getdata = { error: err.message }
    if (!global.phpsessid) throw err
  }

  // 2) fornecedores/editar: ausencia do marcador
  try {
    const html = await _acmanagerPostTextoBruto({
      action: 'fornecedores/editar',
      page: '1',
      wid: '5',
      'params[id]': id,
    }, `banco-sync/fornecedores-editar-confirm(forid=${id})`)
    const hasMarker = html.includes('fornecedor-editar-servicos')
    out.editar = { hasMarker }
    if (!hasMarker) {
      out.confirmado = true
      out.fonte = 'editar_sem_marker'
      return out
    }
  } catch (err) {
    out.editar = { error: err.message }
    if (!global.phpsessid) throw err
  }

  return out
}

function _resumoVazioSync() {
  return {
    fornecedoresTotal: 0,
    fornecedoresOk: 0,
    fornecedoresErro: 0,
    clinicasNovas: 0,
    clinicasAtivadas: 0,
    clinicasDesativadas: 0,
    enderecosAtualizados: 0,
    vinculosNovos: 0,
    precosAtualizados: 0,
    itensSuspensos: 0,
    itensReativados: 0,
    vinculosRemovidos: 0,
  }
}

async function _bancoSyncProcessarFornecedor(work, forid, opts = {}, resumo) {
  const labelRelatorio = String(opts.label || '').trim()

  const clinicas = Array.isArray(work?.clinicas) ? work.clinicas : []
  const exames = Array.isArray(work?.exames) ? work.exames : []
  const clinicaId = String(forid).trim()
  if (!clinicaId) return

  const local = {
    clinicaNova: false,
    ativoMudou: false,
    ativoNovoValor: null,
    enderecosMudaram: false,
    itensTotal: 0,
    vinculosNovos: 0,
    precosAtualizados: 0,
    itensSuspensos: 0,
    itensReativados: 0,
    vinculosRemovidos: 0,
  }

  let clinica = clinicas.find(c => String(c?.id || '').trim() === clinicaId)
  if (!clinica) {
    // Nova clínica: importa getdata e cria no banco
    const dados = await _acmanagerGetJson({ action: 'fornecedores/getdata', forid: clinicaId }, `banco-sync/getdata(forid=${clinicaId})`)
    const norm = _normalizarFornecedorGetdata(dados)
    if (!norm.id) throw new Error(`Fornecedor ${clinicaId} retornou dados inválidos`)
    if (!String(norm.nome || '').trim()) {
      _logBancoSyncFor(clinicaId, `SKIP: getdata sem nome (label="${labelRelatorio || '-'}")`)
      return local
    }
    clinica = {
      ...norm,
      tipo: _inferirTipoClinica(norm.nome),
      ativo: true,
    }
    clinicas.push(clinica)
    clinicas.sort((a, b) => Number(String(a?.id || '0')) - Number(String(b?.id || '0')))
    resumo.clinicasNovas++
    local.clinicaNova = true
    _logBancoSyncFor(clinicaId, `CLINICA NOVA: "${clinica.nome}" tipo=${clinica.tipo} ativo=${clinica.ativo}`)
  } else {
    // Atualiza ativo conforme o relatório do sistema
    // Ativo/inativo e transicoes sao tratados no nivel do ciclo (relatorio + histerese),
    // para evitar falso-positivo quando o HTML do sistema oscila.

    // Sincroniza endereços/dados cadastrais (somente se mudou)
    const dados = await _acmanagerGetJson({ action: 'fornecedores/getdata', forid: clinicaId }, `banco-sync/getdata(forid=${clinicaId})`)
    const norm = _normalizarFornecedorGetdata(dados)
    if (norm.id && norm.id === clinicaId) {
      const mudouEndereco = !_enderecosSaoIguais(clinica.enderecos, norm.enderecos)
      // Atualiza apenas campos que já existiam no shape padronizado.
      const campos = ['nome','telefone','celular','email','razao','cpfcnpj','cnes','mtdopgto','habilitado','trash','irrfisento','irrfaliquota','imagem','cidade','horariolivre','emaillisten','agendamentoFullAccess','email_contabil','contrato','created_at','tempo_altera_guia','troca_data','simples','logradouro','numero','bairro','complemento','cep','show_vagas','feedback','precancel','allow_qtde_cfm']
      let mudou = false
      for (const k of campos) {
        const a = clinica[k]
        const b = norm[k]
        if (a !== b) { clinica[k] = b; mudou = true }
      }
      if (mudouEndereco) {
        const antes = Array.isArray(clinica.enderecos) ? clinica.enderecos.length : 0
        const depois = Array.isArray(norm.enderecos) ? norm.enderecos.length : 0
        clinica.enderecos = norm.enderecos
        mudou = true
        resumo.enderecosAtualizados++
        local.enderecosMudaram = true
        _logBancoSyncFor(clinicaId, `ENDERECOS ALTERADOS: ${antes} -> ${depois} (${clinica.nome || '-'})`)
      }
      // Mantém tipo do app inferido (não usa tipo numérico do sistema).
      if (mudou) {
        // nada adicional
      }
    }
  }

  // Lista completa de itens do fornecedor (preço + status)
  const htmlEditar = await _acmanagerPostTexto({
    action: 'fornecedores/editar',
    page: '1',
    wid: '5',
    'params[id]': clinicaId,
  }, `banco-sync/fornecedores-editar(forid=${clinicaId})`, { expectedMarker: 'fornecedor-editar-servicos' })

  const itens = _extrairItensFornecedorEditar(htmlEditar)
  // Guardrail contra parser quebrado: se o HTML tem sinais claros de itens, mas o parser retornou 0, aborta.
  const evidRef = (htmlEditar.match(/\bref=['"]\d+['"]/gi) || []).length
  const evidBtn = (htmlEditar.match(/\bbtn-success\b|\bbtn-danger\b/gi) || []).length
  if (itens.length === 0 && (evidRef > 0 || evidBtn > 0)) {
    throw new Error(`PARSE FALHOU em fornecedores/editar: itens=0 mas html indica itens (refs=${evidRef} btns=${evidBtn})`)
  }
  local.itensTotal = itens.length
  _logBancoSyncFor(clinicaId, `ITENS HTML carregados: ${itens.length}`)
  // Ajuda a diagnosticar quando um fornecedor tem muitas linhas "Suspenso" no sistema.
  // Importante: o sync só insere vínculos novos quando o item está "Credenciado" (btn-success).
  const itensOk = itens.filter(x => x && x.enabled === true).length
  const itensSusp = itens.filter(x => x && x.enabled === false).length
  const itensUnk = itens.length - itensOk - itensSusp
  _logBancoSyncFor(clinicaId, `ITENS STATUS: credenciado=${itensOk} suspenso=${itensSusp} desconhecido=${itensUnk}`)
  const vistosAtivos = new Set()
  const vistosSuspensos = new Set()
  let removidosPorSuspensao = 0
  let removidosPorAusencia = 0

  for (const it of itens) {
    const pid = String(it?.id || '').trim()
    if (!pid) continue

    const nomeParam = _normalizarNomeExame(it?.nome || '')
    const precoSistema = (typeof it?.preco === 'number' ? it.preco : null)
    const enabledSistema = (it?.enabled === true ? true : (it?.enabled === false ? false : null))

    // Para remoção: só consideramos "ativo" quando não está Suspenso. Suspensos serão removidos do banco no passo final.
    if (enabledSistema === false) vistosSuspensos.add(pid)
    else vistosAtivos.add(pid)
    const validadeSistema = String(it?.validade || '').trim()

    // Procura vínculo existente (por clinica_id + id_exame_clinica).
    let vinculo = null
    let exameDono = null
    for (const ex of exames) {
      const lista = Array.isArray(ex?.clinicas) ? ex.clinicas : []
      const v = lista.find(c => String(c?.clinica_id || '').trim() === clinicaId && String(c?.id_exame_clinica || '').trim() === pid)
      if (v) { vinculo = v; exameDono = ex; break }
    }

    // Regra: se estiver Suspenso no sistema (btn-danger), o vínculo deve sumir do banco/searchbox.
    // A remoção em si acontece no passo final (filter), baseado em vistosAtivos/vistosSuspensos.
    if (vinculo && enabledSistema === false) {
      continue
    }

    if (!vinculo) {
      // Itens Suspenso (btn-danger) devem sumir dos searchboxes, entao nao cadastramos vinculos novos para eles.
      // Eles so entram no banco quando estiverem Credenciado (btn-success).
      if (enabledSistema === false) continue

      if (!nomeParam || precoSistema === null) continue
      let ex = exames.find(e => _normalizarNomeExame(e?.nome_parametro) === nomeParam)
      if (!ex) {
        ex = { nome_parametro: nomeParam, nome_real: nomeParam, clinicas: [] }
        exames.push(ex)
      }
      if (!Array.isArray(ex.clinicas)) ex.clinicas = []
      ex.clinicas.push({ clinica_id: clinicaId, id_exame_clinica: Number(pid), preco: precoSistema, enabled: (enabledSistema === null ? undefined : enabledSistema), validade: (validadeSistema || undefined) })
      resumo.vinculosNovos++
      local.vinculosNovos++
      _logBancoSyncFor(clinicaId, `EXAME NOVO: pid=${pid} preco=${precoSistema} enabled=${enabledSistema} nome="${nomeParam}"`)
      continue
    }

    // Atualiza preço se mudou
    if (enabledSistema !== false && precoSistema !== null && typeof vinculo.preco === 'number' && vinculo.preco !== precoSistema) {
      const antes = vinculo.preco
      vinculo.preco = precoSistema
      resumo.precosAtualizados++
      local.precosAtualizados++
      _logBancoSyncFor(clinicaId, `PRECO ATUALIZADO: pid=${pid} ${antes} -> ${precoSistema} nome="${nomeParam}"`)
    } else if (enabledSistema !== false && precoSistema !== null && (vinculo.preco === null || vinculo.preco === undefined)) {
      vinculo.preco = precoSistema
      resumo.precosAtualizados++
      local.precosAtualizados++
      _logBancoSyncFor(clinicaId, `PRECO PREENCHIDO: pid=${pid} -> ${precoSistema} nome="${nomeParam}"`)
    }

    // Atualiza status (enabled) se houver indicação
    if (enabledSistema !== null) {
      const atual = (vinculo.enabled === false ? false : true)
      if (enabledSistema !== atual) {
        vinculo.enabled = enabledSistema
        if (enabledSistema) resumo.itensReativados++
        else resumo.itensSuspensos++
        if (enabledSistema) local.itensReativados++
        else local.itensSuspensos++
        _logBancoSyncFor(clinicaId, `STATUS ITEM: pid=${pid} ${atual} -> ${enabledSistema} nome="${nomeParam}"`)
      }
    }

    // Atualiza validade quando disponível (campo extra, não quebra compatibilidade)
    if (validadeSistema) {
      if (String(vinculo.validade || '').trim() !== validadeSistema) {
        vinculo.validade = validadeSistema
      }
    }

    // Se o nome_parametro do "dono" estiver muito diferente do nome do sistema, não mexe.
    // A regra de inclusão/atualização por nome só roda quando o vínculo não existe.
    void exameDono
  }

  // Remove vínculos do fornecedor que não aparecem mais no HTML (exames excluídos/retirados do fornecedor)
  // Mantemos consistência para evitar selecionar algo que não existe mais no sistema.
  // Guardrail: se nao conseguimos listar itens (itens=0), nao removemos vinculos desse fornecedor.
  // Isso evita deletar tudo quando o sistema retorna um HTML incompleto.
  if (itens.length === 0) {
    _logBancoSyncFor(clinicaId, `WARN: itens=0; pulando remocao de vinculos para evitar limpeza indevida`)
    return local
  }

  for (const ex of exames) {
    const lista = Array.isArray(ex?.clinicas) ? ex.clinicas : []
    const antes = lista.length
    ex.clinicas = lista.filter(c => {
      if (String(c?.clinica_id || '').trim() !== clinicaId) return true
      const pid = String(c?.id_exame_clinica || '').trim()
      if (vistosAtivos.has(pid)) return true
      if (vistosSuspensos.has(pid)) { removidosPorSuspensao++; return false }
      removidosPorAusencia++; return false
    })
    if (ex.clinicas.length !== antes) {
      const diff = (antes - ex.clinicas.length)
      // resumo/local de removidos sao calculados via removidosPorSuspensao/removidosPorAusencia
      void diff
    }
  }

  if (removidosPorSuspensao || removidosPorAusencia) {
    const totalRem = (removidosPorSuspensao + removidosPorAusencia)
    resumo.vinculosRemovidos += totalRem
    local.vinculosRemovidos += totalRem
    if (removidosPorSuspensao) _logBancoSyncFor(clinicaId, `VINCULOS REMOVIDOS POR SUSPENSAO: ${removidosPorSuspensao}`)
    if (removidosPorAusencia) _logBancoSyncFor(clinicaId, `VINCULOS REMOVIDOS POR AUSENCIA: ${removidosPorAusencia}`)
  }

  if (local.vinculosRemovidos) {
    _logBancoSyncFor(clinicaId, `VINCULOS REMOVIDOS (nao existem mais no sistema): ${local.vinculosRemovidos}`)
  }

  return local
}

function _calcularHashBanco(banco) {
  // Hash estável do conteúdo (ordem do JSON influencia; usamos JSON.stringify com espaçamento fixo).
  // Serve só para detectar mudança geral antes de salvar.
  try {
    const s = JSON.stringify(banco)
    return crypto.createHash('sha1').update(s).digest('hex')
  } catch {
    return null
  }
}

async function _bancoSyncRodar({ motivo = 'interval' } = {}) {
  if (_bancoSyncRodando) return { ok: false, reason: 'ja_rodando' }
  if (!global.phpsessid) {
    _emitirBancoSync('banco-sync-status', { stage: 'aguardando_login', motivo })
    _logBancoSync(`aguardando_login (motivo=${motivo})`)
    return { ok: false, reason: 'sem_sessao' }
  }

  _bancoSyncRodando = true
  const startedAt = Date.now()
  const resumo = _resumoVazioSync()
  let state = null
  let stateAlterado = false
  _emitirBancoSync('banco-sync-status', { stage: 'iniciando', motivo, startedAt })
  _logBancoSync(`INICIO sync (motivo=${motivo})`)

  try {
    const htmlRel = await _acmanagerPostTexto({
      action: 'relatorios/credenciamentos/credenciados',
      page: '1',
      wid: '5',
    }, 'banco-sync/relatorio-credenciados', { expectedMarker: 'rpt-credenciados-prest' })

    const fornecedores = _extrairFornecedoresRelatorioCredenciados(htmlRel)
    resumo.fornecedoresTotal = fornecedores.length
    const desNoSistema = fornecedores.filter(f => f.desativadoNoSistema).length
    _logBancoSync(`fornecedores carregados: total=${fornecedores.length} desativados_no_sistema=${desNoSistema}`)
    _emitirBancoSync('banco-sync-status', { stage: 'fornecedores', total: fornecedores.length })

    const { caminho, banco } = _carregarBancoCompleto()
    const hashAntes = _calcularHashBanco(banco)
    _logBancoSync(`banco: ${caminho}`)

    // Working copy: aplica mudanças em memória e só salva no fim.
    const work = JSON.parse(JSON.stringify(banco))
    if (!Array.isArray(work.clinicas)) work.clinicas = []
    if (!Array.isArray(work.exames)) work.exames = []

    state = _carregarBancoSyncState()

    const reportTotal = fornecedores.length
    const lastTotal = Number(state?.lastReportTotal || 0) || 0
    const ratio = (lastTotal > 0) ? (reportTotal / lastTotal) : null
    const reportSuspeito = (reportTotal < 50) || (lastTotal >= 50 && reportTotal < Math.floor(lastTotal * 0.6))
    if (reportSuspeito) {
      const ratioTxt = (ratio === null ? '-' : ratio.toFixed(2))
      _logBancoSync(`RELATORIO SUSPEITO: total=${reportTotal} lastTotal=${lastTotal} ratio=${ratioTxt} - pulando ciclo para evitar falso-positivo`)
      _emitirBancoSync('banco-sync-status', { stage: 'relatorio_suspeito', motivo, reportTotal, lastTotal, ratio: ratioTxt })
      _bancoSyncUltimoFimMs = Date.now()
      return { ok: false, reason: 'relatorio_suspeito', resumo }
    }

    state.lastReportTotal = reportTotal
    state.lastReportAt = Date.now()
    state.lastReportDisabledCount = desNoSistema
    stateAlterado = true

    const clinicaById = new Map()
    for (const c of (Array.isArray(work.clinicas) ? work.clinicas : [])) {
      const id = String(c?.id || '').trim()
      if (id) clinicaById.set(id, c)
    }

    const reportIds = new Set()

    for (let i = 0; i < fornecedores.length; i++) {
      const f = fornecedores[i]
      const forid = String(f?.forid || '').trim()
      if (!forid) continue

      reportIds.add(forid)
      const statusRel = f.desativadoNoSistema ? 'inactive' : 'active'

      _emitirBancoSync('banco-sync-status', { stage: 'fornecedor', index: i + 1, total: fornecedores.length, forid })
      _logBancoSyncFor(forid, `inicio (${i + 1}/${fornecedores.length}) relatorio=${statusRel}`)
      _logBancoSyncFor(forid, `STATUS_FONTE relatorio=${statusRel}`)

      const rec = _bancoSyncStateFornecedor(state, forid)
      if (rec) {
        rec.lastSeenAt = Date.now()
        rec.lastLabel = String(f.label || '')
        rec.lastReportStatus = statusRel
        if (statusRel === 'active') {
          rec.consecutiveInactive = 0
          rec.consecutiveMissing = 0
        } else {
          rec.consecutiveInactive = (Number(rec.consecutiveInactive || 0) || 0) + 1
          rec.consecutiveMissing = 0
        }
        stateAlterado = true
      }

      let fezRequest = false

      try {
        if (statusRel === 'active') {
          const clinica = clinicaById.get(forid)
          if (clinica) _bancoSyncAplicarAtivoClinicaSePreciso(clinica, forid, true, resumo)

          fezRequest = true
          const local = await _bancoSyncProcessarFornecedor(work, forid, { label: f.label }, resumo)
          resumo.fornecedoresOk++
          _logBancoSyncFor(forid, `fim ok: itens=${local?.itensTotal ?? 0} novos=${local?.vinculosNovos ?? 0} precos_atualizados=${local?.precosAtualizados ?? 0} suspensos=${local?.itensSuspensos ?? 0} reativados=${local?.itensReativados ?? 0} removidos=${local?.vinculosRemovidos ?? 0}`)
        } else {
          const cons = rec ? rec.consecutiveInactive : 0
          _logBancoSyncFor(forid, `PENDENTE_INATIVAR consecutiveInactive=${cons}/2`)

          const clinica = clinicaById.get(forid)
          const jaInativaNoBanco = clinica ? (clinica.ativo === false) : false
          if (!jaInativaNoBanco && cons >= 2) {
            fezRequest = true
            const conf = await _bancoSyncConfirmacaoSecundariaInativo(forid)
            _logBancoSyncFor(forid, `CONFIRMACAO_INATIVO confirmado=${conf.confirmado} fonte=${conf.fonte} getdata=${JSON.stringify(conf.getdata)} editar=${JSON.stringify(conf.editar)}`)
            if (conf.confirmado) {
              if (clinica) _bancoSyncAplicarAtivoClinicaSePreciso(clinica, forid, false, resumo)
            } else {
              _logBancoSyncFor(forid, 'INATIVO NAO CONFIRMADO: mantendo estado atual no banco')
            }
          }

          resumo.fornecedoresOk++
          _logBancoSyncFor(forid, 'fim ok: itens=0 novos=0 precos_atualizados=0 suspensos=0 reativados=0 removidos=0')
        }
      } catch (err) {
        resumo.fornecedoresErro++
        _emitirBancoSync('banco-sync-status', { stage: 'fornecedor_erro', forid, error: err.message })
        _logBancoSyncFor(forid, `ERRO: ${err.message}`)
        if (!global.phpsessid) throw err
      }

      if (fezRequest && i < fornecedores.length - 1) await _sleep(BANCO_SYNC_DELAY_MS)
    }

    // Caso C: forid que existe no banco mas nao aparece no relatorio => missing (2 ciclos + confirmacao secundaria)
    for (const c of (Array.isArray(work.clinicas) ? work.clinicas : [])) {
      const forid = String(c?.id || '').trim()
      if (!forid) continue
      if (reportIds.has(forid)) continue

      _logBancoSyncFor(forid, 'STATUS_FONTE relatorio=missing')
      const rec = _bancoSyncStateFornecedor(state, forid)
      if (!rec) continue

      rec.lastReportStatus = 'missing'
      rec.consecutiveMissing = (Number(rec.consecutiveMissing || 0) || 0) + 1
      rec.consecutiveInactive = 0
      if (!rec.lastLabel) rec.lastLabel = String(c?.nome || '')
      stateAlterado = true

      _logBancoSyncFor(forid, `PENDENTE_INATIVAR (missing) consecutiveMissing=${rec.consecutiveMissing}/2`)

      const jaInativaNoBanco = (c.ativo === false)
      if (!jaInativaNoBanco && rec.consecutiveMissing >= 2) {
        const conf = await _bancoSyncConfirmacaoSecundariaInativo(forid)
        _logBancoSyncFor(forid, `CONFIRMACAO_INATIVO (missing) confirmado=${conf.confirmado} fonte=${conf.fonte} getdata=${JSON.stringify(conf.getdata)} editar=${JSON.stringify(conf.editar)}`)
        if (conf.confirmado) {
          _bancoSyncAplicarAtivoClinicaSePreciso(c, forid, false, resumo)
        } else {
          _logBancoSyncFor(forid, 'INATIVO NAO CONFIRMADO (missing): mantendo estado atual no banco')
        }
        await _sleep(BANCO_SYNC_DELAY_MS)
      }
    }

    const hashDepois = _calcularHashBanco(work)
    const mudou = (hashAntes && hashDepois) ? (hashAntes !== hashDepois) : true

    // Segurança: se houver erros por fornecedor, não aplicamos a migração (evita banco incompleto).
    if (resumo.fornecedoresErro > 0) {
      _emitirBancoSync('banco-sync-status', { stage: 'abortado_por_erros', resumo, finishedAt: Date.now() })
      _logBancoSync(`ABORTADO por erros: fornecedoresErro=${resumo.fornecedoresErro}`)
      _bancoSyncUltimoFimMs = Date.now()
      return { ok: false, reason: 'erros_no_sync', resumo }
    }

    if (mudou) {
      _emitirBancoSync('banco-sync-bloqueio', { stage: 'aplicando', resumo })
      _logBancoSync(`APLICANDO migracao: clinicasNovas=${resumo.clinicasNovas} precosAtualizados=${resumo.precosAtualizados} vinculosNovos=${resumo.vinculosNovos} removidos=${resumo.vinculosRemovidos}`)
      _salvarBancoCompleto(caminho, work)
      _bancoSyncUltimoResumo = resumo
      _emitirBancoSync('banco-sync-atualizado', { resumo, finishedAt: Date.now() })
      _logBancoSync('MIGRACAO aplicada com sucesso')
    } else {
      _emitirBancoSync('banco-sync-status', { stage: 'sem_mudancas', finishedAt: Date.now() })
      _logBancoSync('SEM mudancas detectadas')
    }

    _bancoSyncUltimoFimMs = Date.now()
    _logBancoSync(`FIM sync duracaoMs=${Date.now() - startedAt}`)
    return { ok: true, resumo, duracaoMs: Date.now() - startedAt }
  } finally {
    if (state && stateAlterado) {
      try {
        _salvarBancoSyncState(state)
        _logBancoSync(`STATE salvo: ${BANCO_SYNC_STATE_PATH}`)
      } catch (err) {
        console.warn('[BancoSync] Falha ao salvar state:', err.message)
      }
    }
    _bancoSyncRodando = false
  }
}

function _bancoSyncTentarIniciar(motivo) {
  // Evita start em loop (ex.: vários sessao-ok seguidos).
  const agora = Date.now()
  if (_bancoSyncRodando) return
  if (agora - _bancoSyncUltimoFimMs < 5 * 60 * 1000) return
  _bancoSyncRodar({ motivo }).catch(err => {
    _emitirBancoSync('banco-sync-status', { stage: 'erro', motivo, error: err.message })
  })
}

function _carregarMapaTiposBancoSimples() {
  try {
    const caminho = path.join(__dirname, 'public', 'banco.json')
    const raw = JSON.parse(fs.readFileSync(caminho, 'utf-8'))
    const mapa = new Map()
    for (const c of (Array.isArray(raw?.clinicas) ? raw.clinicas : [])) {
      const id = String(c?.id || '').trim()
      const tipo = String(c?.tipo || '').trim()
      if (!id || !tipo) continue
      mapa.set(id, tipo)
    }
    return mapa
  } catch {
    return new Map()
  }
}

function _inferirTipoClinica(nome) {
  const up = String(nome || '').toUpperCase()
  return up.includes('LABORAT') ? 'lab' : 'clinica'
}

function _normalizarTiposNoBanco(banco) {
  const base = banco && typeof banco === 'object' ? banco : {}
  if (!Array.isArray(base.clinicas)) base.clinicas = []
  if (!Array.isArray(base.exames)) base.exames = []

  const mapaTipos = _carregarMapaTiposBancoSimples()
  let alterado = false

  for (const c of base.clinicas) {
    if (!c || typeof c !== 'object') continue
    const id = String(c.id || '').trim()
    const tipoAtual = String(c.tipo || '').trim()
    if (tipoAtual === 'lab' || tipoAtual === 'clinica') continue
    const tipo = mapaTipos.get(id) || _inferirTipoClinica(c.nome)
    c.tipo = tipo
    alterado = true
  }

  return { banco: base, alterado }
}

function _ymdHojeLocal() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function _timestampBackupLocal() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${y}${m}${day}-${hh}${mm}${ss}`
}

function _garantirBackupBancoSePreciso(caminho) {
  const hoje = _ymdHojeLocal()
  if (_bancoBackupYmd === hoje) return null
  const backupPath = `${caminho}.bak-${_timestampBackupLocal()}`
  try {
    fs.copyFileSync(caminho, backupPath)
    _bancoBackupYmd = hoje
    console.log('[Banco] Backup criado:', backupPath)
    return backupPath
  } catch (err) {
    console.warn('[Banco] Falha ao criar backup:', err.message)
    return null
  }
}

function _escreverJsonAtomico(caminho, objeto) {
  const dir = path.dirname(caminho)
  const base = path.basename(caminho)
  const tmp = path.join(dir, `${base}.tmp`)
  const old = path.join(dir, `${base}.old`)

  const conteudo = JSON.stringify(objeto, null, 2)
  fs.writeFileSync(tmp, conteudo, 'utf-8')

  JSON.parse(fs.readFileSync(tmp, 'utf-8'))

  try { if (fs.existsSync(old)) fs.unlinkSync(old) } catch {}

  if (fs.existsSync(caminho)) {
    fs.renameSync(caminho, old)
  }
  fs.renameSync(tmp, caminho)
  try { if (fs.existsSync(old)) fs.unlinkSync(old) } catch {}
}

function _carregarBancoCompleto() {
  const caminho = resolverCaminhoBanco()
  const raw = JSON.parse(fs.readFileSync(caminho, 'utf-8'))
  const { banco } = _normalizarTiposNoBanco(raw)
  return { caminho, banco }
}

function _salvarBancoCompleto(caminho, banco) {
  const normalizado = _normalizarTiposNoBanco(banco)
  _garantirBackupBancoSePreciso(caminho)
  _escreverJsonAtomico(caminho, normalizado.banco)
  return { normalizouTipos: normalizado.alterado }
}

function _normalizarFornecedorGetdata(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const enderecos = Array.isArray(src.enderecos) ? src.enderecos : []
  return {
    id: String(src.id || '').trim(),
    nome: String(src.nome || '').trim(),
    telefone: String(src.telefone || '').trim(),
    celular: String(src.celular || '').trim(),
    email: String(src.email || '').trim(),
    razao: String(src.razao || '').trim(),
    cpfcnpj: String(src.cpfcnpj || '').trim(),
    cnes: String(src.cnes || '').trim(),
    mtdopgto: String(src.mtdopgto || '').trim(),
    habilitado: (src.habilitado !== undefined ? src.habilitado : (src.enabled !== undefined ? src.enabled : null)),
    trash: (src.trash !== undefined ? src.trash : '0'),
    irrfisento: (src.irrfisento !== undefined ? src.irrfisento : '0'),
    irrfaliquota: (src.irrfaliquota !== undefined ? src.irrfaliquota : '0'),
    imagem: (src.imagem !== undefined ? src.imagem : null),
    cidade: (src.cidade !== undefined ? src.cidade : ''),
    horariolivre: (src.horariolivre !== undefined ? src.horariolivre : '0'),
    emaillisten: (src.emaillisten !== undefined ? src.emaillisten : ''),
    agendamentoFullAccess: (src.agendamentoFullAccess !== undefined ? src.agendamentoFullAccess : '0'),
    email_contabil: (src.email_contabil !== undefined ? src.email_contabil : ''),
    contrato: (src.contrato !== undefined ? src.contrato : ''),
    created_at: (src.created_at !== undefined ? src.created_at : ''),
    tempo_altera_guia: (src.tempo_altera_guia !== undefined ? src.tempo_altera_guia : '0'),
    troca_data: (src.troca_data !== undefined ? src.troca_data : 0),
    simples: (src.simples !== undefined ? src.simples : '0'),
    logradouro: (src.logradouro !== undefined ? src.logradouro : ''),
    numero: (src.numero !== undefined ? src.numero : ''),
    bairro: (src.bairro !== undefined ? src.bairro : ''),
    complemento: (src.complemento !== undefined ? src.complemento : ''),
    cep: (src.cep !== undefined ? src.cep : ''),
    show_vagas: (src.show_vagas !== undefined ? src.show_vagas : '0'),
    feedback: (src.feedback !== undefined ? src.feedback : '0'),
    precancel: (src.precancel !== undefined ? src.precancel : '0'),
    allow_qtde_cfm: (src.allow_qtde_cfm !== undefined ? src.allow_qtde_cfm : '0'),
    enderecos: enderecos.map(e => ({
      id: String(e?.id || '').trim(),
      logradouro: String(e?.logradouro || '').trim(),
      complemento: (e?.complemento === null ? null : String(e?.complemento || '').trim()),
      bairro: String(e?.bairro || '').trim(),
      cep: String(e?.cep || '').trim(),
      cidade: String(e?.cidade || '').trim(),
    })).filter(e => e.id),
  }
}

function _normalizarEnderecoParaComparacao(e) {
  const src = e && typeof e === 'object' ? e : {}
  return {
    id: String(src.id || '').trim(),
    logradouro: String(src.logradouro || '').replace(/\s+/g, ' ').trim(),
    complemento: (src.complemento === null ? null : String(src.complemento || '').replace(/\s+/g, ' ').trim()),
    bairro: String(src.bairro || '').replace(/\s+/g, ' ').trim(),
    cep: String(src.cep || '').replace(/\s+/g, ' ').trim(),
    cidade: String(src.cidade || '').replace(/\s+/g, ' ').trim(),
  }
}

function _enderecosSaoIguais(aList, bList) {
  const a = Array.isArray(aList) ? aList.map(_normalizarEnderecoParaComparacao) : []
  const b = Array.isArray(bList) ? bList.map(_normalizarEnderecoParaComparacao) : []
  if (a.length !== b.length) return false
  const byIdA = new Map(a.map(x => [x.id, x]))
  const byIdB = new Map(b.map(x => [x.id, x]))
  if (byIdA.size !== byIdB.size) return false
  for (const [id, ea] of byIdA.entries()) {
    const eb = byIdB.get(id)
    if (!eb) return false
    if (ea.logradouro !== eb.logradouro) return false
    if (ea.complemento !== eb.complemento) return false
    if (ea.bairro !== eb.bairro) return false
    if (ea.cep !== eb.cep) return false
    if (ea.cidade !== eb.cidade) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────
// Cópia inicial de arquivos de dados para userData
// ─────────────────────────────────────────────────────────────
function copiarArquivosIniciais() {
  const caminho = resolverCaminhoBanco()
  console.log(`[Boot] Banco fixo selecionado: ${caminho}`)

  // Garante compatibilidade com o renderer (ele filtra por clinica.tipo).
  // Persistimos apenas no banco-completo, usando banco.json apenas como referencia.
  try {
    const raw = JSON.parse(fs.readFileSync(caminho, 'utf-8'))
    const { banco, alterado } = _normalizarTiposNoBanco(raw)
    if (alterado) {
      _garantirBackupBancoSePreciso(caminho)
      _escreverJsonAtomico(caminho, banco)
      console.log('[Boot] Banco normalizado: campo "tipo" persistido em clinicas')
    }
  } catch (err) {
    console.warn('[Boot] Falha ao normalizar banco no boot:', err.message)
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers internos (antes em server.js)
// ─────────────────────────────────────────────────────────────

function normalizarCelular(celular) {
  if (!celular) return null
  const digits = celular.replace(/\D/g, '')
  if (!digits) return null
  let numero
  if (digits.startsWith('55')) {
    numero = digits
  } else if (digits.length === 11 || digits.length === 10) {
    numero = `55${digits}`
  } else {
    return null
  }
  if (numero.length === 13 && numero[4] === '9') {
    numero = numero.slice(0, 4) + numero.slice(5)
  }
  if (numero.length !== 12) return null
  return numero
}

const MSG_SEPARADOR = '\u2500'.repeat(18)
const MSG_BULLET = '\u2022'
const MSG_TRACO = '\u2014'

function montarMensagemClinica({ nomePaciente, nomeClinica, enderecoClinica, data, horario, exames, numGuia, mtdopgto, tipoCard }) {
  const total   = exames.reduce((acc, e) => acc + (e.valor * (e.qtde ?? 1)), 0)
  const moeda   = v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`
  const [a, m, d] = data.split('-')
  const dataFmt = `${d}/${m}/${a}`

  const linhas = [
    `*Agendamento confirmado*`,
    MSG_SEPARADOR,
    `Paciente: ${nomePaciente}`,
    MSG_SEPARADOR,
    `Clinica: ${nomeClinica}`,
    MSG_SEPARADOR,
    `Endereco: ${enderecoClinica || 'nao informado'}`,
    MSG_SEPARADOR,
  ]

  if (tipoCard === 'lab') {
    linhas.push(
      `*GUIA VÁLIDA PARA TODAS AS UNIDADES DO ${nomeClinica.toUpperCase()}*`,
      MSG_SEPARADOR,
    )
  }

  linhas.push(
    `Data: ${dataFmt}`,
    MSG_SEPARADOR,
    `Horario: ${horario}`,
    MSG_SEPARADOR,
    `Valor total: ${moeda(total)}`,
    MSG_SEPARADOR,
  )

  if (mtdopgto) {
    linhas.push(`Forma de pagamento: ${mtdopgto}`, MSG_SEPARADOR)
  }

  linhas.push(`Guia: ${numGuia}`)
  return linhas.join('\n')
}

function formatarDataBr(dataIso) {
  const partes = String(dataIso || '').split('-')
  if (partes.length !== 3) return String(dataIso || '')
  return `${partes[2]}/${partes[1]}/${partes[0]}`
}

function montarMensagemFornecedor({
  nomePaciente,
  cpfPaciente,
  datanascPaciente,
  celularPaciente,
  data,
  horario,
  examesLinhas,
  totalExames,
  numGuia
}) {
  const moeda = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`
  const linhasExames = examesLinhas.length
    ? examesLinhas.map(item => `  ${MSG_BULLET} ${item.nome} ${MSG_TRACO} ${moeda(item.valor)}`).join('\n')
    : `  ${MSG_BULLET} (sem exames)`

  return [
    'Novo agendamento',
    MSG_SEPARADOR,
    `Paciente: ${nomePaciente || ''}`,
    MSG_SEPARADOR,
    `CPF: ${cpfPaciente || 'nao informado'}`,
    MSG_SEPARADOR,
    `Nasc.: ${datanascPaciente ? formatarDataBr(datanascPaciente) : 'nao informado'}`,
    MSG_SEPARADOR,
    `Celular: ${celularPaciente || 'nao informado'}`,
    MSG_SEPARADOR,
    `Data: ${formatarDataBr(data)}`,
    MSG_SEPARADOR,
    `Horario: ${horario || ''}`,
    MSG_SEPARADOR,
    `Exames:\n${linhasExames}`,
    MSG_SEPARADOR,
    `Valor total: ${moeda(totalExames)}`,
    MSG_SEPARADOR,
    `Guia: ${numGuia || ''}`
  ].join('\n')
}

function carregarContatosFornecedores() {
  if (!fs.existsSync(CONTATOS_FORNECEDORES_PATH)) {
    let dadosIniciais = { fornecedores: {} }
    if (fs.existsSync(CONTATOS_FORNECEDORES_PATH_LEGACY)) {
      try {
        const legado = JSON.parse(fs.readFileSync(CONTATOS_FORNECEDORES_PATH_LEGACY, 'utf-8'))
        if (legado && typeof legado === 'object') dadosIniciais = legado
        console.log('[Contatos] Migrando base legada de contatos para userData')
      } catch (err) {
        console.warn(`[Contatos] Falha ao ler base legada: ${err.message}`)
      }
    }
    const complementoInicial = completarContatosComTelefonesDoBanco(dadosIniciais)
    salvarContatosFornecedores(complementoInicial.contatos)
    if (complementoInicial.alterado) {
      console.log(`[Contatos] Telefones migrados do banco para contatos: +${complementoInicial.inseridos} (ignorados: ${complementoInicial.ignorados})`)
    }
    return complementoInicial.contatos
  }
  let dados
  try {
    dados = JSON.parse(fs.readFileSync(CONTATOS_FORNECEDORES_PATH, 'utf-8'))
  } catch {
    dados = {}
  }
  if (!dados || typeof dados !== 'object') dados = {}
  if (!dados.fornecedores || typeof dados.fornecedores !== 'object') {
    dados.fornecedores = {}
  }
  const complemento = completarContatosComTelefonesDoBanco(dados)
  if (complemento.alterado) {
    try {
      salvarContatosFornecedores(complemento.contatos)
      console.log(`[Contatos] Telefones migrados do banco para contatos: +${complemento.inseridos} (ignorados: ${complemento.ignorados})`)
    } catch (err) {
      console.warn(`[Contatos] Falha ao salvar complemento de telefones: ${err.message}`)
    }
  }
  return complemento.contatos
}

function salvarContatosFornecedores(dados) {
  const payload = dados && typeof dados === 'object' ? dados : { fornecedores: {} }
  if (!payload.fornecedores || typeof payload.fornecedores !== 'object') payload.fornecedores = {}
  fs.mkdirSync(path.dirname(CONTATOS_FORNECEDORES_PATH), { recursive: true })
  const caminhoTmp = `${CONTATOS_FORNECEDORES_PATH}.tmp`
  fs.writeFileSync(caminhoTmp, JSON.stringify(payload, null, 2), 'utf-8')
  fs.renameSync(caminhoTmp, CONTATOS_FORNECEDORES_PATH)
}

function extrairWhatsappUnico(valor) {
  if (Array.isArray(valor)) {
    for (const item of valor) {
      const numero = normalizarCelular(String(item || ''))
      if (numero) return numero
    }
    return null
  }
  return normalizarCelular(String(valor || ''))
}

function normalizarContatosFornecedores(contatos = {}) {
  const base = contatos && typeof contatos === 'object' ? contatos : {}
  if (!base.fornecedores || typeof base.fornecedores !== 'object') base.fornecedores = {}
  let alterado = false
  for (const [forid, mapaEndereco] of Object.entries(base.fornecedores)) {
    if (!mapaEndereco || typeof mapaEndereco !== 'object') {
      delete base.fornecedores[forid]
      alterado = true
      continue
    }
    for (const [pred, registro] of Object.entries(mapaEndereco)) {
      const contato = extrairWhatsappUnico(registro?.whatsapp ?? registro?.whatsapps)
      if (!contato) {
        delete mapaEndereco[pred]
        alterado = true
      } else if (!registro || registro.whatsapp !== contato || Array.isArray(registro.whatsapps)) {
        mapaEndereco[pred] = { whatsapp: contato }
        alterado = true
      }
    }
    if (!Object.keys(mapaEndereco).length) {
      delete base.fornecedores[forid]
      alterado = true
    }
  }
  return { contatos: base, alterado }
}

function obterWhatsappFornecedor(contatos, forid, pred) {
  const foridKey = String(forid || '').trim()
  const predKey = String(pred || '').trim()
  if (!foridKey || !predKey) return null
  const registro = contatos?.fornecedores?.[foridKey]?.[predKey]
  return extrairWhatsappUnico(registro?.whatsapp ?? registro?.whatsapps)
}

function completarContatosComTelefonesDoBanco(contatos = {}) {
  const base = contatos && typeof contatos === 'object' ? contatos : {}
  if (!base.fornecedores || typeof base.fornecedores !== 'object') base.fornecedores = {}

  let alterado = false
  let inseridos = 0
  let ignorados = 0
  let bancoSimples
  let bancoCompleto = null

  try {
    const caminhoBancoSimples = path.join(__dirname, 'public', 'banco.json')
    bancoSimples = JSON.parse(fs.readFileSync(caminhoBancoSimples, 'utf-8'))
  } catch (err) {
    console.warn(`[Contatos] Falha ao carregar banco simples para completar telefones: ${err.message}`)
    return { contatos: base, alterado: false, inseridos: 0, ignorados: 0 }
  }

  try {
    bancoCompleto = JSON.parse(fs.readFileSync(resolverCaminhoBanco(), 'utf-8'))
  } catch (err) {
    console.warn(`[Contatos] Falha ao carregar banco completo para mapear primeiro endereco: ${err.message}`)
  }

  const mapaPredPrimeiroEndereco = new Map()
  for (const clinica of (Array.isArray(bancoCompleto?.clinicas) ? bancoCompleto.clinicas : [])) {
    const forid = String(clinica?.id || '').trim()
    if (!forid) continue
    const pred = String(clinica?.enderecos?.[0]?.id || '').trim()
    if (!pred) continue
    if (!mapaPredPrimeiroEndereco.has(forid)) mapaPredPrimeiroEndereco.set(forid, pred)
  }

  const foridsPermitidos = new Set(
    (Array.isArray(bancoSimples?.clinicas) ? bancoSimples.clinicas : [])
      .map(c => String(c?.id || '').trim())
      .filter(Boolean)
  )

  // Remove fornecedores fora do escopo do banco simples
  for (const foridExistente of Object.keys(base.fornecedores)) {
    if (foridsPermitidos.has(String(foridExistente))) continue
    delete base.fornecedores[foridExistente]
    alterado = true
  }

  for (const clinica of (Array.isArray(bancoSimples?.clinicas) ? bancoSimples.clinicas : [])) {
    const forid = String(clinica?.id || '').trim()
    const pred = String(mapaPredPrimeiroEndereco.get(forid) || forid).trim()
    const whatsapp = normalizarCelular(String(clinica?.telefone || ''))

    if (!forid || !pred || !whatsapp) {
      ignorados++
      continue
    }

    if (!base.fornecedores[forid] || typeof base.fornecedores[forid] !== 'object') {
      base.fornecedores[forid] = {}
      alterado = true
    }

    const atual = extrairWhatsappUnico(
      base.fornecedores[forid]?.[pred]?.whatsapp ?? base.fornecedores[forid]?.[pred]?.whatsapps
    )
    if (atual) continue

    base.fornecedores[forid][pred] = { whatsapp }
    alterado = true
    inseridos++
  }

  return { contatos: base, alterado, inseridos, ignorados }
}

function _criarStoreTokensVazio() {
  return { tokens: {} }
}

function _normalizarStoreTokens(raw) {
  const base = raw && typeof raw === 'object' ? raw : {}
  let alterado = false
  if (!base.tokens || typeof base.tokens !== 'object' || Array.isArray(base.tokens)) {
    base.tokens = {}
    alterado = true
  }

  const normalizado = {}
  for (const [tokenKey, registroRaw] of Object.entries(base.tokens)) {
    if (!registroRaw || typeof registroRaw !== 'object') {
      alterado = true
      continue
    }
    const token = String(registroRaw.token || tokenKey || '').trim().toUpperCase()
    if (!token) {
      alterado = true
      continue
    }
    const registro = {
      token,
      scope: String(registroRaw.scope || ORCAMENTO_TOKEN_SCOPE),
      snapshot: registroRaw.snapshot,
      createdAt: String(registroRaw.createdAt || ''),
      expiresAt: String(registroRaw.expiresAt || ''),
      origin: String(registroRaw.origin || 'local'),
      createdByRole: String(registroRaw.createdByRole || 'none')
    }
    normalizado[token] = registro
    if (token !== tokenKey || registroRaw.token !== token) alterado = true
  }

  base.tokens = normalizado
  return { store: base, alterado }
}

function _salvarStoreTokens(store) {
  const payload = store && typeof store === 'object' ? store : _criarStoreTokensVazio()
  const dir = path.dirname(ORCAMENTO_TOKENS_PATH)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${ORCAMENTO_TOKENS_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  fs.renameSync(tmp, ORCAMENTO_TOKENS_PATH)
}

function _lerStoreTokensSemLimpeza() {
  if (!fs.existsSync(ORCAMENTO_TOKENS_PATH)) {
    const vazio = _criarStoreTokensVazio()
    _salvarStoreTokens(vazio)
    return vazio
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(ORCAMENTO_TOKENS_PATH, 'utf-8'))
  } catch {
    parsed = _criarStoreTokensVazio()
  }
  const normalizado = _normalizarStoreTokens(parsed)
  if (normalizado.alterado) _salvarStoreTokens(normalizado.store)
  return normalizado.store
}

function _isTokenExpirado(registro, nowMs = Date.now()) {
  const expMs = Date.parse(String(registro?.expiresAt || ''))
  if (!Number.isFinite(expMs)) return true
  return expMs <= nowMs
}

function _limparTokensExpiradosStore(store, nowMs = Date.now()) {
  if (!store || typeof store !== 'object' || !store.tokens || typeof store.tokens !== 'object') return false
  let alterado = false
  for (const [token, registro] of Object.entries(store.tokens)) {
    if (_isTokenExpirado(registro, nowMs)) {
      delete store.tokens[token]
      alterado = true
    }
  }
  return alterado
}

function _carregarStoreTokensComLimpeza() {
  const store = _lerStoreTokensSemLimpeza()
  const alterado = _limparTokensExpiradosStore(store)
  if (alterado) _salvarStoreTokens(store)
  return store
}

function _normalizarPrestadoresSnapshot(prestadores) {
  const lista = Array.isArray(prestadores) ? prestadores : []
  const saida = []
  const vistos = new Set()
  for (const item of lista) {
    const id = String(item?.id ?? item?.value ?? '').trim()
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    const label = String(item?.label || '').trim()
    saida.push({ id, label })
  }
  return saida
}

function _normalizarExamesSnapshot(exames) {
  const lista = Array.isArray(exames) ? exames : []
  const saida = []
  const vistos = new Set()
  for (const item of lista) {
    const value = String(item || '').trim()
    if (!value || vistos.has(value)) continue
    vistos.add(value)
    saida.push(value)
  }
  return saida
}

function _normalizarExamesPorGrupoSnapshot(gruposRaw) {
  const grupos = gruposRaw && typeof gruposRaw === 'object' ? gruposRaw : {}
  return {
    lab: _normalizarExamesSnapshot(grupos.lab),
    clinica: _normalizarExamesSnapshot(grupos.clinica)
  }
}

function _sanitizarSnapshotOrcamento(snapshot, { exigirExames = true } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null

  const examesOrcPorGrupo = _normalizarExamesPorGrupoSnapshot(snapshot.examesOrcPorGrupo)
  let examesOrc = _normalizarExamesSnapshot(snapshot.examesOrc)
  if (!examesOrc.length && (examesOrcPorGrupo.lab.length || examesOrcPorGrupo.clinica.length)) {
    examesOrc = _normalizarExamesSnapshot([
      ...examesOrcPorGrupo.lab,
      ...examesOrcPorGrupo.clinica
    ])
  }
  if (exigirExames && examesOrc.length === 0) return null

  const createdAtEntrada = String(snapshot.createdAt || '').trim()
  const createdAtValido = Date.parse(createdAtEntrada)

  return {
    versao: String(snapshot.versao || '1'),
    nomePaciente: String(snapshot.nomePaciente || '').trim(),
    pacienteCodigo: String(snapshot.pacienteCodigo || '').trim(),
    municipioSelecionado: String(snapshot.municipioSelecionado || '__todos__').trim() || '__todos__',
    prestadoresOrc: _normalizarPrestadoresSnapshot(snapshot.prestadoresOrc),
    examesOrc,
    examesOrcPorGrupo,
    createdAt: Number.isFinite(createdAtValido) ? new Date(createdAtValido).toISOString() : new Date().toISOString()
  }
}

function _gerarTokenOrcamento(prefix) {
  const sufixo = crypto.randomBytes(8).toString('hex').toUpperCase()
  return `${prefix}-${sufixo}`
}

function _criarTokenOrcamentoLocal({
  snapshot,
  prefix = 'LORC',
  origin = 'local',
  createdByRole = 'none'
}) {
  const store = _carregarStoreTokensComLimpeza()
  let token = _gerarTokenOrcamento(prefix)
  while (store.tokens[token]) {
    token = _gerarTokenOrcamento(prefix)
  }

  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + ORCAMENTO_TOKEN_TTL_MS).toISOString()
  const registro = {
    token,
    scope: ORCAMENTO_TOKEN_SCOPE,
    snapshot,
    createdAt,
    expiresAt,
    origin: String(origin || 'local'),
    createdByRole: String(createdByRole || 'none')
  }
  store.tokens[token] = registro
  _salvarStoreTokens(store)
  return registro
}

function _recuperarTokenOrcamentoLocal(tokenInformado) {
  const token = String(tokenInformado || '').trim().toUpperCase()
  if (!token) throw new Error('token_invalido')

  const store = _lerStoreTokensSemLimpeza()
  const registro = store.tokens[token]
  if (!registro) {
    const alterado = _limparTokensExpiradosStore(store)
    if (alterado) _salvarStoreTokens(store)
    throw new Error('token_invalido')
  }

  const now = Date.now()
  if (_isTokenExpirado(registro, now)) {
    delete store.tokens[token]
    _limparTokensExpiradosStore(store, now)
    _salvarStoreTokens(store)
    throw new Error('token_expirado')
  }

  const snapshot = _sanitizarSnapshotOrcamento(registro.snapshot, { exigirExames: true })
  if (!snapshot) {
    delete store.tokens[token]
    _salvarStoreTokens(store)
    throw new Error('token_corrompido')
  }

  const alterado = _limparTokensExpiradosStore(store, now)
  if (alterado) _salvarStoreTokens(store)

  return {
    ...registro,
    snapshot
  }
}

function _resolverRoteamentoTokenOrcamento() {
  const status = getCanalStatusAtual()
  const role = String(status?.role || 'none')
  const state = String(status?.state || 'disconnected')

  if (role === 'host') {
    return {
      target: 'host-local',
      prefix: 'ORC',
      origin: 'host',
      createdByRole: 'host'
    }
  }

  if (role === 'client' && state === 'connected') {
    return {
      target: 'host-remote',
      prefix: 'ORC',
      origin: 'host',
      createdByRole: 'client'
    }
  }

  if (role === 'client') {
    return {
      target: 'client-local',
      prefix: 'LORC',
      origin: 'client-local',
      createdByRole: 'client'
    }
  }

  return {
    target: 'solo-local',
    prefix: 'LORC',
    origin: 'solo-local',
    createdByRole: 'none'
  }
}

async function _criarTokenOrcamento(snapshotPayload = {}) {
  const snapshot = _sanitizarSnapshotOrcamento(snapshotPayload, { exigirExames: true })
  if (!snapshot) throw new Error('snapshot_invalido')

  const rota = _resolverRoteamentoTokenOrcamento()
  if (rota.target === 'host-remote') {
    if (!_canalService || typeof _canalService.sendHostJob !== 'function') {
      throw new Error('canal_indisponivel_para_token')
    }
    const ack = await _canalService.sendHostJob('orc_token_create', {
      snapshot,
      createdByRole: 'client'
    })
    if (!ack?.ok) throw new Error(String(ack?.error || 'falha_host_token_create'))
    return {
      ok: true,
      token: String(ack.token || ''),
      expiresAt: String(ack.expiresAt || ''),
      origin: String(ack.origin || 'host'),
      createdByRole: String(ack.createdByRole || 'host')
    }
  }

  const registro = _criarTokenOrcamentoLocal({
    snapshot,
    prefix: rota.prefix,
    origin: rota.origin,
    createdByRole: rota.createdByRole
  })

  return {
    ok: true,
    token: registro.token,
    expiresAt: registro.expiresAt,
    origin: registro.origin,
    createdByRole: registro.createdByRole
  }
}

async function _recuperarTokenOrcamento(tokenInformado) {
  const token = String(tokenInformado || '').trim().toUpperCase()
  if (!token) throw new Error('token_invalido')

  const rota = _resolverRoteamentoTokenOrcamento()
  if (rota.target === 'host-remote') {
    if (!_canalService || typeof _canalService.sendHostJob !== 'function') {
      throw new Error('canal_indisponivel_para_token')
    }
    const ack = await _canalService.sendHostJob('orc_token_fetch', { token })
    if (!ack?.ok) throw new Error(String(ack?.error || 'token_invalido'))
    const snapshot = _sanitizarSnapshotOrcamento(ack.snapshot, { exigirExames: true })
    if (!snapshot) throw new Error('token_corrompido')
    return {
      ok: true,
      token: String(ack.token || token),
      expiresAt: String(ack.expiresAt || ''),
      origin: String(ack.origin || 'host'),
      snapshot
    }
  }

  const registro = _recuperarTokenOrcamentoLocal(token)
  return {
    ok: true,
    token: registro.token,
    expiresAt: registro.expiresAt,
    origin: registro.origin,
    snapshot: registro.snapshot
  }
}

async function iniciarWhatsappComGuarda() {
  if (!_iniciarWhatsapp) throw new Error('Modulo de WhatsApp ainda nao inicializado')
  if (_whatsappStartPromise) return _whatsappStartPromise
  _whatsappStartPromise = (async () => {
    try {
      await _iniciarWhatsapp()
    } finally {
      _whatsappStartPromise = null
    }
  })()
  return _whatsappStartPromise
}

function getCanalStatusAtual() {
  if (!_canalService) return null
  try { return _canalService.getStatus() } catch { return null }
}

function clienteCanalAtivo() {
  const status = getCanalStatusAtual()
  return status && status.role === 'client'
}

function clienteCanalConectado() {
  const status = getCanalStatusAtual()
  return status && status.role === 'client' && status.state === 'connected'
}

function canalClienteConfiguradoOuAtivo() {
  const status = getCanalStatusAtual()
  if (status && status.role === 'client') return true
  if (!_canalService) return false
  try {
    const cfg = _canalService.getConfig()
    return String(cfg?.mode || '') === 'client'
  } catch {
    return false
  }
}

async function enviarMensagemWhatsappComDispatcher(numero, mensagem) {
  if (clienteCanalAtivo()) {
    if (!clienteCanalConectado()) {
      const status = getCanalStatusAtual()
      throw new Error(`Canal cliente indisponivel (status: ${status?.state || 'desconhecido'})`)
    }
    const ack = await _canalService.sendWaJob({
      kind: 'texto',
      numero: String(numero || ''),
      mensagem: String(mensagem || '')
    })
    if (!ack?.ok) throw new Error(String(ack?.error || 'falha no envio via host'))
    return { via: 'canal-host' }
  }

  const statusWhatsapp = _obterStatus?.()
  if (statusWhatsapp !== 'conectado') {
    throw new Error(`WhatsApp local desconectado (status: ${statusWhatsapp || 'desconhecido'})`)
  }
  const envio = await _enviarMensagem(numero, mensagem)
  if (envio && envio.sucesso === false) {
    throw new Error(String(envio.erro || 'falha no envio local'))
  }
  return { via: 'local' }
}

async function enviarPdfWhatsappComDispatcher(numero, caminhoArquivo, caption = '') {
  if (clienteCanalAtivo()) {
    if (!clienteCanalConectado()) {
      const status = getCanalStatusAtual()
      throw new Error(`Canal cliente indisponivel (status: ${status?.state || 'desconhecido'})`)
    }
    const pdfBase64 = fs.readFileSync(caminhoArquivo).toString('base64')
    const ack = await _canalService.sendWaJob({
      kind: 'pdf',
      numero: String(numero || ''),
      caption: String(caption || ''),
      fileName: path.basename(caminhoArquivo),
      pdfBase64
    })
    if (!ack?.ok) throw new Error(String(ack?.error || 'falha no envio via host'))
    return { via: 'canal-host' }
  }

  const statusWhatsapp = _obterStatus?.()
  if (statusWhatsapp !== 'conectado') {
    throw new Error(`WhatsApp local desconectado (status: ${statusWhatsapp || 'desconhecido'})`)
  }
  const envio = await _enviarPdf(numero, caminhoArquivo, caption)
  if (envio && envio.sucesso === false) {
    throw new Error(String(envio.erro || 'falha no envio local de pdf'))
  }
  return { via: 'local' }
}

async function executarShutdownGracioso(origem = 'desconhecida') {
  if (_shutdownPromise) return _shutdownPromise

  _shutdownPromise = (async () => {
    console.log(`[Shutdown] Iniciando shutdown gracioso (${origem})`)
    _whatsappStartPromise = null

    if (_canalService) {
      try {
        await _canalService.shutdown()
      } catch (err) {
        console.warn(`[Shutdown] Falha ao encerrar canal (${origem}): ${err.message}`)
      }
    }

    if (!_desligarWhatsappGracioso) return

    const timeoutMs = 2500
    let timeoutHandle = null
    try {
      await Promise.race([
        _desligarWhatsappGracioso(),
        new Promise(resolve => {
          timeoutHandle = setTimeout(resolve, timeoutMs)
        })
      ])
    } catch (err) {
      console.warn(`[Shutdown] Falha no shutdown gracioso do WhatsApp (${origem}): ${err.message}`)
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  })()

  try {
    await _shutdownPromise
  } finally {
    _shutdownPromise = null
  }
}

// ─────────────────────────────────────────────────────────────
// Gerenciamento de cookies
// ─────────────────────────────────────────────────────────────

async function injetarCookieSalvo(win) {
  if (!fs.existsSync(SESSAO_PATH)) return false
  try {
    const { cookies } = JSON.parse(fs.readFileSync(SESSAO_PATH, 'utf-8'))
    if (!cookies?.length) return false
    for (const c of cookies) {
      await win.webContents.session.cookies.set({
        url:   URL_BASE,
        name:  c.name,
        value: c.value,
        path:  '/',
      })
    }
    console.log('[Sessão] Cookie salvo injetado na janela')
    return true
  } catch (err) {
    console.warn(`[Sessão] Falha ao injetar cookie: ${err.message}`)
    return false
  }
}

async function capturarESalvarCookie(win) {
  try {
    // O <webview> sem partition usa session.defaultSession — mesma session da appWindow.
    // Usar electron.session.defaultSession diretamente evita depender de qual `win`
    // é passado e garante que buscamos no lugar certo independentemente do contexto.
    const { session: electronSession } = require('electron')
    const ses     = electronSession.defaultSession
    const cookies = await ses.cookies.get({ url: URL_BASE })
    const php     = cookies.find(c => c.name === 'PHPSESSID')

    if (!php) {
      console.warn('[Sessão] PHPSESSID não encontrado na session após navegação — usuário ainda não fez login ou cookie ainda não foi gravado')
      return null
    }

    fs.writeFileSync(SESSAO_PATH, JSON.stringify({
      cookies: [{ name: 'PHPSESSID', value: php.value }]
    }))

    global.phpsessid = php.value
    console.log('[Sessão] PHPSESSID capturado e salvo')
    return php.value
  } catch (err) {
    console.warn(`[Sessão] Falha ao capturar cookie: ${err.message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Splash screen
// ─────────────────────────────────────────────────────────────

function criarSplash() {
  splashWindow = new BrowserWindow({
    width:           420,
    height:          280,
    frame:           false,
    resizable:       false,
    center:          true,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    backgroundColor: '#1a1f36',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,   // preload.cjs usa require() — incompatível com sandbox padrão (Electron v20+)
    },
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
}

function enviarStatusSplash(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', msg)
  }
}

function fecharSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

// ─────────────────────────────────────────────────────────────
// Janela principal — carrega agendamentos.html diretamente via
// loadFile (sem Express, sem porta TCP)
// ─────────────────────────────────────────────────────────────

function criarAppWindow() {
  appWindow = new BrowserWindow({
    width:           1400,
    height:          860,
    title:           'Agendamentos',
    show:            false,
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,   // preload.cjs usa require() — incompatível com sandbox padrão (Electron v20+)
      webviewTag:       true,
    },
  })

  // Diagnóstico de caminho
  // Usa app.getAppPath() quando empacotado (asar), __dirname em dev
  const basePath      = app.isPackaged ? app.getAppPath() : __dirname
  const htmlPrimario  = path.join(basePath, 'public', 'agendamentos.html')
  const htmlFallback  = path.join(basePath, 'agendamentos.html')
  const htmlExiste1   = fs.existsSync(htmlPrimario)
  const htmlExiste2   = fs.existsSync(htmlFallback)
  const htmlFinal     = htmlExiste1 ? htmlPrimario : (htmlExiste2 ? htmlFallback : null)

  console.log('[Boot] app.isPackaged   =', app.isPackaged)
  console.log('[Boot] basePath         =', basePath)
  console.log('[Boot] HTML primário    =', htmlPrimario, '| existe:', htmlExiste1)
  console.log('[Boot] HTML fallback    =', htmlFallback, '| existe:', htmlExiste2)

  if (!htmlFinal) {
    console.error('[Boot] ERRO CRÍTICO: agendamentos.html não encontrado em nenhum caminho!')
    appWindow.loadURL('data:text/html,<h1 style="font-family:sans-serif;color:red;padding:40px">ERRO: agendamentos.html n&atilde;o encontrado.<br>Reinstale o aplicativo.</h1>')
  } else {
    const htmlNorm = path.normalize(htmlFinal)
    console.log('[Boot] Carregando HTML de:', htmlNorm)
    appWindow.loadFile(htmlNorm).catch(err => {
      console.error('[Boot] ERRO ao carregar HTML:', err)
    })
  }

  appWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[Boot] Falha ao carregar página:', { code, desc, url })
  })

  appWindow.webContents.on('did-start-loading', () => {
    appWindowReady = false
  })

  appWindow.once('ready-to-show', () => {
    appWindow.show()
    fecharSplash()
  })

  appWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      appWindow.hide()
    }
  })

  appWindow.on('closed', () => { appWindow = null })
}

// ─────────────────────────────────────────────────────────────
// IPC — emissão para o renderer
// ─────────────────────────────────────────────────────────────

global.emitirIPC = function(canal, dados) {
  if (appWindow && !appWindow.isDestroyed()) {
    if (canal === 'whatsapp-qr') {
      QRCode.toDataURL(dados, { width: 260, margin: 2 })
        .then(dataUrl => {
          if (!appWindowReady) {
            pendingQr = dataUrl
            return
          }
          appWindow.webContents.send('whatsapp-qr', dataUrl)
        })
        .catch(err => console.warn('[QR] Falha ao gerar imagem:', err.message))
      return
    }
    appWindow.webContents.send(canal, dados)
  }
}

// ─────────────────────────────────────────────────────────────
// IPC — handlers de dados (substituem as rotas Express)
// ─────────────────────────────────────────────────────────────

// GET /banco
ipcMain.handle('get-banco', () => {
  const { banco } = _carregarBancoCompleto()
  return banco
})

// GET /exames?clinicaId=X&tipo=Y
ipcMain.handle('get-exames', (_, { clinicaId, tipo }) => {
  const caminho   = resolverCaminhoBanco()
  const banco     = JSON.parse(fs.readFileSync(caminho, 'utf-8'))
  const cId       = clinicaId ? String(clinicaId) : null
  const resultado = {}

  for (const exame of banco.exames) {
    // filtro de tipo opcional (ex: 'lab' ou 'clinica')
    if (tipo) {
      const clinicaInfo = banco.clinicas.find(c => c.id === cId)
      if (clinicaInfo && clinicaInfo.tipo !== tipo) continue
    }

    const listaClin = Array.isArray(exame?.clinicas) ? exame.clinicas : []
    // Se o vínculo estiver marcado como suspenso no banco (enabled:false), não expõe nos searchboxes.
    const entrada = cId
      ? listaClin.find(c => c.clinica_id === cId && c.enabled !== false)
      : (listaClin.find(c => c.enabled !== false) || listaClin[0])

    if (!entrada) continue

    resultado[exame.nome_parametro] = {
      id:        entrada.id_exame_clinica,
      valor:     entrada.preco,
      nome_real: exame.nome_real
    }
  }

  return resultado
})

// ── Credenciados ───────────────────────────────────────────────
ipcMain.handle('cred-buscar-clinicas', async (_, { term } = {}) => {
  const t = String(term || '').trim()
  if (!t) return []

  const dados = await _acmanagerGetJson({
    action: 'fornecedores/search',
    term: t,
  }, 'cred-buscar-clinicas')

  const arr = Array.isArray(dados) ? dados : []
  return arr
    .map(c => ({
      id: String(c?.id || '').trim(),
      nome: String(c?.nome || '').trim(),
      cidade: String(c?.cidade || '').trim(),
    }))
    .filter(c => c.id && c.nome)
})

ipcMain.handle('cred-buscar-exames', async (_, payload = {}) => {
  const term = String(payload?.term || '').trim()
  const forid = String(payload?.forid || '').trim()
  const credid = String(payload?.credid ?? '0').trim()
  const pritens = String(payload?.pritens ?? '').trim()

  if (!term) return []
  if (!forid) throw new Error('forid obrigatorio')

  const dados = await _acmanagerGetJson({
    action: 'credenciamentos/search',
    term,
    forid,
    credid,
    pritens,
  }, 'cred-buscar-exames')

  const arr = Array.isArray(dados) ? dados : []
  return arr.map(e => ({
    id: String(e?.id || '').trim(),
    forid: String(e?.forid || forid).trim(),
    nome: String(e?.nome || '').trim(),
    valor: String(e?.valor ?? '').trim(),
    enabled: String(e?.enabled ?? '').trim(),
    trash: String(e?.trash ?? '').trim(),
    validade: String(e?.validade ?? '').trim(),
  }))
})

ipcMain.handle('cred-fornecedor-getdata', async (_, { forid } = {}) => {
  const id = String(forid || '').trim()
  if (!id) throw new Error('forid obrigatorio')

  const dados = await _acmanagerGetJson({
    action: 'fornecedores/getdata',
    forid: id,
  }, 'cred-fornecedor-getdata')

  const norm = _normalizarFornecedorGetdata(dados)
  if (!norm.id) throw new Error('Resposta invalida: fornecedor sem id')
  return norm
})

ipcMain.handle('cred-sync-enderecos', async (_, { forid } = {}) => {
  const id = String(forid || '').trim()
  if (!id) throw new Error('forid obrigatorio')

  const { caminho, banco } = _carregarBancoCompleto()
  const clinica = (Array.isArray(banco.clinicas) ? banco.clinicas : []).find(c => String(c?.id || '').trim() === id)
  if (!clinica) throw new Error(`Clinica ${id} nao encontrada no banco`)

  const dados = await _acmanagerGetJson({
    action: 'fornecedores/getdata',
    forid: id,
  }, 'cred-sync-enderecos/getdata')

  const norm = _normalizarFornecedorGetdata(dados)
  const endSistema = Array.isArray(norm.enderecos) ? norm.enderecos : []
  const endBanco = Array.isArray(clinica.enderecos) ? clinica.enderecos : []

  const iguais = _enderecosSaoIguais(endBanco, endSistema)
  if (iguais) {
    return { ok: true, alterado: false, enderecos: endSistema }
  }

  clinica.enderecos = endSistema
  _salvarBancoCompleto(caminho, banco)
  return { ok: true, alterado: true, enderecos: endSistema }
})

ipcMain.handle('cred-aplicar-mudancas', async (_, payload = {}) => {
  const ops = Array.isArray(payload?.ops) ? payload.ops : []
  const resumo = { setClinicaAtivo: 0, updatePreco: 0, addVinculoExame: 0, ignorados: 0 }
  if (!ops.length) return { ok: true, resumo }

  const { caminho, banco } = _carregarBancoCompleto()

  for (const opRaw of ops) {
    const op = opRaw && typeof opRaw === 'object' ? opRaw : {}
    const tipo = String(op.type || '').trim()

    if (tipo === 'setClinicaAtivo') {
      const clinicaId = String(op?.clinica_id || '').trim()
      const ativo = !!op?.ativo
      if (!clinicaId) { resumo.ignorados++; continue }
      const clinica = (Array.isArray(banco.clinicas) ? banco.clinicas : []).find(c => String(c?.id || '').trim() === clinicaId)
      if (!clinica) throw new Error(`Clinica ${clinicaId} nao encontrada no banco`)
      clinica.ativo = ativo
      resumo.setClinicaAtivo++
      continue
    }

    if (tipo === 'updatePreco') {
      const clinicaId = String(op?.clinica_id || '').trim()
      const pid = String(op?.id_exame_clinica || '').trim()
      const preco = _parsePrecoNumero(op?.preco)
      if (!clinicaId || !pid || preco === null) { resumo.ignorados++; continue }

      let atualizado = false
      for (const exame of (Array.isArray(banco.exames) ? banco.exames : [])) {
        const lista = Array.isArray(exame?.clinicas) ? exame.clinicas : []
        const entrada = lista.find(c => String(c?.clinica_id || '').trim() === clinicaId && String(c?.id_exame_clinica || '').trim() === pid)
        if (!entrada) continue
        entrada.preco = preco
        atualizado = true
        break
      }
      if (!atualizado) throw new Error(`Vinculo nao encontrado para clinica ${clinicaId} pid ${pid}`)
      resumo.updatePreco++
      continue
    }

    if (tipo === 'addVinculoExame') {
      const clinicaId = String(op?.clinica_id || '').trim()
      const pid = String(op?.id_exame_clinica || '').trim()
      const preco = _parsePrecoNumero(op?.preco)
      const nomeParam = _normalizarNomeExame(op?.nome_parametro || op?.nome_real || op?.nome || '')
      const nomeReal = _normalizarNomeExame(op?.nome_real || nomeParam)

      if (!clinicaId || !pid || preco === null || !nomeParam) { resumo.ignorados++; continue }

      // Se o vinculo ja existir em qualquer exame, nao adiciona.
      let jaExiste = false
      for (const exame of (Array.isArray(banco.exames) ? banco.exames : [])) {
        const lista = Array.isArray(exame?.clinicas) ? exame.clinicas : []
        if (lista.some(c => String(c?.clinica_id || '').trim() === clinicaId && String(c?.id_exame_clinica || '').trim() === pid)) {
          jaExiste = true
          break
        }
      }
      if (jaExiste) { resumo.ignorados++; continue }

      let exameAlvo = (Array.isArray(banco.exames) ? banco.exames : []).find(e => _normalizarNomeExame(e?.nome_parametro) === nomeParam)
      if (!exameAlvo) {
        exameAlvo = { nome_parametro: nomeParam, nome_real: nomeReal, clinicas: [] }
        banco.exames.push(exameAlvo)
      }
      if (!Array.isArray(exameAlvo.clinicas)) exameAlvo.clinicas = []

      const jaTem = exameAlvo.clinicas.some(c => String(c?.clinica_id || '').trim() === clinicaId && String(c?.id_exame_clinica || '').trim() === pid)
      if (!jaTem) {
        exameAlvo.clinicas.push({ clinica_id: clinicaId, id_exame_clinica: Number(pid), preco })
        resumo.addVinculoExame++
      } else {
        resumo.ignorados++
      }
      continue
    }

    if (tipo === 'credenciarClinica') {
      const forid = String(op?.forid || op?.clinica_id || '').trim()
      if (!forid) { resumo.ignorados++; continue }

      const jaExiste = (Array.isArray(banco.clinicas) ? banco.clinicas : []).some(c => String(c?.id || '').trim() === forid)
      if (jaExiste) { resumo.ignorados++; continue }

      const dados = await _acmanagerGetJson({
        action: 'fornecedores/getdata',
        forid,
      }, 'credenciarClinica/getdata')

      const norm = _normalizarFornecedorGetdata(dados)
      if (!norm.id) throw new Error(`Fornecedor ${forid} retornou dados invalidos`)

      const tipoApp = _inferirTipoClinica(norm.nome) // 'lab' | 'clinica'
      const clinica = {
        ...norm,
        tipo: tipoApp,
        ativo: true,
      }

      banco.clinicas.push(clinica)
      // Mantem ordenacao por id para consistencia visual
      banco.clinicas.sort((a, b) => Number(String(a?.id || '0')) - Number(String(b?.id || '0')))
      // Reusa contador "addVinculoExame" seria confuso; contamos como ignorados? melhor adicionar novo campo no resumo.
      // Para manter API simples, contabilizamos em addVinculoExame? Nao. Vamos usar ignorados? Nao.
      // Incrementamos updatePreco? Nao. Entao incrementamos addVinculoExame como "mudancas" gerais? Tambem nao.
      // Solucao: usa setClinicaAtivo como "clinica alterada". Nao.
      // Melhor: adicionar chave no resumo dinamicamente.
      resumo.credenciarClinica = (resumo.credenciarClinica || 0) + 1
      continue
    }

    resumo.ignorados++
  }

  _salvarBancoCompleto(caminho, banco)
  return { ok: true, resumo }
})

// GET /paciente/:codigo
ipcMain.handle('get-paciente', async (_, codigo) => {
  if (!_buscarPaciente) throw new Error('Módulo ainda não inicializado')
  if (!global.phpsessid) throw new Error('Faça login no sistema antes de buscar pacientes')
  return _buscarPaciente(codigo)
})

// POST /agendar
ipcMain.handle('agendar', async (_, agendamentos) => {
  if (!Array.isArray(agendamentos) || !agendamentos.length) {
    throw new Error('Envie um array com ao menos um agendamento')
  }

  if (!fs.existsSync(PASTA_GUIAS)) fs.mkdirSync(PASTA_GUIAS, { recursive: true })

  const bancoDados = JSON.parse(fs.readFileSync(resolverCaminhoBanco(), 'utf-8'))
  const mapaNomeExamePorPid = new Map()
  for (const exame of (Array.isArray(bancoDados?.exames) ? bancoDados.exames : [])) {
    const nomeExame = String(exame?.nome_real || exame?.nome_parametro || '').trim()
    if (!nomeExame) continue
    for (const clinicaExame of (Array.isArray(exame?.clinicas) ? exame.clinicas : [])) {
      const pid = String(clinicaExame?.id_exame_clinica || '').trim()
      if (!pid || mapaNomeExamePorPid.has(pid)) continue
      mapaNomeExamePorPid.set(pid, nomeExame)
    }
  }

  const normalizado = normalizarContatosFornecedores(carregarContatosFornecedores())
  if (normalizado.alterado) {
    try { salvarContatosFornecedores(normalizado.contatos) } catch {}
  }
  const contatosFornecedores = normalizado.contatos

  const resultados = []

  for (const a of agendamentos) {
    try {
      const resultado = await _agendarViaHttp({
        codigoPaciente: a.codigoPaciente,
        codigoClinica:  a.codigoClinica,
        enderecoId:     a.enderecoIdSelecionado || null,
        exames:         a.exames,
        data:           a.data,
        horario:        a.horario
      })

      const nomeArquivo = `${resultado.numGuia} - ${resultado.nomePaciente}.pdf`
      const caminho     = path.join(PASTA_GUIAS, nomeArquivo)
      fs.writeFileSync(caminho, resultado.pdfBuffer)
      console.log(`[Agendamento] Guia salva: ${caminho}`)

      const numeroPaciente = normalizarCelular(resultado.celularPaciente)
      if (numeroPaciente) {
        const mensagemPaciente = montarMensagemClinica({
          nomePaciente:    resultado.nomePaciente,
          nomeClinica:     resultado.nomeClinica,
          enderecoClinica: resultado.enderecoClinica,
          data:            a.data,
          horario:         a.horario,
          exames:          a.exames,
          numGuia:         resultado.numGuia,
          mtdopgto:        resultado.mtdopgtoClinica,
          tipoCard:        a.tipoCard
        })
        try {
          const envioPaciente = await enviarPdfWhatsappComDispatcher(numeroPaciente, caminho, mensagemPaciente)
          console.log(`[WhatsApp] Guia enviada ao paciente via ${envioPaciente.via}: ${numeroPaciente}`)
        } catch (err) {
          console.warn(`[WhatsApp] Falha ao enviar guia para paciente (${numeroPaciente}): ${err.message}`)
        }
      } else {
        console.warn('[WhatsApp] Paciente sem celular valido para envio da guia', {
          guia: resultado.numGuia,
          paciente: resultado.nomePaciente
        })
      }

      const forid = String(a.codigoClinica || '').trim()
      const clinicaInfo = (Array.isArray(bancoDados?.clinicas) ? bancoDados.clinicas : [])
        .find(c => String(c?.id ?? '') === forid)
      let predSelecionado = String(a.enderecoIdSelecionado || '').trim()
      if (!predSelecionado) predSelecionado = String(resultado?.enderecoId || '').trim()
      if (!predSelecionado) predSelecionado = String(clinicaInfo?.enderecos?.[0]?.id || '').trim()

      const numeroFornecedor = obterWhatsappFornecedor(contatosFornecedores, forid, predSelecionado)
      if (numeroFornecedor) {
        const examesLinhas = (Array.isArray(a.exames) ? a.exames : []).map(ex => {
          const pid = String(ex?.pid || '').trim()
          const nomeExame = mapaNomeExamePorPid.get(pid) || `pid ${pid || '-'}`
          const valorItem = Number(ex?.valor || 0) * Number(ex?.qtde || 1)
          return { nome: nomeExame, valor: valorItem }
        })
        const totalExames = examesLinhas.reduce((acc, item) => acc + Number(item.valor || 0), 0)
        const msgFornecedor = montarMensagemFornecedor({
          nomePaciente: resultado.nomePaciente,
          cpfPaciente: a.cpfPaciente || '',
          datanascPaciente: a.datanascPaciente || '',
          celularPaciente: resultado.celularPaciente || '',
          data: a.data,
          horario: a.horario,
          examesLinhas,
          totalExames,
          numGuia: resultado.numGuia
        })
        try {
          const envioFornecedor = await enviarMensagemWhatsappComDispatcher(numeroFornecedor, msgFornecedor)
          console.log(`[WhatsApp] Dados enviados ao fornecedor via ${envioFornecedor.via}: forid=${forid} pred=${predSelecionado}`)
        } catch (err) {
          console.warn(`[WhatsApp] Falha ao enviar para fornecedor forid=${forid} pred=${predSelecionado}: ${err.message}`)
        }
      } else {
        console.log(`[WhatsApp] Sem contato para fornecedor forid=${forid} pred=${predSelecionado}. Envio nao realizado.`)
      }

      resultados.push({ sucesso: true, nomePaciente: resultado.nomePaciente, codigoPaciente: a.codigoPaciente })

    } catch (err) {
      console.log(`[Agendamento] Erro: ${err.message}`)
      resultados.push({ sucesso: false, codigoPaciente: a.codigoPaciente, erro: err.message })
    }
  }

  return resultados
})
// ─────────────────────────────────────────────────────────────
// IPC — handlers de navegação, sessão e app (inalterados)
// ─────────────────────────────────────────────────────────────

ipcMain.on('webview-navegou', async (_, url) => {
  if (url.includes('/dash')) {
    const capturado = await capturarESalvarCookie(appWindow)
    if (capturado) {
      console.log('[Sessão] Sessão válida confirmada via webview')
      global.emitirIPC('sessao-ok')
      // Com sessão ativa, podemos iniciar (ou retomar) o sync automático do banco.
      _bancoSyncTentarIniciar('sessao-ok')
    }
  }
})

ipcMain.handle('get-versao', () => app.getVersion())

ipcMain.handle('get-contatos-fornecedores', () => {
  const normalizado = normalizarContatosFornecedores(carregarContatosFornecedores())
  if (normalizado.alterado) {
    try { salvarContatosFornecedores(normalizado.contatos) } catch {}
  }
  return normalizado.contatos
})

ipcMain.handle('salvar-contato-fornecedor', (_, payload = {}) => {
  const forid = String(payload?.forid || '').trim()
  const pred = String(payload?.pred || '').trim()
  if (!forid || !pred) throw new Error('forid e pred sao obrigatorios')

  const contatosAtual = normalizarContatosFornecedores(carregarContatosFornecedores()).contatos
  if (!contatosAtual.fornecedores[forid]) contatosAtual.fornecedores[forid] = {}

  const whatsapp = String(payload?.whatsapp || '').trim()
  if (!whatsapp) {
    delete contatosAtual.fornecedores[forid][pred]
    if (!Object.keys(contatosAtual.fornecedores[forid]).length) {
      delete contatosAtual.fornecedores[forid]
    }
  } else {
    const numero = normalizarCelular(whatsapp)
    if (!numero) throw new Error('Numero de WhatsApp invalido')
    contatosAtual.fornecedores[forid][pred] = { whatsapp: numero }
  }

  salvarContatosFornecedores(contatosAtual)
  return contatosAtual
})

ipcMain.handle('orc-token-criar', async (_, payload = {}) => {
  return _criarTokenOrcamento(payload)
})

ipcMain.handle('orc-token-recuperar', async (_, token = '') => {
  return _recuperarTokenOrcamento(token)
})

ipcMain.handle('whatsapp-status-atual', () => {
  try { return _obterStatus ? _obterStatus() : 'disconnected' } catch { return 'disconnected' }
})

ipcMain.handle('whatsapp-entrar', async () => {
  if (!_iniciarWhatsapp) throw new Error('Modulo de WhatsApp nao inicializado')
  if (canalClienteConfiguradoOuAtivo()) {
    throw new Error('Instancia em modo cliente de canal. O WhatsApp deve ficar ativo apenas no host.')
  }
  await iniciarWhatsappComGuarda()
  return { ok: true, status: _obterStatus ? _obterStatus() : 'connecting' }
})

ipcMain.handle('whatsapp-sair', async () => {
  if (!_encerrarWhatsapp) throw new Error('Modulo de WhatsApp nao inicializado')
  await _encerrarWhatsapp({ apagarSessao: true })
  return { ok: true, status: _obterStatus ? _obterStatus() : 'disconnected' }
})

ipcMain.handle('canal-get-config', () => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  return _canalService.getConfig()
})

ipcMain.handle('canal-save-config', (_, partial = {}) => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  return _canalService.saveConfig(partial)
})

ipcMain.handle('canal-host-start', async (_, payload = {}) => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  const status = await _canalService.startHost({
    port: Number(payload?.port),
    code: String(payload?.code || '')
  })
  iniciarWhatsappComGuarda().catch(err =>
    console.warn(`[Canal] Falha ao iniciar WhatsApp local no modo host: ${err.message}`)
  )
  return status
})

ipcMain.handle('canal-host-stop', async () => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  return _canalService.stopHost()
})

ipcMain.handle('canal-client-connect', async (_, payload = {}) => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  if (_desligarWhatsappGracioso) {
    try {
      await _desligarWhatsappGracioso()
      _whatsappStartPromise = null
      console.log('[Canal] WhatsApp local desligado para entrar em modo cliente')
    } catch (err) {
      console.warn(`[Canal] Falha ao desligar WhatsApp local antes do modo cliente: ${err.message}`)
    }
  }
  return _canalService.connectClient({
    host: String(payload?.host || ''),
    port: Number(payload?.port),
    code: String(payload?.code || '')
  })
})

ipcMain.handle('canal-client-disconnect', async () => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  const status = await _canalService.disconnectClient()
  if (status?.role === 'none') {
    iniciarWhatsappComGuarda().catch(err =>
      console.warn(`[Canal] Falha ao religar WhatsApp local apos desconectar cliente: ${err.message}`)
    )
  }
  return status
})

ipcMain.handle('canal-get-status', () => {
  if (!_canalService) throw new Error('Servico de canal indisponivel')
  return _canalService.getStatus()
})

ipcMain.on('renderer-ready', () => {
  appWindowReady = true
  if (appWindow && !appWindow.isDestroyed()) {
    injetarCookieSalvo(appWindow)
    if (pendingQr) {
      appWindow.webContents.send('whatsapp-qr', pendingQr)
      appWindow.webContents.send('whatsapp-status', 'aguardando_qr')
      pendingQr = null
    }
    try {
      appWindow.webContents.send('whatsapp-status', _obterStatus ? _obterStatus() : 'disconnected')
    } catch {}
    try {
      if (_canalService) appWindow.webContents.send('canal-status', _canalService.getStatus())
    } catch {}
  }
})

// ─────────────────────────────────────────────────────────────
// Tray icon
// ─────────────────────────────────────────────────────────────

function criarTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  const icon     = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()

  tray = new Tray(icon)

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir Agendamentos',
      click: () => { if (appWindow) appWindow.show(); else criarAppWindow() }
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => { app.isQuitting = true; app.quit() }
    },
  ])

  tray.setToolTip('Agendamentos')
  tray.setContextMenu(menu)
  tray.on('double-click', () => {
    if (appWindow) appWindow.show()
  })
}

// ─────────────────────────────────────────────────────────────
// Single instance lock
// ─────────────────────────────────────────────────────────────
const allowMultiInstance = String(process.env.ALLOW_MULTI_INSTANCE || '').trim() === '1'
if (!allowMultiInstance) {
  const singleLock = app.requestSingleInstanceLock()
  if (!singleLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (appWindow) { appWindow.show(); appWindow.focus() }
    })
  }
} else {
  console.log('[Boot] ALLOW_MULTI_INSTANCE=1 - lock de instancia unica desativado')
}

// ─────────────────────────────────────────────────────────────
// Boot principal
// ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ── PRIMEIRO: limpa sessões de ambiente anterior (rebuild/reinstalação)
  limparSessoesDeAmbienteAnterior()

  copiarArquivosIniciais()
  criarSplash()

  try {
    // Importa os módulos ESM de lógica de negócio
    console.log('[Boot] app.whenReady disparado')
    enviarStatusSplash('Iniciando módulos...')
    console.log('[Boot] Importando módulos ESM...')

    console.log('[Boot] Carregando calendario.js...')
    const calendario = require('./calendario.js')
    console.log('[Boot] calendario.js carregado OK')

    console.log('[Boot] Carregando whatsapp.js...')
    const whatsapp   = require('./whatsapp.js')
    console.log('[Boot] whatsapp.js carregado OK')

    _buscarPaciente  = calendario.buscarPaciente
    _agendarViaHttp  = calendario.agendarViaHttp
    _verificarSessao = calendario.verificarSessaoHttp
    _iniciarWhatsapp = whatsapp.iniciarWhatsapp
    _desligarWhatsappGracioso = whatsapp.desligarWhatsappGracioso
    _encerrarWhatsapp = whatsapp.encerrarWhatsapp
    _obterStatus     = whatsapp.obterStatusWhatsapp
    _enviarMensagem  = whatsapp.enviarMensagem
    _enviarPdf       = whatsapp.enviarPdf

    console.log('[Boot] Módulos ESM carregados')

    // Carrega sessão salva do disco
    // (somente chegará aqui se a versão bater — a limpeza acima
    //  já removeu sessao.json de ambientes anteriores)
    enviarStatusSplash('Verificando sessão...')
    if (fs.existsSync(SESSAO_PATH)) {
      try {
        const { cookies } = JSON.parse(fs.readFileSync(SESSAO_PATH, 'utf-8'))
        const php = cookies?.find(c => c.name === 'PHPSESSID')
        if (php?.value) {
          global.phpsessid = php.value
          console.log('[Boot] Sessão prévia carregada do disco')
        }
      } catch { /* sessao.json inválido — ignora */ }
    }

    // Abre janela e tray
    enviarStatusSplash('Abrindo janela...')
    criarAppWindow()
    criarTray()

    try {
      await _canalService.restoreFromConfig()
      console.log('[Canal] Configuracao restaurada')
    } catch (err) {
      console.warn(`[Canal] Falha ao restaurar configuracao: ${err.message}`)
    }

    const canalConfig = _canalService ? _canalService.getConfig() : null
    const modoCanal = String(canalConfig?.mode || 'none')
    if (modoCanal === 'client') {
      console.log('[Boot] Modo cliente de canal detectado - WhatsApp local nao sera iniciado')
    } else {
      // WhatsApp em paralelo — não bloqueia o boot
      iniciarWhatsappComGuarda().catch(err =>
        console.warn(`[WhatsApp] Inicialização falhou: ${err.message}`)
      )
    }

    // Verificação periódica de sessão a cada 30 minutos
    setInterval(async () => {
      try { await _verificarSessao() } catch (err) {
        console.warn(`[Sessão] Falha na verificação periódica: ${err.message}`)
      }
    }, 30 * 60 * 1000)

    // Sync automático do banco a cada 1 hora (background).
    // Rodamos uma primeira tentativa ~1 minuto após o boot; se não houver sessão, fica aguardando sessao-ok.
    setTimeout(() => _bancoSyncTentarIniciar('boot'), 60 * 1000)
    setInterval(() => _bancoSyncTentarIniciar('interval'), BANCO_SYNC_INTERVAL_MS)

} catch (err) {
  console.error('[Boot] Falha crítica:', err.stack || err)
  enviarStatusSplash(`ERRO CRÍTICO: ${err.message}`)
  // Grava log de erro em arquivo para diagnóstico
  const logPath = path.join(
    process.env.APPDATA || require('os').homedir(),
    'agendamentos-electron',
    'boot-error.log'
  )
  try {
    fs.writeFileSync(logPath,
      `[${new Date().toISOString()}] BOOT ERROR:\n${err.stack || err}\n`,
      { flag: 'a' }
    )
    console.error('[Boot] Log de erro gravado em:', logPath)
  } catch (_) { /* ignora se não conseguir gravar */ }
  await new Promise(r => setTimeout(r, 3000)) // exibe o erro na splash por 3s
  criarAppWindow()
  criarTray()
}
})

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin' && tray) {
    e.preventDefault()
  }
})

app.on('activate', () => {
  if (!appWindow) criarAppWindow()
})

app.on('before-quit', (event) => {
  if (_allowBeforeQuit) {
    app.isQuitting = true
    return
  }
  event.preventDefault()
  app.isQuitting = true
  executarShutdownGracioso('before-quit')
    .catch(err => console.warn(`[Shutdown] Falha no before-quit: ${err.message}`))
    .finally(() => {
      _allowBeforeQuit = true
      app.quit()
    })
})

function _encerrarPorSinal(signalName) {
  executarShutdownGracioso(signalName)
    .catch(err => console.warn(`[Shutdown] Falha no sinal ${signalName}: ${err.message}`))
    .finally(() => process.exit(0))
}

process.on('SIGINT', () => _encerrarPorSinal('SIGINT'))
process.on('SIGTERM', () => _encerrarPorSinal('SIGTERM'))
