'use strict'
const fs   = require('fs')
const path = require('path')

const URL_BASE      = 'https://cimcero.pentagono.info'
const URL_DASH      = `${URL_BASE}/dash`
const URL_ACMANAGER = `${URL_BASE}/P5fw/acmanager`

// ─────────────────────────────────────────────────────────────
// ARQUIVO_BANCO — resolvido via global.USER_DATA definido pelo
// main.cjs antes de importar server.js. Fallback para o caminho
// local para compatibilidade com execução fora do Electron.
// ─────────────────────────────────────────────────────────────
function caminhosBanco() {
  const base = global.USER_DATA || path.resolve('./public')
  return path.join(base, 'banco.json')
}

// ─────────────────────────────────────────────────────────────
// PHPSESSID — lido de global.phpsessid, definido pelo main.cjs
// sempre que um cookie válido é capturado da BrowserWindow.
// ─────────────────────────────────────────────────────────────

function obterPhpsessid() {
  const valor = global.phpsessid
  if (!valor) throw new Error('Sessão não iniciada — faça login na janela do sistema')
  return valor
}

function definirPhpsessid(valor) {
  global.phpsessid = valor
}

function headersHttp() {
  return {
    'Cookie':           `PHPSESSID=${obterPhpsessid()}`,
    'Content-Type':     'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer':          URL_DASH
  }
}

// ─────────────────────────────────────────────────────────────
// Faz parse seguro de resposta JSON do servidor.
// Se o corpo começar com '<', o servidor devolveu uma página HTML
// (tipicamente um redirect para login com sessão expirada).
// Nesse caso: limpa a sessão em memória, notifica o renderer
// via IPC e lança um erro com mensagem legível para o operador.
// ─────────────────────────────────────────────────────────────
function parsearRespostaJson(texto, contexto) {
  if (texto.trimStart().startsWith('<')) {
    console.warn(`[Sessão] Resposta HTML detectada em "${contexto}" — sessão expirada ou inválida`)
    global.phpsessid = null
    if (typeof global.emitirIPC === 'function') {
      global.emitirIPC('sessao-expirada')
    }
    throw new Error('Sessão expirada — faça login novamente na aba do sistema')
  }
  try {
    return JSON.parse(texto)
  } catch (err) {
    throw new Error(`Resposta inválida em "${contexto}": ${texto.slice(0, 200)}`)
  }
}

// ─────────────────────────────────────────────────────────────
// Verifica se o PHPSESSID atual ainda é válido via HTTP
// ─────────────────────────────────────────────────────────────
async function sessaoValida(cookieValue) {
  try {
    const params = new URLSearchParams({
      action:  'credenciamentos/search',
      term:    'hemograma',
      forid:   '2',
      credid:  '0',
      pritens: '',
      _:       Date.now().toString()
    })
    const res = await fetch(`${URL_ACMANAGER}?${params}`, {
      headers: {
        'Cookie':           `PHPSESSID=${cookieValue}`,
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
    if (!res.ok) return false
    const texto = await res.text()
    JSON.parse(texto)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// Verificação periódica silenciosa — chamada pelo setInterval
// em server.js a cada 30 minutos.
//
// Não abre mais browser. Se expirada, limpa global.phpsessid
// e emite evento IPC para o renderer avisar o operador.
// O operador faz login na janela do sistema e o main.cjs
// captura o novo cookie automaticamente via did-navigate.
// ─────────────────────────────────────────────────────────────
async function verificarSessaoHttp() {
  const atual = global.phpsessid
  if (!atual) {
    console.warn('[Sessão] Nenhum PHPSESSID em memória — aguardando login')
    return false
  }
  const valida = await sessaoValida(atual)
  if (!valida) {
    console.warn('[Sessão] Sessão expirada — operador deve fazer login novamente')
    global.phpsessid = null
    // Avisa o renderer (agendamentos.html) via IPC
    if (typeof global.emitirIPC === 'function') {
      global.emitirIPC('sessao-expirada')
    }
  } else {
    console.log('[Sessão] Verificação periódica OK')
  }
  return valida
}

// ─────────────────────────────────────────────────────────────
// Busca dados de um paciente pelo código
// ─────────────────────────────────────────────────────────────
async function buscarPaciente(codigoPaciente) {
  const body = new URLSearchParams({
    action: 'pacientes/get',
    pc:     codigoPaciente
  })

  const res = await fetch(URL_ACMANAGER, {
    method:  'POST',
    headers: headersHttp(),
    body:    body.toString()
  })

  if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao buscar paciente ${codigoPaciente}`)

  const dados = parsearRespostaJson(await res.text(), 'buscarPaciente')

  return {
    nome:     dados.nome?.trim()     || '',
    cpf:      dados.cpf?.trim()      || '',
    datanasc: dados.datanasc?.trim() || '',
    nomemae:  dados.nomemae?.trim()  || '',
    celular:  dados.celular?.trim()  || ''
  }
}

// ─────────────────────────────────────────────────────────────
// Busca dados de uma clínica/laboratório pelo código
// Retorna { nome, endereco, enderecoId, mtdopgto }
// onde enderecoId é sempre o id de enderecos[0]
// ─────────────────────────────────────────────────────────────
async function buscarClinica(codigoClinica, enderecoIdSelecionado = null) {
  const body = new URLSearchParams({
    action: 'fornecedores/getdata',
    forid:  codigoClinica
  })

  const res = await fetch(URL_ACMANAGER, {
    method:  'POST',
    headers: headersHttp(),
    body:    body.toString()
  })

  if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao buscar clínica ${codigoClinica}`)

  const dados = parsearRespostaJson(await res.text(), 'buscarClinica')

  const enderecos = Array.isArray(dados.enderecos) ? dados.enderecos : []
  const enderecoIdAlvo = String(enderecoIdSelecionado || '').trim()
  const endSelecionado = enderecos.find(e => String(e?.id ?? '') === enderecoIdAlvo)
  const end = endSelecionado || enderecos[0]
  const partes = [
    end?.logradouro?.trim(),
    end?.complemento?.trim() || null,
    end?.bairro?.trim()
  ].filter(Boolean)

  return {
    nome:       dados.nome?.trim()     || '',
    endereco:   partes.join(', ')      || '',
    mtdopgto:   dados.mtdopgto?.trim() || '',
    enderecoId: end?.id ?? '0'
  }
}

// ─────────────────────────────────────────────────────────────
// Baixa o PDF da guia via GET direto na URL do token
// ─────────────────────────────────────────────────────────────
async function baixarPdf(token) {
  const url = `${URL_BASE}/agendamento/print/g/${token}`

  const res = await fetch(url, {
    headers: {
      'Cookie':  `PHPSESSID=${obterPhpsessid()}`,
      'Referer': URL_DASH
    },
    redirect: 'follow'
  })

  if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao baixar PDF: ${url}`)

  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    throw new Error(`Resposta inesperada ao baixar PDF (content-type: ${ct}): ${url}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  console.log(`[PDF] ✓ PDF baixado — ${buf.length} bytes: ${url}`)
  return buf
}

// ─────────────────────────────────────────────────────────────
// Executa o agendamento via HTTP direto
// exames: [{ pid, qtde, valor }]
// ─────────────────────────────────────────────────────────────
async function agendarViaHttp({ codigoPaciente, codigoClinica, enderecoId = null, exames, data, horario }) {
  const [paciente, clinica] = await Promise.all([
    buscarPaciente(codigoPaciente),
    buscarClinica(codigoClinica, enderecoId)
  ])

  const params = new URLSearchParams()

  params.set('pcid', codigoPaciente)

  exames.forEach((exame, i) => {
    params.set(`pritens[${i}][pid]`,   exame.pid)
    params.set(`pritens[${i}][qtde]`,  exame.qtde ?? 1)
    params.set(`pritens[${i}][valor]`, exame.valor)
  })

  params.set('prid',                codigoClinica)
  params.set('pred',                clinica.enderecoId)
  params.set('aih_apac_arquivo',    '')
  params.set('agobj[dia]',          data)
  params.set('agobj[agendaLivre]',  'true')
  params.set('agobj[horarioLivre]', horario)
  params.set('comment',             '')
  params.set('credid',              codigoClinica)
  params.set('conta',               '')
  params.set('origem',              '')
  params.set('destino',             '')
  params.set('sisreg',              '')
  params.set('sisreg_cfm',          '')

  // ── Passo 1: preview ─────────────────────────────────────
  params.set('action', 'regulacao/agendarpreview')
  const resPreview = await fetch(URL_ACMANAGER, {
    method:  'POST',
    headers: headersHttp(),
    body:    params.toString()
  })
  if (!resPreview.ok) throw new Error(`Erro no agendarpreview: HTTP ${resPreview.status}`)

  // ── Passo 2: gerar guia ──────────────────────────────────
  params.set('action', 'regulacao/geraguia')
  const resGuia = await fetch(URL_ACMANAGER, {
    method:  'POST',
    headers: headersHttp(),
    body:    params.toString()
  })
  if (!resGuia.ok) throw new Error(`Erro no geraguia: HTTP ${resGuia.status}`)

  const textoGuia = await resGuia.text()
  console.log(`[Guia] Resposta do geraguia:`, textoGuia.slice(0, 500))

  const dadosGuia = parsearRespostaJson(textoGuia, 'geraguia')

  if (!dadosGuia?.response) {
    throw new Error(`Agendamento rejeitado pelo servidor: ${textoGuia.slice(0, 200)}`)
  }

  const numGuia = String(dadosGuia.guia)
  const token   = String(dadosGuia.token)
  console.log(`[Guia] ✓ Guia gerada — guia: ${numGuia} | token: ${token}`)

  const pdfBuffer = await baixarPdf(token)

  return {
    sucesso:          true,
    pdfBuffer,
    nomePaciente:     paciente.nome,
    celularPaciente:  paciente.celular,
    nomeClinica:      clinica.nome,
    enderecoClinica:  clinica.endereco,
    enderecoId:       clinica.enderecoId,
    mtdopgtoClinica:  clinica.mtdopgto,
    numGuia
  }
}

// ─────────────────────────────────────────────────────────────
// ORÇAMENTO
// ─────────────────────────────────────────────────────────────

function gerarOrcamento(examesSolicitados) {
  const banco    = JSON.parse(fs.readFileSync(caminhosBanco(), 'utf-8'))
  const clinicas = banco.clinicas

  const porClinica = {}
  clinicas.forEach(c => { porClinica[c.id] = [] })

  for (const exame of banco.exames) {
    if (!examesSolicitados.includes(exame.nome_parametro)) continue
    for (const entrada of exame.clinicas) {
      if (!porClinica[entrada.clinica_id]) porClinica[entrada.clinica_id] = []
      porClinica[entrada.clinica_id].push({
        nome_parametro:   exame.nome_parametro,
        nome_real:        exame.nome_real,
        id_exame_clinica: entrada.id_exame_clinica,
        preco:            entrada.preco
      })
    }
  }

  return clinicas.map(clinica => {
    const disponiveis      = porClinica[clinica.id] || []
    const nomesDisponiveis = disponiveis.map(e => e.nome_parametro)
    const indisponiveis    = examesSolicitados
      .filter(n => !nomesDisponiveis.includes(n))
      .map(n => {
        const exame = banco.exames.find(e => e.nome_parametro === n)
        return exame?.nome_real || n
      })
    const total = disponiveis.reduce((acc, e) => acc + e.preco, 0)

    return {
      clinica_id:   clinica.id,
      clinica_nome: clinica.nome,
      disponiveis,
      indisponiveis,
      total
    }
  })
}

function formatarMensagemOrcamento(orcamento, nomePaciente) {
  const moeda  = v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`
  const linhas = [`*Orçamento — ${nomePaciente}*\n`]

  for (const item of orcamento) {
    if (!item.disponiveis.length) continue
    if (!item.indisponiveis.length) {
      linhas.push(`${item.clinica_nome} — ${moeda(item.total)} ✅`)
    } else {
      linhas.push(`${item.clinica_nome} — ${moeda(item.total)} ⚠️ fora: ${item.indisponiveis.join(', ')}`)
    }
  }

  return linhas.join('\n').trimEnd()
}

module.exports = {
  obterPhpsessid,
  definirPhpsessid,
  headersHttp,
  verificarSessaoHttp,
  buscarPaciente,
  buscarClinica,
  agendarViaHttp,
  gerarOrcamento,
  formatarMensagemOrcamento
}
