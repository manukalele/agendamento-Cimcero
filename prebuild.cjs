'use strict'
// ─────────────────────────────────────────────────────────────
// prebuild.cjs — executado automaticamente pelo npm antes de
// cada "npm run build" (via script "prebuild" no package.json).
//
// O que faz:
//   1. Incrementa a versão patch no package.json
//      (1.0.0 → 1.0.1 → 1.0.2 …)
//   2. Gera um BUILD_ID único baseado em timestamp
//   3. Injeta esse BUILD_ID como constante no main.cjs,
//      substituindo o valor anterior
//
// Isso garante que cada "npm run build" produza um instalador
// com BUILD_ID diferente do anterior, forçando a limpeza de
// sessões de ambiente de desenvolvimento na primeira execução
// do app instalado — independentemente de o número de versão
// ter sido alterado manualmente.
// ─────────────────────────────────────────────────────────────

const fs   = require('fs')
const path = require('path')

// ── 1. Incrementa versão patch no package.json ───────────────
const pkgPath = path.resolve(__dirname, 'package.json')
const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

const partes  = (pkg.version || '1.0.0').split('.').map(Number)
partes[2]     = (partes[2] || 0) + 1          // patch++
pkg.version   = partes.join('.')

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
console.log(`[prebuild] Versão atualizada: ${pkg.version}`)

// ── 2. Gera BUILD_ID único ────────────────────────────────────
const buildId = Date.now().toString()
console.log(`[prebuild] BUILD_ID gerado: ${buildId}`)

// ── 3. Injeta BUILD_ID no main.cjs ───────────────────────────
const mainPath    = path.resolve(__dirname, 'main.cjs')
let   mainContent = fs.readFileSync(mainPath, 'utf-8')

// Substitui qualquer valor existente na linha:
//   const BUILD_ID = '...'
// Se a linha ainda não existir, o main.cjs deve tê-la — ver comentário abaixo.
const regex = /^(const BUILD_ID\s*=\s*')[^']*(')/m

if (!regex.test(mainContent)) {
  console.error('[prebuild] ERRO: linha "const BUILD_ID = \'...\'" não encontrada no main.cjs.')
  console.error('[prebuild] Adicione a linha manualmente após os requires iniciais e rode novamente.')
  process.exit(1)
}

mainContent = mainContent.replace(regex, `$1${buildId}$2`)
fs.writeFileSync(mainPath, mainContent, 'utf-8')
console.log(`[prebuild] BUILD_ID injetado no main.cjs`)
