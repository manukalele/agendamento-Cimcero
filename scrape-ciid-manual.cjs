'use strict'

/**
 * scrape-ciid-manual-login.cjs
 * Script com login manual via navegador
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CONFIGURAÃ‡ÃƒO
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CONFIG = {
  BASE_URL: 'https://cimcero.pentagono.info',
  DASH_URL: 'https://cimcero.pentagono.info/dash',
  ACMANAGER: 'https://cimcero.pentagono.info/P5fw/acmanager',
  REQUEST_DELAY_MS: 2000,
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// COOKIE JAR
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].trim().toLowerCase();
      if (attr.startsWith('path=')) {
        cookie.path = attr.substring(5);
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

  setCookieFromString(cookieString) {
    // Permite definir PHPSESSID diretamente
    const [name, ...rest] = cookieString.split('=');
    if (name && rest.length) {
      const value = rest.join('=');
      const key = `cimcero.pentagono.info:/:${name.trim()}`;
      this.cookies.set(key, {
        name: name.trim(),
        value: value.trim(),
        domain: 'cimcero.pentagono.info',
        path: '/'
      });
    }
  }

  getCookieString(url) {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;
    
    const cookieArray = [];
    
    for (const cookie of this.cookies.values()) {
      if (hostname.endsWith(cookie.domain) || hostname === cookie.domain) {
        if (pathname.startsWith(cookie.path)) {
          cookieArray.push(`${cookie.name}=${cookie.value}`);
        }
      }
    }
    
    return cookieArray.join('; ');
  }

  list() {
    console.log('[Cookies] Cookies no jar:');
    for (const cookie of this.cookies.values()) {
      console.log(`  ${cookie.name}=${cookie.value.substring(0, 30)}...`);
    }
  }
}

const jar = new CookieJar();

let filaRequisicoes = Promise.resolve();
let ultimaRequisicaoAt = 0;

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reservarSlotRequisicao() {
  const slot = filaRequisicoes.then(async () => {
    const agora = Date.now();
    const elapsed = agora - ultimaRequisicaoAt;
    const aguardar = Math.max(0, CONFIG.REQUEST_DELAY_MS - elapsed);
    if (aguardar > 0) {
      await esperar(aguardar);
    }
    ultimaRequisicaoAt = Date.now();
  });

  filaRequisicoes = slot.catch(() => {});
  return slot;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Request com descompressÃ£o
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fazerRequisicao(urlStr, opcoes = {}) {
  await reservarSlotRequisicao();

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
        ...(cookieStr && { 'Cookie': cookieStr }),
        ...opcoes.headers
      },
      timeout: 30000
    };

    const req = client.request(opcoesReq, (res) => {
      let data = Buffer.alloc(0);
      
      jar.addFromSetCookieHeaders(res.headers, urlStr);
      
      res.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
      });
      
      res.on('end', () => {
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Interface interativa
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function lerDoTerminal(pergunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(pergunta, (resposta) => {
      rl.close();
      resolve(resposta.trim());
    });
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tenta ler sessÃ£o salva (como o app Electron faz)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function lerSessaoSalva() {
  try {
    const sessaoPath = path.join(
      process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
      'agendamentos-electron',
      'sessao.json'
    );
    
    if (fs.existsSync(sessaoPath)) {
      const dados = JSON.parse(fs.readFileSync(sessaoPath, 'utf-8'));
      if (dados.cookies && dados.cookies[0]) {
        return dados.cookies[0].value;
      }
    }
  } catch (err) {
    console.warn(`[SessÃ£o] Erro ao ler sessÃ£o salva: ${err.message}`);
  }
  return null;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Abre navegador
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function abrirNavegador() {
  const url = CONFIG.DASH_URL;
  const cmd = process.platform === 'win32' 
    ? `start ${url}`
    : process.platform === 'darwin'
    ? `open ${url}`
    : `xdg-open ${url}`;
  
  exec(cmd);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Step 1: Login manual
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fazerLoginManual() {
  console.log('\n' + 'â•'.repeat(70));
  console.log('  LOGIN MANUAL NECESSÃRIO');
  console.log('â•'.repeat(70));
  
  // Tenta ler sessÃ£o jÃ¡ salva
  const sessaoSalva = lerSessaoSalva();
  if (sessaoSalva) {
    console.log(`âœ“ SessÃ£o salva encontrada: ${sessaoSalva.substring(0, 20)}...`);
    const usarWv = await lerDoTerminal('Usar sessÃ£o salva? (s/n): ');
    if (usarWv.toLowerCase() === 's') {
      jar.setCookieFromString(`PHPSESSID=${sessaoSalva}`);
      return true;
    }
  }
  
  console.log('\nðŸ“ Por favor, siga os passos abaixo:\n');
  console.log('1. Um navegador serÃ¡ aberto');
  console.log('2. FaÃ§a login com suas credenciais');
  console.log('3. ApÃ³s login bem-sucedido:');
  console.log('   - Abra as Developer Tools (F12)');
  console.log('   - VÃ¡ atÃ© a aba "Application" â†’ "Cookies"');
  console.log('   - Procure por "cimcero.pentagono.info"');
  console.log('   - Copie o valor do cookie "PHPSESSID"\n');
  
  abrirNavegador();
  console.log('âœ“ Navegador aberto em:', CONFIG.DASH_URL);
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const phpsessid = await lerDoTerminal('\nCole o PHPSESSID aqui: ');
  
  if (!phpsessid || phpsessid.length < 20) {
    throw new Error('PHPSESSID invÃ¡lido â€” deve ter mais de 20 caracteres');
  }
  
  jar.setCookieFromString(`PHPSESSID=${phpsessid}`);
  console.log('âœ“ PHPSESSID configurado:', phpsessid.substring(0, 20) + '...');
  
  // Valida a sessÃ£o
  console.log('\n[ValidaÃ§Ã£o] Testando a sessÃ£o...');
  try {
    const params = new URLSearchParams({
      action: 'credenciamentos/search',
      term: 'hemograma',
      forid: '2',
      credid: '0',
      pritens: '',
      _: Date.now().toString()
    });
    
    const res = await fazerRequisicao(`${CONFIG.ACMANAGER}?${params}`, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': CONFIG.DASH_URL
      }
    });
    
    if (res.status === 200 && res.body.length > 10) {
      console.log('âœ“ SessÃ£o validada com sucesso!');
      return true;
    }
  } catch (err) {
    throw new Error(`Falha ao validar sessÃ£o: ${err.message}`);
  }
  
  return true;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Step 2: Busca credenciamentos disponiveis
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function buscarCredenciamentosDisponiveis(page = 1, wid = 3) {
  console.log(`\n[Scrape] Buscando credenciamentos (pÃ¡gina ${page}, wid=${wid})...`);
  
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

  console.log(`âœ“ PÃ¡gina recebida: ${(res.body.length / 1024).toFixed(2)} KB`);
  
  return res.body;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Step 3: Extrai CIIDs
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function extrairCiids(html) {
  console.log(`\n[Parse] Extraindo ciid do HTML...`);
  
  const regex = /ciid\s*=\s*['"]?(\d+)['"]?/gi;
  const ciids = new Set();
  let match;

  while ((match = regex.exec(html)) !== null) {
    ciids.add(match[1]);
  }

  const arrayFinal = Array.from(ciids).sort((a, b) => parseInt(a) - parseInt(b));
  
  console.log(`âœ“ ${arrayFinal.length} ciid(s) Ãºnico(s) encontrado(s)`);
  
  return arrayFinal;
}
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function buscarPrestadoresParaCiid(ciid) {
  console.log(`[Prestadores] Buscando prestadores para CIID ${ciid}...`);
  
  const params = new URLSearchParams({
    action: 'credenciamentos/disponiveis_getPrestadores',
    ciid: ciid.toString()
  });

  const url = `${CONFIG.ACMANAGER}?${params}`;
  
  const res = await fazerRequisicao(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': CONFIG.DASH_URL
    }
  });

  if (res.status !== 200) {
    throw new Error(`Erro HTTP ${res.status} ao buscar prestadores para CIID ${ciid}`);
  }

  try {
    const dados = JSON.parse(res.body);
    
    if (!dados.response || !dados.prestadores) {
      console.warn(`[Prestadores] Resposta invÃ¡lida para CIID ${ciid}: ${res.body.substring(0, 100)}`);
      return [];
    }

    // Extrair apenas os campos necessÃ¡rios
    const prestadores = dados.prestadores.map(p => ({
      id: p.id,
      citemid: p.citemid,
      forid: p.forid,
      valor: p.valor,
      nome: p.nome?.trim() || '',
      orientacao: p.orientacao?.trim() || '',
      sid: p.sid
    }));

    console.log(`âœ“ CIID ${ciid}: ${prestadores.length} prestadores encontrados`);
    return prestadores;
    
  } catch (err) {
    console.warn(`[Prestadores] Erro ao parsear JSON para CIID ${ciid}: ${err.message}`);
    return [];
  }
}

function extrairForidsUnicos(todosPrestadores) {
  const setForids = new Set();
  for (const prestadores of todosPrestadores) {
    for (const p of prestadores) {
      if (p?.forid !== undefined && p?.forid !== null && String(p.forid).trim() !== '') {
        setForids.add(String(p.forid).trim());
      }
    }
  }
  return Array.from(setForids).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

function normalizarFornecedor(f) {
  const enderecos = Array.isArray(f?.enderecos)
    ? f.enderecos.map(e => ({
        id: e?.id ?? null,
        logradouro: e?.logradouro ?? null,
        complemento: e?.complemento ?? null,
        bairro: e?.bairro ?? null,
        cep: e?.cep ?? null,
        cidade: e?.cidade ?? null
      }))
    : [];

  return {
    id: f?.id ?? null,
    nome: f?.nome ?? null,
    telefone: f?.telefone ?? null,
    celular: f?.celular ?? null,
    email: f?.email ?? null,
    razao: f?.razao ?? null,
    cpfcnpj: f?.cpfcnpj ?? null,
    cnes: f?.cnes ?? null,
    mtdopgto: f?.mtdopgto ?? null,
    habilitado: f?.habilitado ?? null,
    trash: f?.trash ?? null,
    irrfisento: f?.irrfisento ?? null,
    irrfaliquota: f?.irrfaliquota ?? null,
    imagem: f?.imagem ?? null,
    cidade: f?.cidade ?? null,
    horariolivre: f?.horariolivre ?? null,
    emaillisten: f?.emaillisten ?? null,
    agendamentoFullAccess: f?.agendamentoFullAccess ?? null,
    email_contabil: f?.email_contabil ?? null,
    contrato: f?.contrato ?? null,
    created_at: f?.created_at ?? null,
    tempo_altera_guia: f?.tempo_altera_guia ?? null,
    troca_data: f?.troca_data ?? null,
    simples: f?.simples ?? null,
    logradouro: f?.logradouro ?? null,
    numero: f?.numero ?? null,
    bairro: f?.bairro ?? null,
    complemento: f?.complemento ?? null,
    cep: f?.cep ?? null,
    show_vagas: f?.show_vagas ?? null,
    feedback: f?.feedback ?? null,
    precancel: f?.precancel ?? null,
    allow_qtde_cfm: f?.allow_qtde_cfm ?? null,
    enderecos
  };
}

async function buscarFornecedorPorForid(forid) {
  const params = new URLSearchParams({
    action: 'fornecedores/getdata',
    forid: String(forid)
  });

  const url = `${CONFIG.ACMANAGER}?${params}`;
  const res = await fazerRequisicao(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': CONFIG.DASH_URL
    }
  });

  if (res.status !== 200) {
    throw new Error(`Erro HTTP ${res.status} ao buscar fornecedor ${forid}`);
  }

  let dados;
  try {
    dados = JSON.parse(res.body);
  } catch (err) {
    throw new Error(`JSON invalido no fornecedor ${forid}: ${err.message}`);
  }

  const bruto =
    (dados && dados.id ? dados : null) ||
    (dados && dados.fornecedor ? dados.fornecedor : null) ||
    (dados && dados.data ? dados.data : null) ||
    (dados && dados.response && dados.fornecedor ? dados.fornecedor : null) ||
    (dados && dados.response && dados.data ? dados.data : null);

  if (!bruto || !bruto.id) {
    throw new Error(`Resposta sem dados de fornecedor para forid ${forid}`);
  }

  return normalizarFornecedor(bruto);
}

async function buscarFornecedoresPorForids(forids) {
  console.log(`\n[Fornecedores] Buscando cadastro completo de ${forids.length} forid(s)...`);
  const fornecedores = [];
  const erros = [];

  for (let i = 0; i < forids.length; i++) {
    const forid = forids[i];
    try {
      const fornecedor = await buscarFornecedorPorForid(forid);
      fornecedores.push(fornecedor);
      if ((i + 1) % 25 === 0 || i + 1 === forids.length) {
        console.log(`[Fornecedores] Progresso: ${i + 1}/${forids.length}`);
      }
    } catch (err) {
      erros.push({ forid, erro: err.message });
      console.warn(`[Fornecedores] Erro no forid ${forid}: ${err.message}`);
    }
  }

  fornecedores.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  console.log(`[Fornecedores] Concluido: ${fornecedores.length} sucesso(s), ${erros.length} erro(s)`);

  return { fornecedores, erros };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Step 4: Monta estrutura igual ao banco.json
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function montarEstruturaBanco(ciids, todosPrestadores, clinicas = []) {
  console.log(`\n[Montagem] Montando estrutura de banco...`);
  
  // Agrupar prestadores por nome do exame (usando o primeiro prestador como referÃªncia)
  const examesMap = new Map();
  
  for (const prestadores of todosPrestadores) {
    if (prestadores.length === 0) continue;
    
    // Usar o nome do primeiro prestador como chave
    const nomeExame = prestadores[0].nome;
    if (!nomeExame) continue;
    
    // Criar entrada de exame
    const exame = {
      nome_parametro: nomeExame,
      nome_real: nomeExame,
      clinicas: prestadores.map(p => ({
        clinica_id: p.forid,
        id_exame_clinica: parseInt(p.id),
        preco: parseInt(p.valor)
      }))
    };
    
    examesMap.set(nomeExame, exame);
  }
  
  const exames = Array.from(examesMap.values());
  
  // Estrutura final igual ao banco.json
  const banco = {
    clinicas: clinicas,
    exames: exames
  };
  
  console.log(`âœ“ Estrutura montada: ${exames.length} exames, ${ciids.length} CIIDs processados`);
  
  return banco;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Step 5: Processa todos os CIIDs de forma sequencial (1 por vez)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function processarTodosCiids(ciids, maxConcurrent = 1) {
  console.log(`\n[Processamento] Iniciando processamento de ${ciids.length} CIIDs...`);
  console.log('[Processamento] Modo sequencial: 1 request por vez');
  
  const todosPrestadores = [];
  const progressoPath = `./public/progresso-${Date.now()}.json`;
  
  let processados = 0;
  let erros403 = 0;
  let errosOutros = 0;
  const total = ciids.length;
  let ultimoSalvamento = Date.now();
  
  for (const ciid of ciids) {
    try {
      const prestadores = await buscarPrestadoresParaCiid(ciid);
      todosPrestadores.push(prestadores);
      processados++;

      if (processados % 50 === 0 || processados === total) {
        const progresso = Math.round(processados/total*100);
        console.log(`[Processamento] Progresso: ${processados}/${total} CIIDs (${progresso}%) - Erros 403: ${erros403}`);
      }

      // Salva progresso parcial a cada 100 processados ou 5 minutos
      if (processados % 100 === 0 || Date.now() - ultimoSalvamento > 5 * 60 * 1000) {
        salvarProgressoParcial(progressoPath, ciids, todosPrestadores, processados);
        ultimoSalvamento = Date.now();
      }
    } catch (err) {
      if (err.message.includes('403')) {
        erros403++;
      } else {
        errosOutros++;
      }

      console.warn(`[Processamento] Erro no CIID ${ciid}: ${err.message}`);
      todosPrestadores.push([]); // Mantem o indice alinhado com CIIDs
      processados++;
    }

    // Revalida sessao a cada 30 CIIDs processados
    if (processados % 30 === 0 && processados < total) {
      console.log(`[SessÃ£o] Revalidando sessÃ£o...`);
      try {
        const params = new URLSearchParams({
          action: 'credenciamentos/search',
          term: 'hemograma',
          forid: '2',
          credid: '0',
          pritens: '',
          _: Date.now().toString()
        });
        
        const res = await fazerRequisicao(`${CONFIG.ACMANAGER}?${params}`, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': CONFIG.DASH_URL
          }
        });
        
        if (res.status !== 200) {
          console.warn(`[SessÃ£o] RevalidaÃ§Ã£o falhou (HTTP ${res.status}) â€” sessÃ£o pode ter expirado`);
        } else {
          console.log(`[SessÃ£o] SessÃ£o revalidada com sucesso`);
        }
      } catch (err) {
        console.warn(`[SessÃ£o] Erro na revalidaÃ§Ã£o: ${err.message}`);
      }
    }
  }
  
  // Salva progresso final
  salvarProgressoParcial(progressoPath, ciids, todosPrestadores, processados);
  
  console.log(`\n[Processamento] Finalizado:`);
  console.log(`  â€¢ Sucessos: ${processados - erros403 - errosOutros}`);
  console.log(`  â€¢ Erros 403: ${erros403}`);
  console.log(`  â€¢ Outros erros: ${errosOutros}`);
  
  return todosPrestadores;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Salva progresso parcial
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function salvarProgressoParcial(caminho, ciids, todosPrestadores, processados) {
  try {
    const fs = require('fs');
    const progresso = {
      timestamp: new Date().toISOString(),
      totalCiids: ciids.length,
      processados: processados,
      progressoPercentual: Math.round(processados / ciids.length * 100),
      ciidsProcessados: ciids.slice(0, processados),
      prestadores: todosPrestadores
    };
    
    fs.writeFileSync(caminho, JSON.stringify(progresso, null, 2));
    console.log(`[Progresso] Salvo em: ${caminho}`);
  } catch (err) {
    console.warn(`[Progresso] Erro ao salvar: ${err.message}`);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MAIN
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  try {
    console.log('\n' + 'â•'.repeat(80));
    console.log('  SCRAPER COMPLETO DE CREDENCIAMENTOS');
    console.log('  (CIIDs + Prestadores â†’ Estrutura Banco)');
    console.log('â•'.repeat(80));

    // Step 1: Login manual
    await fazerLoginManual();

    // Step 2: Buscar credenciamentos e extrair CIIDs
    console.log('\n' + 'â”€'.repeat(60));
    console.log('  FASE 1: EXTRAÃ‡ÃƒO DE CIIDs');
    console.log('â”€'.repeat(60));
    
    const html = await buscarCredenciamentosDisponiveis(1, 3);
    const ciids = extrairCiids(html);

    // Step 3: Processar todos os CIIDs para obter prestadores
    console.log('\n' + 'â”€'.repeat(60));
    console.log('  FASE 2: PROCESSAMENTO DE PRESTADORES');
    console.log('â”€'.repeat(60));
    
    const todosPrestadores = await processarTodosCiids(ciids, 1);

    // Step 4: Extrair forids unicos e buscar fornecedores
    console.log('\n' + '-'.repeat(60));
    console.log('  FASE 3: COLETA DE FORNECEDORES');
    console.log('-'.repeat(60));
    const foridsUnicos = extrairForidsUnicos(todosPrestadores);
    console.log(`[Fornecedores] ${foridsUnicos.length} forid(s) unicos identificados`);
    const { fornecedores, erros: errosFornecedores } = await buscarFornecedoresPorForids(foridsUnicos);

    // Step 5: Montar estrutura final do banco-completo
    console.log('\n' + '-'.repeat(60));
    console.log('  FASE 4: MONTAGEM DA ESTRUTURA');
    console.log('-'.repeat(60));
    const bancoEstrutura = montarEstruturaBanco(ciids, todosPrestadores, fornecedores);

    // Step 6: Salvar resultados
    const fs = require('fs');
    const timestamp = Date.now();
    
    // Salvar CIIDs
    const nomeArquivoCiids = `ciids-resultado-${timestamp}.json`;
    const caminhoCiids = `./public/${nomeArquivoCiids}`;
    const resultadoCiids = {
      timestamp: new Date().toISOString(),
      totalCiids: ciids.length,
      ciids: ciids,
      htmlSize: html.length
    };
    fs.writeFileSync(caminhoCiids, JSON.stringify(resultadoCiids, null, 2));

    // Salvar estrutura completa do banco
    const nomeArquivoBanco = `banco-completo-${timestamp}.json`;
    const caminhoBanco = `./public/${nomeArquivoBanco}`;
    fs.writeFileSync(caminhoBanco, JSON.stringify(bancoEstrutura, null, 2));

    // Salvar HTML de debug
    const caminhoDebug = `./public/debug-html-${timestamp}.txt`;
    fs.writeFileSync(caminhoDebug, html);

    console.log('\n' + 'â•'.repeat(80));
    console.log('  RESULTADO FINAL');
    console.log('â•'.repeat(80));
    
    console.log(`\nðŸ“Š CIIDs extraÃ­dos:`);
    console.log(`  â€¢ Total: ${ciids.length}`);
    console.log(`  â€¢ Arquivo: ${nomeArquivoCiids}`);
    
    console.log(`\nðŸ—ï¸  Estrutura banco montada:`);
    console.log(`  â€¢ Fornecedores: ${bancoEstrutura.clinicas.length}`);
    console.log(`  â€¢ Exames: ${bancoEstrutura.exames.length}`);
    console.log(`  â€¢ Arquivo: ${nomeArquivoBanco}`);
    
    // EstatÃ­sticas dos exames
    const totalClinicas = new Set();
    let totalPrecos = 0;
    
    for (const exame of bancoEstrutura.exames) {
      for (const clinica of exame.clinicas) {
        totalClinicas.add(clinica.clinica_id);
        totalPrecos++;
      }
    }
    
    console.log(`  â€¢ ClÃ­nicas Ãºnicas: ${totalClinicas.size}`);
    console.log(`  â€¢ Total de preÃ§os: ${totalPrecos}`);

    if (errosFornecedores.length) {
      console.log(`\nâš ï¸  Fornecedores com erro: ${errosFornecedores.length}`);
    }
    
    console.log(`\nðŸ’¾ Arquivos salvos:`);
    console.log(`  â€¢ CIIDs: ./public/${nomeArquivoCiids}`);
    console.log(`  â€¢ Banco: ./public/${nomeArquivoBanco}`);
    console.log(`  â€¢ Debug: ./public/debug-html-${timestamp}.txt`);
    
    console.log('\nâœ… SCRAPING COMPLETO FINALIZADO COM SUCESSO!\n');
    
  } catch (erro) {
    console.error('\nâœ— Erro:', erro.message);
    if (erro.stack) {
      console.error(erro.stack);
    }
    process.exit(1);
  }
}

main();

