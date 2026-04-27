'use strict'

/**
 * scrape-ciid-v2.cjs
 * Script melhorado com suporte a follow-redirects e jar de cookies
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const querystring = require('querystring');
const zlib = require('zlib');

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  BASE_URL: 'https://cimcero.pentagono.info',
  DASH_URL: 'https://cimcero.pentagono.info/dash',
  LOGIN_PAGE: 'https://cimcero.pentagono.info/P5fw/login',
  ACMANAGER: 'https://cimcero.pentagono.info/P5fw/acmanager',
  
  USERNAME: 'EMANUEL',
  PASSWORD: 'efcr080799'
};

// ─────────────────────────────────────────────────────────────
// COOKIE JAR COM SUPORTE A TERCEIRA ORDEM
// ─────────────────────────────────────────────────────────────
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  parseCookie(cookieStr, url) {
    const parts = cookieStr.split(';');
    const [namVal] = parts;
    const [name, value] = namVal.split('=').map(s => s.trim());
    
    if (!name) return null;
    
    const cookie = {
      name: name,
      value: value,
      domain: new URL(url).hostname,
      path: '/'
    };

    // Parse attributes
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].trim().toLowerCase();
      if (attr.startsWith('path=')) {
        cookie.path = attr.substring(5);
      } else if (attr.startsWith('domain=')) {
        cookie.domain = attr.substring(7);
      } else if (attr.startsWith('expires=')) {
        cookie.expires = new Date(attr.substring(8));
      }
    }
    
    return cookie;
  }

  addCookie(cookieStr, url) {
    const cookie = this.parseCookie(cookieStr, url);
    if (cookie && cookie.name) {
      const key = `${cookie.domain}:${cookie.path}:${cookie.name}`;
      this.cookies.set(key, cookie);
    }
  }

  addFromSetCookieHeaders(headers, url) {
    const setCookie = headers['set-cookie'] || [];
    const setCookieArray = Array.isArray(setCookie) ? setCookie : [setCookie];
    
    for (const cookie of setCookieArray) {
      if (cookie) {
        this.addCookie(cookie, url);
      }
    }
  }

  getCookieString(url) {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;
    
    const cookieArray = [];
    
    for (const cookie of this.cookies.values()) {
      // Match by domain and path
      if (hostname.endsWith(cookie.domain) || hostname === cookie.domain) {
        if (pathname.startsWith(cookie.path)) {
          // Check if expired
          if (cookie.expires && cookie.expires < new Date()) {
            continue;
          }
          cookieArray.push(`${cookie.name}=${cookie.value}`);
        }
      }
    }
    
    return cookieArray.join('; ');
  }

  list() {
    console.log('[Cookies] Jar de cookies:');
    for (const cookie of this.cookies.values()) {
      console.log(`  ${cookie.name}=${cookie.value.substring(0, 20)}... (domain=${cookie.domain})`);
    }
  }
}

const jar = new CookieJar();

// ─────────────────────────────────────────────────────────────
// Faz request HTTP/HTTPS com suporte a compressão
// ─────────────────────────────────────────────────────────────
function fazerRequisicao(urlStr, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const cookieStr = jar.getCookieString(urlStr);
    
    const opcoesReq = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opcoes.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        ...(cookieStr && { 'Cookie': cookieStr }),
        ...opcoes.headers
      },
      timeout: 30000
    };

    const req = client.request(opcoesReq, (res) => {
      let data = Buffer.alloc(0);
      
      // Captura cookies da resposta
      jar.addFromSetCookieHeaders(res.headers, urlStr);
      
      res.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
      });
      
      res.on('end', () => {
        // Descompacta se necessário
        const contentEncoding = res.headers['content-encoding'] || '';
        
        if (contentEncoding.includes('gzip')) {
          zlib.gunzip(data, (err, decompressed) => {
            if (err) {
              reject(err);
            } else {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: decompressed.toString('utf-8')
              });
            }
          });
        } else if (contentEncoding.includes('deflate')) {
          zlib.inflate(data, (err, decompressed) => {
            if (err) {
              reject(err);
            } else {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: decompressed.toString('utf-8')
              });
            }
          });
        } else {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data.toString('utf-8')
          });
        }
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
// Step 1: Faz login
// ─────────────────────────────────────────────────────────────
async function fazerLogin() {
  console.log('[Login] Iniciando autenticação...');
  
  // Step 1a: GET login para capturar cookies iniciais e tokens CSRF
  console.log('[Login] Acessando página de login...');
  const resLogin1 = await fazerRequisicao(CONFIG.LOGIN_PAGE, {
    headers: {
      'Referer': CONFIG.BASE_URL
    }
  });
  
  jar.list();
  
  // Parse para encontrar tokens CSRF ou outros valores ocultos
  const tokenMatch = resLogin1.body.match(/name="([^"]+)"\s+value="([^"]+)"/g) || [];
  console.log(`[Login] Campos ocultos encontrados: ${tokenMatch.length}`);
  
  // Step 1b: POST com credenciais
  const body = new URLSearchParams({
    login: CONFIG.USERNAME,
    password: CONFIG.PASSWORD,
    acao: 'entrar'
  });

  console.log('[Login] Enviando credenciais...');
  const resLogin2 = await fazerRequisicao(CONFIG.LOGIN_PAGE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body.toString()),
      'Referer': CONFIG.LOGIN_PAGE,
      'Origin': CONFIG.BASE_URL
    },
    body: body.toString()
  });

  jar.list();
  console.log(`✓ Credenciais enviadas — resposta HTTP ${resLogin2.status}`);
  
  // Verifica se a resposta contém redirecionamento ou conteúdo de erro
  if (resLogin2.body.includes('Autenticação') && resLogin2.body.includes('g-recaptcha')) {
    console.warn('[Login] Servidor retornou página de login novamente — pode ser reCAPTCHA.');
    console.warn('[Login] Alternativamente, credenciais podem estar incorretas');
  }
  
  // Aguarda um pouco para a sessão ser processada
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Step 1c: Tenta acessar o dashboard para validar
  console.log('[Login] Acessando dashboard...');
  const resDash = await fazerRequisicao(CONFIG.DASH_URL, {
    headers: {
      'Referer': CONFIG.LOGIN_PAGE
    }
  });
  
  console.log(`[Login] Dashboard HTTP ${resDash.status} — resposta: ${resDash.body.substring(0, 150)}`);
  
  // Mais flexível na detecção — se tem conteúdo e não está vazio
  if (resDash.body.length > 500 && !resDash.body.includes('g-recaptcha')) {
    if (!resDash.body.includes('Agendamentos') && resDash.body.includes('Autenticação')) {
      throw new Error('Ainda em login — credenciais rejeitadas ou reCAPTCHA necessário');
    }
    console.log('✓ Dashboard carregado – possível sessão ativa');
    return true;
  }
  
  throw new Error(`Falha ao acessar dashboard — resposta: ${resDash.body.substring(0, 100)}...`);
}

// ─────────────────────────────────────────────────────────────
// Step 2: Busca credenciamentos disponíveis
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

  console.log(`✓ Página recebida: ${(res.body.length / 1024).toFixed(2)} KB`);
  
  return res.body;
}

// ─────────────────────────────────────────────────────────────
// Step 3: Extrai CIIDs
// ─────────────────────────────────────────────────────────────
function extrairCiids(html) {
  console.log(`\n[Parse] Extraindo ciid do HTML...`);
  
  // Regex para encontrar ciid estando dentro de atributos
  // Suporta: ciid='valor', ciid="valor", ciid=valor
  const regex = /ciid\s*=\s*['"]?(\d+)['"]?/gi;
  const ciids = new Set();
  let match;

  while ((match = regex.exec(html)) !== null) {
    ciids.add(match[1]);
  }

  const arrayFinal = Array.from(ciids).sort((a, b) => parseInt(a) - parseInt(b));
  
  console.log(`✓ ${arrayFinal.length} ciid(s) único(s) encontrado(s)`);
  
  if (arrayFinal.length === 0 && html.length < 500) {
    console.warn('[Parse] HTML muito pequeno — possível erro');
  }
  
  return arrayFinal;
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  try {
    console.log('═'.repeat(60));
    console.log('  SCRAPER DE CREDENCIAMENTOS DISPONÍVEIS (v2)');
    console.log('═'.repeat(60));

    // Step 1: Login
    await fazerLogin();

    // Step 2: Buscar credenciamentos
    const html = await buscarCredenciamentosDisponiveis(1, 3);

    // Step 3: Extrair CIIDs
    const ciids = extrairCiids(html);

    // Step 4: Salvar resultado
    const fs = require('fs');
    const nomeArquivo = `ciids-resultado-${Date.now()}.json`;
    const caminhoArquivo = `./public/${nomeArquivo}`;
    const caminhoDebug = `./public/debug-html-v2-${Date.now()}.txt`;
    
    const resultado = {
      timestamp: new Date().toISOString(),
      totalCiids: ciids.length,
      ciids: ciids,
      htmlSize: html.length
    };

    fs.writeFileSync(caminhoArquivo, JSON.stringify(resultado, null, 2));
    fs.writeFileSync(caminhoDebug, html);

    console.log(`\n✓ Resultado salvo em: ${nomeArquivo}`);
    console.log(`✓ Debug HTML salvo em: debug-html-v2-${Date.now()}.txt`);
    console.log(`\nResumo:`);
    console.log(`  - Total de CIIDs: ${ciids.length}`);
    console.log(`  - Tamanho do HTML: ${(html.length / 1024).toFixed(2)} KB`);
    
    if (ciids.length > 0) {
      console.log(`\nPrimeiros 10 CIIDs: ${ciids.slice(0, 10).join(', ')}`);
      if (ciids.length > 10) {
        console.log(`... e mais ${ciids.length - 10}`);
      }
    }
    
  } catch (erro) {
    console.error('\n✗ Erro:', erro.message);
    console.error(erro.stack);
    process.exit(1);
  }
}

main();
