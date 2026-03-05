/**
 * Sochau Share — GitHub Webhook Server
 * Listens on port 9000 (internal only)
 * Verifies GitHub HMAC-SHA256 signature then runs deploy.sh
 */

const http   = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT   = 9000;
const SECRET = process.env.WEBHOOK_SECRET;
const BRANCH = 'refs/heads/main';

if (!SECRET) {
  console.error('ERROR: WEBHOOK_SECRET env var is required');
  process.exit(1);
}

function verify(signature, body) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch { return false; }
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/deploy-hook') {
    res.writeHead(404).end('Not found');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // Verify GitHub signature
    const sig = req.headers['x-hub-signature-256'] || '';
    if (!verify(sig, body)) {
      console.warn('[webhook] invalid signature — rejected');
      res.writeHead(401).end('Unauthorized');
      return;
    }

    // Only deploy on pushes to main branch
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400).end('Bad JSON');
      return;
    }

    if (payload.ref !== BRANCH) {
      console.log(`[webhook] push to ${payload.ref} — ignored (not main)`);
      res.writeHead(200).end('Ignored');
      return;
    }

    console.log(`[webhook] push to main by ${payload.pusher?.name} — deploying…`);
    res.writeHead(200).end('Deploying');

    // Run deploy script
    exec('/opt/sochau-share/deploy.sh', (err, stdout, stderr) => {
      if (err) {
        console.error('[webhook] deploy failed:', stderr);
      } else {
        console.log('[webhook] deploy succeeded');
      }
    });
  });

}).listen(PORT, '127.0.0.1', () => {
  console.log(`Webhook server listening on 127.0.0.1:${PORT}`);
});
