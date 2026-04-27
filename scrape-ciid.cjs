'use strict'

/**
 * scrape-ciid.cjs
 * Script para vasculhar a rota de credenciamentos disponíveis
 * Extrai todos os ciid presentes no HTML de ~60k
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─────────────────────────────────────────────────────────────
// GERENCIADOR DE COOKIES
// ─────────────────────────────────────────────────────────────
class GerenciadorCookies {
  constructor() {
    this.cookies = {};
  }

  adicionarDeCookie(setCookieStr) {
    if (!setCookieStr) return;
    
    const partes = setCookieStr.split(';')[0].split('=');
    if (partes.length >= 2) {
      const nome = partes[0].trim();
      const valor = partes.slice(1).join('=').trim();
      this.cookies[nome] = valor;
    }
  }

  adicionarDeHeaders(headers) {
    const setCookie = headers['set-cookie'] || [];
    if (typeof setCookie === 'string') {
      this.adicionarDeCookie(setCookie);
    } else if (Array.isArray(setCookie)) {
      setCookie.forEach(cookie => this.adicionarDeCookie(cookie));
    }
  }

  obterString() {
    return Object.entries(this.cookies)
      .map(([nome, valor]) => `${nome}=${valor}`)
      .join('; ');
  }

  obter(nome) {
    return this.cookies[nome];
  }

  listar() {
    console.log('[Cookies] Cookie jar atual:');
    Object.entries(this.cookies).forEach(([nome, valor]) => {
      console.log(`  ${nome}=${valor.substring(0, 20)}...`);
    });
  }
}

// ─────────────────────────────────────────────────────────────
// COMPILAÇÃO POSTERIOR — usada por fazerRequisicao
// ─────────────────────────────────────────────────────────────
let _gerenciadorCookies = new GerenciadorCookies();
const CONFIG = {
  BASE_URL: 'https://cimcero.pentagono.info',
  DASH_URL: 'https://cimcero.pentagono.info/dash',
  LOGIN_PAGE: 'https://cimcero.pentagono.info/P5fw/login',
  ACMANAGER: 'https://cimcero.pentagono.info/P5fw/acmanager',
  
  // Credenciais (IMPORTANTE: nunca commitar isso em produção!)
  USERNAME: 'EMANUEL',
  PASSWORD: 'efcr080799'
};

// ─────────────────────────────────────────────────────────────
// Faz request HTTP/HTTPS com suporte a cookies
// ─────────────────────────────────────────────────────────────
function fazerRequisicao(urlStr, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    
    // Inclui cookies automaticamente nas requisições
    const headersCookie = _gerenciadorCookies.obterString();
    
    const opcoesReq = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opcoes.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Connection': 'keep-alive',
        ...(headersCookie && { 'Cookie': headersCookie }),
        ...opcoes.headers
      },
      timeout: 30000
    };

    const req = client.request(opcoesReq, (res) => {
      let data = '';
      
      // Captura novos cookies da resposta
      _gerenciadorCookies.adicionarDeHeaders(res.headers);
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (opcoes.body) {
      req.write(opcoes.body);
    }
    
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// Step 1: Faz login e captura PHPSESSID
// ─────────────────────────────────────────────────────────────
async function fazerLogin() {
  console.log('[Login] Iniciando autenticação...');
  
  // POST com credenciais
  const body = new URLSearchParams({
    login: CONFIG.USERNAME,
    password: CONFIG.PASSWORD,
    acao: 'entrar'
  });

  const res = await fazerRequisicao(CONFIG.LOGIN_PAGE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body.toString()),
      'Referer': CONFIG.DASH_URL
    },
    body: body.toString()
  });

  _gerenciadorCookies.listar();
  
  const phpsessid = _gerenciadorCookies.obter('PHPSESSID');
  if (!phpsessid) {
    throw new Error('Falha ao fazer login — PHPSESSID não encontrado após autenticação');
  }

  console.log(`✓ Login realizado com sucesso`);
  console.log(`✓ PHPSESSID: ${phpsessid.substring(0, 10)}...`);
  
  // Aguarda um pouco para a sessão ser processada
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Carrega o dashboard para validar a sessão
  console.log('[Login] Carregando dashboard para validar sessão...');
  const resDash = await fazerRequisicao(CONFIG.DASH_URL, {
    headers: {
      'Referer': CONFIG.LOGIN_PAGE
    }
  });
  
  if (resDash.status !== 200 || resDash.body.includes('Autenticação')) {
    console.warn('[Login] Dashboard retornou página de autenticação novamente');
  } else {
    console.log('✓ Dashboard carregado – sessão ativa');
  }
  
  return phpsessid;
}

// ─────────────────────────────────────────────────────────────
// Step 2: Busca a página de credenciamentos disponíveis
// ─────────────────────────────────────────────────────────────
async function buscarCredenciamentosDisponiveis(page = 1, wid = 3) {
  console.log(`\n[Scrape] Buscando credenciamentos (página ${page}, wid=${wid})...`);
  
  const params = new URLSearchParams({
    action: 'credenciamentos/disponiveis',
    page: page.toString(),
    wid: wid.toString()
  });

  const url = `${CONFIG.ACMANAGER}?${params}`;
  
  const res = await fazerRequisicao(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': CONFIG.DASH_URL
    }
  });

  if (res.status !== 200) {
    throw new Error(`Erro HTTP ${res.status} ao buscar credenciamentos`);
  }

  console.log(`✓ Página recebida: ${res.body.length} bytes`);
  
  return res.body;
}

// ─────────────────────────────────────────────────────────────
// Step 3: Extrai todos os ciid do HTML
// ─────────────────────────────────────────────────────────────
function extrairCiids(html) {
  console.log(`\n[Parse] Extraindo ciid do HTML...`);
  
  // Regex para encontrar ciid='valor' ou ciid="valor"
  const regex = /ciid=['"]?(\d+)['"]?/gi;
  const ciids = new Set();
  let match;

  while ((match = regex.exec(html)) !== null) {
    ciids.add(match[1]);
  }

  const arrayFinal = Array.from(ciids).sort((a, b) => parseInt(a) - parseInt(b));
  
  console.log(`✓ ${arrayFinal.length} ciid(s) encontrado(s):`);
  console.log(`\nCIIDs únicos:`);
  arrayFinal.forEach((ciid, idx) => {
    console.log(`  ${idx + 1}. ${ciid}`);
  });

  return arrayFinal;
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  try {
    console.log('═'.repeat(60));
    console.log('  SCRAPER DE CREDENCIAMENTOS DISPONÍVEIS');
    console.log('═'.repeat(60));

    // Step 1: Login
    await fazerLogin();

    // Step 2: Buscar página de credenciamentos
    const html = await buscarCredenciamentosDisponiveis(1, 3);

    // Step 3: Extrair ciids
    const ciids = extrairCiids(html);

    // Step 4: Salvar resultado em arquivo JSON
    const fs = require('fs');
    const nomeArquivo = `ciids-${Date.now()}.json`;
    const caminhoArquivo = `./public/${nomeArquivo}`;
    const caminhoDebug = `./public/debug-html-${Date.now()}.txt`;
    
    const resultado = {
      timestamp: new Date().toISOString(),
      totalCiids: ciids.length,
      ciids: ciids,
      htmlSize: html.length
    };

    fs.writeFileSync(caminhoArquivo, JSON.stringify(resultado, null, 2));
    fs.writeFileSync(caminhoDebug, html);

    console.log(`\n✓ Resultado salvo em: ${caminhoArquivo}`);
    console.log(`\nResumo:`);
    console.log(`  - Total de CIIDs: ${ciids.length}`);
    console.log(`  - Tamanho do HTML: ${(html.length / 1024).toFixed(2)} KB`);
    
  } catch (erro) {
    console.error('\n✗ Erro:', erro.message);
    process.exit(1);
  }
}

main();
