#!/usr/bin/env node
/**
 * 头像直传 - 本地开发服务器（零依赖，仅用 Node 内置模块）
 *
 *   node serve.mjs [--port 8787] [--target https://cdsq.dao3.fun]
 *
 * 做两件事：
 *   1. 把当前目录当成静态站点伺服（index.html / styles.css / app.js / assets）。
 *   2. 把 /api/** 反向代理到目标站点。
 *
 * 为什么要这一步：站点的接口只给自己的域名发 CORS 许可，跨域直接 403；
 * 而同源部署时浏览器会正常携带会话 Cookie。用本服务器打开页面即等价于同源。
 * 本文件只是开发/自用便利，生产部署请看 README 里的「同源部署」。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------- 参数 ---------------------------------- */

function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    target: process.env.TARGET || 'https://cdsq.dao3.fun',
    host: process.env.HOST || '127.0.0.1',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--target' || a === '-t') out.target = String(argv[++i] || out.target);
    else if (a === '--host') out.host = String(argv[++i] || out.host);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  out.target = out.target.replace(/\/+$/, '');
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('用法: node serve.mjs [--port 8787] [--target https://cdsq.dao3.fun] [--host 127.0.0.1]');
  console.log('亦可用环境变量: PORT / TARGET / HOST');
  process.exit(0);
}

const targetUrl = new URL(args.target);

/* ------------------------------ 静态文件 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(__dirname, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(__dirname)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));

  res.writeHead(200, {
    'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  fs.createReadStream(abs).pipe(res);
}

/* -------------------------------- 代理 --------------------------------- */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 把 Set-Cookie 里的 Domain 去掉，否则 localhost 存不下这个 Cookie */
function rewriteSetCookie(list) {
  if (!list) return undefined;
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((c) => c.replace(/;\s*Domain=[^;]*/gi, ''));
}

async function proxy(req, res) {
  const incoming = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const upstream = new URL(incoming.pathname + incoming.search, targetUrl);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    // 让上游以为请求来自它自己的 Origin，避免 Origin 白名单拒绝
    if (k.toLowerCase() === 'origin') continue;
    if (k.toLowerCase() === 'referer') continue;
    headers[k] = v;
  }
  headers.origin = targetUrl.origin;
  headers.referer = `${targetUrl.origin}/`;

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await collectBody(req);

  let upRes;
  try {
    upRes = await fetch(upstream, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 'PROXY_UPSTREAM_ERROR', message: String(err && err.message) }));
    return;
  }

  const out = {};
  for (const [k, v] of upRes.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'content-encoding' || lk === 'set-cookie') continue;
    if (lk.startsWith('access-control-')) continue; // 同源了，CORS 头无意义
    out[k] = v;
  }
  const cookies = rewriteSetCookie(upRes.headers.getSetCookie
    ? upRes.headers.getSetCookie()
    : upRes.headers.get('set-cookie'));
  if (cookies && cookies.length) out['set-cookie'] = cookies;

  const buf = Buffer.from(await upRes.arrayBuffer());
  out['content-length'] = buf.length;
  res.writeHead(upRes.status, out);
  res.end(buf);

  const flag = upRes.status >= 400 ? '!' : ' ';
  console.log(`${flag} ${req.method} ${incoming.pathname} -> ${upRes.status} ${buf.length}B`);
}

/* ------------------------------- 服务器 -------------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (pathname === '/api' || pathname.startsWith('/api/')) return await proxy(req, res);
    return await serveStatic(req, res, pathname);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err && err.message}`);
  }
});

server.listen(args.port, args.host, () => {
  console.log('');
  console.log('  头像直传 - 本地开发服务器');
  console.log(`  页面     http://${args.host}:${args.port}/`);
  console.log(`  API 反代  /api/**  ->  ${args.target}`);
  console.log('  说明      页面与 /api 同源，浏览器会正常携带会话 Cookie。Ctrl+C 退出。');
  console.log('');
});
