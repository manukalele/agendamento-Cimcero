'use strict'

/**
 * scrape-ciid-teste.cjs
 * Versão de teste que processa apenas os primeiros 10 CIIDs
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  BASE_URL: 'https://cimcero.pentagono.info',
  DASH_URL: 'https://cimcero.pentagono.info/dash',
  ACMANAGER: 'https://cimcero.pentagono.info/P5fw/acmanager',
};

// ─────────────────────────────────────────────────────────────
// COOKIE JAR
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

// ─────────────────────────────────────────────────────────────
// Request com descompressão
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

// ─────────────────────────────────────────────────────────────
// Busca prestadores para um CIID
// ─────────────────────────────────────────────────────────────
async function buscarPrestadoresParaCiid(ciid) {
  console.log(`[Prestadores] Buscando CIID ${ciid}...`);
  
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
      console.warn(`[Prestadores] Resposta inválida para CIID ${ciid}`);
      return [];
    }

    const prestadores = dados.prestadores.map(p => ({
      id: p.id,
      citemid: p.citemid,
      forid: p.forid,
      valor: p.valor,
      nome: p.nome?.trim() || '',
      orientacao: p.orientacao?.trim() || '',
      sid: p.sid
    }));

    console.log(`✓ CIID ${ciid}: ${prestadores.length} prestadores`);
    return prestadores;
    
  } catch (err) {
    console.warn(`[Prestadores] Erro ao parsear JSON para CIID ${ciid}: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN - Teste com primeiros 10 CIIDs
// ─────────────────────────────────────────────────────────────
async function main() {
  try {
    console.log('═'.repeat(60));
    console.log('  TESTE SCRAPER - Primeiros 10 CIIDs');
    console.log('═'.repeat(60));

    // Carrega CIIDs do arquivo mais recente
    const fs = require('fs');
    const path = require('path');
    
    const publicDir = path.join(__dirname, 'public');
    const arquivos = fs.readdirSync(publicDir)
      .filter(f => f.startsWith('ciids-resultado-') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (arquivos.length === 0) {
      throw new Error('Nenhum arquivo de CIIDs encontrado. Execute scrape-ciid-manual.cjs primeiro.');
    }
    
    const arquivoCiids = path.join(publicDir, arquivos[0]);
    console.log(`[Teste] Carregando CIIDs de: ${arquivoCiids}`);
    
    const dadosCiids = JSON.parse(fs.readFileSync(arquivoCiids, 'utf-8'));
    const ciids = dadosCiids.ciids.slice(0, 10); // Apenas primeiros 10
    
    console.log(`[Teste] Processando ${ciids.length} CIIDs: ${ciids.join(', ')}`);
    
    // Carrega sessão salva
    const sessaoPath = path.join(
      process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
      'agendamentos-electron',
      'sessao.json'
    );
    
    if (!fs.existsSync(sessaoPath)) {
      throw new Error('Sessão não encontrada. Faça login no app Electron primeiro.');
    }
    
    const sessao = JSON.parse(fs.readFileSync(sessaoPath, 'utf-8'));
    jar.setCookieFromString(`PHPSESSID=${sessao.cookies[0].value}`);
    
    console.log(`[Teste] Sessão carregada: ${sessao.cookies[0].value.substring(0, 20)}...`);
    
    // Processa CIIDs
    const todosPrestadores = [];
    
    for (const ciid of ciids) {
      try {
        const prestadores = await buscarPrestadoresParaCiid(ciid);
        todosPrestadores.push(prestadores);
        await new Promise(resolve => setTimeout(resolve, 500)); // Pausa maior para teste
      } catch (err) {
        console.warn(`[Teste] Erro no CIID ${ciid}: ${err.message}`);
        todosPrestadores.push([]);
      }
    }
    
    // Monta estrutura
    const exames = [];
    for (let i = 0; i < ciids.length; i++) {
      const ciid = ciids[i];
      const prestadores = todosPrestadores[i];
      
      if (prestadores.length > 0) {
        const exame = {
          nome_parametro: prestadores[0].nome,
          nome_real: prestadores[0].nome,
          clinicas: prestadores.map(p => ({
            clinica_id: p.forid,
            id_exame_clinica: parseInt(p.id),
            preco: parseInt(p.valor)
          }))
        };
        exames.push(exame);
      }
    }
    
    const bancoTeste = {
      clinicas: [],
      exames: exames
    };
    
    // Salva resultado
    const timestamp = Date.now();
    const arquivoTeste = `./public/banco-teste-${timestamp}.json`;
    fs.writeFileSync(arquivoTeste, JSON.stringify(bancoTeste, null, 2));
    
    console.log('\n' + '═'.repeat(60));
    console.log('  RESULTADO DO TESTE');
    console.log('═'.repeat(60));
    
    console.log(`📊 CIIDs testados: ${ciids.length}`);
    console.log(`🏗️  Exames criados: ${exames.length}`);
    console.log(`💾 Arquivo salvo: ${arquivoTeste}`);
    
    if (exames.length > 0) {
      console.log(`\n🔍 Amostra de exames:`);
      exames.slice(0, 3).forEach((exame, idx) => {
        console.log(`  ${idx + 1}. "${exame.nome_parametro}" - ${exame.clinicas.length} clínicas`);
      });
    }
    
    console.log('\n✅ TESTE CONCLUÍDO COM SUCESSO!');
    console.log('\n💡 Para processamento completo, use: node scrape-ciid-manual.cjs');
    
  } catch (erro) {
    console.error('\n✗ Erro:', erro.message);
    process.exit(1);
  }
}

main();
