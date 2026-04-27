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
const BANCO_FIXO_NOME = 'banco-completo-1776706462033.json'

let splashWindow   = null
let appWindow      = null
let tray           = null
let appWindowReady = false
let pendingQr      = null

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
  const emPublic = path.join(__dirname, 'public', BANCO_FIXO_NOME)
  if (fs.existsSync(emPublic)) return emPublic
  throw new Error(`${BANCO_FIXO_NOME} nao encontrado em public/`)
}

// ─────────────────────────────────────────────────────────────
// Cópia inicial de arquivos de dados para userData
// ─────────────────────────────────────────────────────────────
function copiarArquivosIniciais() {
  const caminho = resolverCaminhoBanco()
  console.log(`[Boot] Banco fixo selecionado: ${caminho}`)
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
  const caminho = resolverCaminhoBanco()
  return JSON.parse(fs.readFileSync(caminho, 'utf-8'))
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

    const entrada = cId
      ? exame.clinicas.find(c => c.clinica_id === cId)
      : exame.clinicas[0]

    if (!entrada) continue

    resultado[exame.nome_parametro] = {
      id:        entrada.id_exame_clinica,
      valor:     entrada.preco,
      nome_real: exame.nome_real
    }
  }

  return resultado
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
