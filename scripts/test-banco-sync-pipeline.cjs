/* eslint-disable no-console */
// Teste de pipeline (sem escrever no banco):
// - baixa o relatório de credenciados (HTML)
// - extrai lista de fornecedores (filtrando os "sem nome")
// - para alguns forid, baixa fornecedores/editar (HTML) e roda o parser de itens
//
// Uso:
//   node scripts/test-banco-sync-pipeline.cjs

const fs = require('fs')
const path = require('path')

const URL_BASE = 'https://cimcero.pentagono.info'
const URL_DASH = `${URL_BASE}/dash`
const URL_ACMANAGER = `${URL_BASE}/P5fw/acmanager`

function lerSessao() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA nao definido')
  const p = path.join(appData, 'agendamentos-electron', 'sessao.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const php = raw?.cookies?.find(c => c?.name === 'PHPSESSID')?.value
  if (!php) throw new Error('PHPSESSID nao encontrado em sessao.json')
  return php
}

function _stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extrairFornecedoresRelatorioCredenciados(html) {
  const select = html.match(/<select[^>]*id=['"]rpt-credenciados-prest['"][^>]*>([\s\S]*?)<\/select>/i)
  if (!select) throw new Error('select rpt-credenciados-prest nao encontrado')
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

async function main() {
  const phpsessid = lerSessao()
  console.log('[TestePipeline] sessao ok')

  console.log('[TestePipeline] baixando relatorio...')
  const rel = await postAcmanager({
    phpsessid,
    formObj: { action: 'relatorios/credenciamentos/credenciados', page: '1', wid: '5' },
  })
  console.log('[TestePipeline] relatorio http=', rel.status, 'bytes=', Buffer.byteLength(rel.text, 'utf8'))
  const fornecedores = extrairFornecedoresRelatorioCredenciados(rel.text)
  const des = fornecedores.filter(f => f.desativadoNoSistema).length
  console.log(`[TestePipeline] fornecedores: total=${fornecedores.length} desativados_no_sistema=${des}`)

  const alvos = ['2', '3', '107']
  const primeiros = fornecedores.slice(0, 3).map(f => f.forid)
  const set = Array.from(new Set([...alvos, ...primeiros]))
  console.log('[TestePipeline] forids teste:', set.join(', '))

  for (const forid of set) {
    console.log(`\n[TestePipeline] forid=${forid} fornecedores/editar...`)
    const r = await postAcmanager({
      phpsessid,
      formObj: { action: 'fornecedores/editar', page: '1', wid: '5', 'params[id]': forid },
    })
    const evidRef = (r.text.match(/\bref=['"]\d+['"]/gi) || []).length
    const evidBtn = (r.text.match(/\bbtn-success\b|\bbtn-danger\b/gi) || []).length
    console.log(`[TestePipeline] forid=${forid} http=${r.status} bytes=${Buffer.byteLength(r.text, 'utf8')} marker=${r.text.includes('fornecedor-editar-servicos')} evidRef=${evidRef} evidBtn=${evidBtn}`)
    try {
      const itens = extrairItensFornecedorEditar(r.text)
      console.log(`[TestePipeline] forid=${forid} itens_parseados=${itens.length}`)
    } catch (err) {
      console.log(`[TestePipeline] forid=${forid} ERRO parse: ${err.message}`)
    }
  }
}

main().catch(err => {
  console.error('[TestePipeline] ERRO fatal:', err.message)
  process.exit(1)
})

