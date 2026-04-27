'use strict'

// ─────────────────────────────────────────────────────────────
// preload.cjs — executado no contexto do renderer, antes do HTML
//
// Expõe APENAS as funções necessárias via contextBridge.
// O renderer (agendamentos.html e splash.html) acessa via
// window.electronAPI — sem acesso direto ao Node.js.
// ─────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Dados (antigas rotas Express) ──────────────────────────

  // GET /banco — banco.json completo
  getBanco: () => ipcRenderer.invoke('get-banco'),

  // GET /exames?clinicaId=X&tipo=Y
  getExames: (clinicaId, tipo) => ipcRenderer.invoke('get-exames', { clinicaId, tipo }),

  // GET /paciente/:codigo
  getPaciente: (codigo) => ipcRenderer.invoke('get-paciente', codigo),

  // POST /agendar
  agendar: (agendamentos) => ipcRenderer.invoke('agendar', agendamentos),

  // GET /contatos-fornecedores
  getContatosFornecedores: () => ipcRenderer.invoke('get-contatos-fornecedores'),

  // POST /contatos-fornecedores
  salvarContatoFornecedor: (payload) => ipcRenderer.invoke('salvar-contato-fornecedor', payload),
  criarTokenOrcamento: (payload) => ipcRenderer.invoke('orc-token-criar', payload),
  recuperarTokenOrcamento: (token) => ipcRenderer.invoke('orc-token-recuperar', token),

  // ── WhatsApp ────────────────────────────────────────────────

  // Recebe QR Code bruto do Baileys para renderizar em canvas
  onQrCode: (callback) => {
    ipcRenderer.on('whatsapp-qr', (_, qrData) => callback(qrData))
  },

  // Recebe mudanças de status do WhatsApp em tempo real
  onWhatsappStatus: (callback) => {
    ipcRenderer.on('whatsapp-status', (_, status) => callback(status))
  },

  // Controle explícito da sessão WhatsApp
  entrarWhatsapp: () => ipcRenderer.invoke('whatsapp-entrar'),
  sairWhatsapp: () => ipcRenderer.invoke('whatsapp-sair'),
  getWhatsappStatus: () => ipcRenderer.invoke('whatsapp-status-atual'),

  // â”€â”€ Canal de conexao (host/cliente) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  getCanalConfig: () => ipcRenderer.invoke('canal-get-config'),
  saveCanalConfig: (partial) => ipcRenderer.invoke('canal-save-config', partial),
  iniciarCanalHost: (payload) => ipcRenderer.invoke('canal-host-start', payload),
  pararCanalHost: () => ipcRenderer.invoke('canal-host-stop'),
  conectarCanalCliente: (payload) => ipcRenderer.invoke('canal-client-connect', payload),
  desconectarCanalCliente: () => ipcRenderer.invoke('canal-client-disconnect'),
  getCanalStatus: () => ipcRenderer.invoke('canal-get-status'),
  onCanalStatus: (callback) => {
    ipcRenderer.on('canal-status', (_, status) => callback(status))
  },

  // ── Sessão ─────────────────────────────────────────────────

  // Notifica quando a sessão expira (operador precisa fazer login novamente)
  onSessaoExpirada: (callback) => {
    ipcRenderer.on('sessao-expirada', () => callback())
  },

  // Notifica quando a sessão é reestabelecida
  onSessaoOk: (callback) => {
    ipcRenderer.on('sessao-ok', () => callback())
  },

  // ── App ────────────────────────────────────────────────────

  // Retorna a versão do app (do package.json)
  getVersao: () => ipcRenderer.invoke('get-versao'),

  // Sinaliza ao main.cjs que o renderer está pronto para receber eventos.
  // Resolve a race condition do QR Code — deve ser chamado no DOMContentLoaded.
  rendererReady: () => ipcRenderer.send('renderer-ready'),

  // Repassa URL de navegação do <webview> para o main.cjs capturar cookie de sessão.
  webviewNavegou: (url) => ipcRenderer.send('webview-navegou', url),

  // ── Splash ─────────────────────────────────────────────────

  // Recebe atualizações de texto de etapa na splash screen
  onSplashStatus: (callback) => {
    ipcRenderer.on('splash-status', (_, msg) => callback(msg))
  },
})
