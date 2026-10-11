// S6 failure QA: FOREIGN process simulation. Runs as a fully independent node process
// (not spawned by the browser launcher). Given only the debug port, it must:
//  1) GET http://127.0.0.1:<port>/json/version  -> prove foreign HTTP access succeeds
//  2) GET http://127.0.0.1:<port>/json/list     -> prove foreign can enumerate user targets
//  3) hold a raw TCP connection ESTABLISHED for --hold ms -> for detector demo (b4)
//
// Usage: node b2-foreign.mjs <port> [--hold ms]
// Prints its own PID as FOREIGN_PID so the orchestrator can cross-check the TCP table.
import http from 'node:http';
import net from 'node:net';

const port = Number(process.argv[2]);
const holdMs = Number(process.argv[4] ?? process.argv[3] ?? 8000) || 8000;
if (!port) { console.error('usage: node b2-foreign.mjs <port> [--hold ms]'); process.exit(2); }

function httpGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ error: e.code ?? String(e) }));
    req.end();
  });
}

console.log(`[B2-FOREIGN] pid=${process.pid} target=127.0.0.1:${port}`);
const ver = await httpGet('/json/version');
console.log(`[B2-FOREIGN] GET /json/version -> ${ver.error ? 'ERROR ' + ver.error : 'HTTP ' + ver.status}`);
if (ver.status === 200) {
  const j = JSON.parse(ver.body);
  console.log(`[B2-FOREIGN] foreign sees Browser=${j.Browser} webSocketDebuggerUrl=${j.webSocketDebuggerUrl}`);
}
const list = await httpGet('/json/list');
console.log(`[B2-FOREIGN] GET /json/list -> ${list.error ? 'ERROR ' + list.error : 'HTTP ' + list.status} targets=${list.status === 200 ? JSON.parse(list.body).length : 'n/a'}`);
if (list.status === 200) {
  for (const t of JSON.parse(list.body).slice(0, 5)) {
    console.log(`[B2-FOREIGN] target-visible: type=${t.type} title=${JSON.stringify((t.title ?? '').slice(0, 60))} url=${(t.url ?? '').slice(0, 80)}`);
  }
}

// hold a raw TCP connection so the detector can observe ESTABLISHED from a foreign pid
const sock = net.connect({ host: '127.0.0.1', port });
sock.on('connect', () => console.log(`[B2-FOREIGN] TCP ESTABLISHED held (pid=${process.pid}) for ${holdMs}ms`));
sock.on('error', (e) => console.log(`[B2-FOREIGN] TCP hold error: ${e.code ?? e}`));
await new Promise(r => setTimeout(r, holdMs));
sock.destroy();
console.log(`[B2-FOREIGN] done pid=${process.pid}`);
process.exit(0);
