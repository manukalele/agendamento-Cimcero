/* eslint-disable no-console */
// Teste isolado (Node puro) para validar o parser do HTML de `fornecedores/editar`.
//
// Uso:
//   node scripts/test-fornecedores-editar-parser.cjs
//
// Requer:
//   - sessao.json em %APPDATA%\\agendamentos-electron com PHPSESSID valido
//   - rede liberada para https://cimcero.pentagono.info

const fs = require('fs')
const path = require('path')

const URL_BASE = 'https://cimcero.pentagono.info'
const URL_DASH = `${URL_BASE}/dash`
const URL_ACMANAGER = `${URL_BASE}/P5fw/acmanager`

function _stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  const txt = String(valor || '').replace(/\s+/g, ' ').trim()
  if (!txt) return null
  const limpo = txt.replace(/^R\$\s*/i, '').trim()
  return _parsePrecoNumero(limpo)
}

function _parseAttrs(tagOpen) {
  // Parse de atributos no nivel da tag, ignorando qualquer 'class=' dentro de valores.
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

function lerSessao() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA nao definido')
  const p = path.join(appData, 'agendamentos-electron', 'sessao.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const php = raw?.cookies?.find(c => c?.name === 'PHPSESSID')?.value
  if (!php) throw new Error('PHPSESSID nao encontrado em sessao.json')
  return php
}

async function postFornecedoresEditar({ phpsessid, forid }) {
  const params = new URLSearchParams()
  params.set('action', 'fornecedores/editar')
  params.set('page', '1')
  params.set('wid', '5')
  params.set('params[id]', String(forid))
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
  return { ok: res.ok, status: res.status, text }
}

async function main() {
  const phpsessid = lerSessao()
  const forids = ['2', '3', '107']
  console.log('[TesteParser] PHPSESSID carregado. forids=', forids.join(','))

  for (const forid of forids) {
    console.log(`\n[TesteParser] forid=${forid} baixando HTML...`)
    const { ok, status, text } = await postFornecedoresEditar({ phpsessid, forid })
    console.log(`[TesteParser] forid=${forid} http=${status} ok=${ok} bytes=${Buffer.byteLength(text, 'utf8')}`)
    const evidRef = (text.match(/\bref=['"]\d+['"]/gi) || []).length
    const evidBtn = (text.match(/\bbtn-success\b|\bbtn-danger\b/gi) || []).length
    console.log(`[TesteParser] forid=${forid} evidRef=${evidRef} evidBtn=${evidBtn} marker=${text.includes('fornecedor-editar-servicos')}`)

    const outPath = path.join(process.cwd(), `.tmp-fornecedores-editar-forid-${forid}.html`)
    fs.writeFileSync(outPath, text, 'utf8')
    console.log(`[TesteParser] forid=${forid} html salvo em ${path.basename(outPath)}`)

    let itens = []
    try {
      itens = extrairItensFornecedorEditar(text)
      console.log(`[TesteParser] forid=${forid} itens_parseados=${itens.length}`)
      console.log('[TesteParser] amostra:', itens.slice(0, 3))
    } catch (err) {
      console.error(`[TesteParser] forid=${forid} ERRO parser:`, err.message)
    }
  }
}

main().catch(err => {
  console.error('[TesteParser] ERRO fatal:', err.message)
  process.exit(1)
})

