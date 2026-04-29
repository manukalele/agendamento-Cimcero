/* eslint-disable no-console */
// Dry-run do BancoSync (sem gravar no banco):
// - lê o banco-completo do userData
// - baixa fornecedores/editar (HTML) e parseia itens
// - calcula o delta que o sync aplicaria (adds/updates/status/removals)
//
// Uso:
//   node scripts/dryrun-banco-sync-forids.cjs

const fs = require('fs')
const path = require('path')

const URL_BASE = 'https://cimcero.pentagono.info'
const URL_DASH = `${URL_BASE}/dash`
const URL_ACMANAGER = `${URL_BASE}/P5fw/acmanager`
const BANCO_FIXO_NOME = 'banco-completo-1776706462033.json'

function lerSessao() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA nao definido')
  const p = path.join(appData, 'agendamentos-electron', 'sessao.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const php = raw?.cookies?.find(c => c?.name === 'PHPSESSID')?.value
  if (!php) throw new Error('PHPSESSID nao encontrado em sessao.json')
  return php
}

function lerBanco() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA nao definido')
  const p = path.join(appData, 'agendamentos-electron', BANCO_FIXO_NOME)
  const banco = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!Array.isArray(banco?.exames)) banco.exames = []
  if (!Array.isArray(banco?.clinicas)) banco.clinicas = []
  return { path: p, banco }
}

function _stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function _parsePrecoNumero(valor) {
  if (valor === null || valor === undefined) return null
  const txt = String(valor).trim()
  if (!txt) return null
  const n = Number(txt.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function _parsePrecoBr(valor) {
  const txt = String(valor || '').replace(/\s+/g, ' ').trim()
  if (!txt) return null
  const limpo = txt.replace(/^R\$\s*/i, '').trim()
  return _parsePrecoNumero(limpo)
}

function _normalizarNomeExame(str) {
  return String(str || '').replace(/\s+/g, ' ').trim()
}

function _parseAttrs(tagOpen) {
  const attrs = {}
  const lt = tagOpen.indexOf('<')
  const gt = tagOpen.lastIndexOf('>')
  const inner = tagOpen.slice(lt + 1, gt >= 0 ? gt : tagOpen.length)

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

function extrairItensFornecedorEditar(html) {
  const tbody = html.match(/<tbody[^>]*id=['"]fornecedor-editar-servicos['"][^>]*>([\s\S]*?)<\/tbody>/i)
  if (!tbody) throw new Error('tbody fornecedor-editar-servicos nao encontrado')
  const body = tbody[1]

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

async function postAcmanager({ phpsessid, formObj }) {
  const params = new URLSearchParams(formObj || {})
  params.set('_', String(Date.now()))
  const res = await fetch(URL_ACMANAGER, {
    method: 'POST',
    headers: {
      'Cookie': `PHPSESSID=${phpsessid}`,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': URL_DASH,
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  })
  const text = await res.text()
  return { status: res.status, ok: res.ok, text }
}

function construirIndexVinculos(banco) {
  const map = new Map()
  const porClinica = new Map()
  for (const ex of banco.exames) {
    const lista = Array.isArray(ex?.clinicas) ? ex.clinicas : []
    for (const v of lista) {
      const cid = String(v?.clinica_id || '').trim()
      const pid = String(v?.id_exame_clinica || '').trim()
      if (!cid || !pid) continue
      const key = `${cid}:${pid}`
      map.set(key, v)
      if (!porClinica.has(cid)) porClinica.set(cid, [])
      porClinica.get(cid).push(v)
    }
  }
  return { map, porClinica }
}

async function dryrunForid({ phpsessid, banco, forid }) {
  const r = await postAcmanager({
    phpsessid,
    formObj: { action: 'fornecedores/editar', page: '1', wid: '5', 'params[id]': String(forid) },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  if (!r.text.includes('fornecedor-editar-servicos')) throw new Error('marker fornecedor-editar-servicos ausente')

  const itens = extrairItensFornecedorEditar(r.text)
  // Regra do app: itens Suspenso (btn-danger) devem ser removidos do banco
  // (e não contam como "vistos ativos").
  const vistosAtivos = new Set(itens.filter(it => it && it.enabled !== false).map(it => String(it.id)))
  const vistosSuspensos = new Set(itens.filter(it => it && it.enabled === false).map(it => String(it.id)))

  const { map, porClinica } = construirIndexVinculos(banco)

  let novos = 0
  let precos = 0
  let suspensos = 0
  let reativados = 0
  let removidos = 0
  let removidosSuspensos = 0
  let removidosAusencia = 0

  for (const it of itens) {
    const pid = String(it.id)
    const key = `${String(forid)}:${pid}`
    const v = map.get(key)
    // Mesma regra do app: itens Suspenso (btn-danger) nao entram como vinculo novo.
    if (!v) {
      if (it.enabled === false) continue
      novos++
      continue
    }

    // Mesma regra do app: Suspenso nao atualiza preco.
    if (it.enabled !== false && typeof it.preco === 'number' && typeof v.preco === 'number' && v.preco !== it.preco) precos++
    const atualEnabled = (v.enabled === false ? false : true)
    if (it.enabled === false && atualEnabled !== false) suspensos++
    if (it.enabled === true && atualEnabled !== true) reativados++
  }

  const lista = porClinica.get(String(forid)) || []
  for (const v of lista) {
    const pid = String(v?.id_exame_clinica || '').trim()
    if (!pid) continue
    if (vistosAtivos.has(pid)) continue
    removidos++
    if (vistosSuspensos.has(pid)) removidosSuspensos++
    else removidosAusencia++
  }

  return { itens: itens.length, novos, precos, suspensos, reativados, removidos, removidosSuspensos, removidosAusencia }
}

async function main() {
  const phpsessid = lerSessao()
  const { path: bancoPath, banco } = lerBanco()
  console.log('[DryRun] banco:', bancoPath)

  const forids = ['2', '3', '107']
  for (const forid of forids) {
    console.log(`\n[DryRun] forid=${forid}...`)
    const r = await dryrunForid({ phpsessid, banco, forid })
    console.log('[DryRun]', { forid, ...r })
  }
}

main().catch(err => {
  console.error('[DryRun] ERRO:', err.message)
  process.exit(1)
})
