// Probe chẩn đoán: gọi ĐÚNG 3 request mà chatgpt-join-client.ts gọi, theo 2 kiểu header
// (1) "bare"  = y hệt code hiện tại (fetch trần, không User-Agent)
// (2) "browser" = giả Chrome đầy đủ (UA + sec-ch-ua + origin/referer + oai-* device id cố định)
// So status của 2 kiểu để biết: có phải bị Cloudflare/UA chặn không, và thêm header có đủ cứu không.
//
// KHÔNG in access token ra ngoài. Chỉ in status + marker Cloudflare + ~300 ký tự body.
//
// Cách chạy (CHẠY TRÊN ĐÚNG MÁY server đang chạy — VPS/WSL — để tái hiện đúng IP):
//   PROBE_AT="eyJ...(access_token thật, còn hạn)" PROBE_WS="workspace-uuid" node test/probe-join.mjs
// Hoặc:
//   node test/probe-join.mjs <workspace-uuid> <access-token>

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const readIf = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8').trim() : ''; } catch { return ''; } };

// Cho phép dán CẢ session JSON (nhiều key) — tự bóc access_token ra, giống app thật.
function extractToken(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const j = JSON.parse(s);
      const o = Array.isArray(j) ? j[0] : j;
      return String(o.access_token || o.accessToken || o.at || '').trim();
    } catch { return ''; }
  }
  return s; // đã là token eyJ...
}

const BASE = (process.env.PROBE_BASE || 'https://chatgpt.com').replace(/\/$/, '');
const WS = process.env.PROBE_WS || process.argv[2] || readIf(join(HERE, 'probe-ws.txt'));
const AT = extractToken(process.env.PROBE_AT || process.argv[3] || readIf(join(HERE, 'probe-at.txt')));

if (!WS || !AT) {
  console.error('Thiếu tham số.');
  console.error('Cách 1 (khuyên dùng): tạo 2 file cạnh script rồi chạy `node test/probe-join.mjs`:');
  console.error('  test/probe-at.txt  -> dán access_token (eyJ...) HOẶC cả session JSON');
  console.error('  test/probe-ws.txt  -> dán workspace UUID');
  console.error('Cách 2: PROBE_AT="eyJ..." PROBE_WS="fa2aff95-..." node test/probe-join.mjs');
  console.error('Cách 3: node test/probe-join.mjs <workspace-uuid> <access-token>');
  process.exit(1);
}

const DEVICE_ID = randomUUID(); // 1 device id CỐ ĐỊNH cho cả lượt (giống extension)

const bareHeaders = {
  accept: '*/*',
  authorization: `Bearer ${AT}`,
  'content-type': 'application/json',
  'oai-device-id': DEVICE_ID,
  'oai-language': 'en-US',
};

const browserHeaders = {
  ...bareHeaders,
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://chatgpt.com',
  referer: 'https://chatgpt.com/',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

async function call(label, method, path, headers) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : '', // extension gửi body rỗng ""
    });
    const text = await res.text().catch(() => '');
    const cfRay = res.headers.get('cf-ray');
    const cfMit = res.headers.get('cf-mitigated');
    const server = res.headers.get('server');
    const blocked = res.status === 403 || /just a moment|cloudflare|attention required|cf-chl/i.test(text);
    console.log(
      `  [${label}] ${method} ${path}\n` +
        `      -> HTTP ${res.status}${blocked ? '  <== NGHI BỊ CHẶN' : ''}` +
        `  | server=${server || '-'} cf-ray=${cfRay || '-'} cf-mitigated=${cfMit || '-'}\n` +
        `      body: ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
    );
    return res.status;
  } catch (err) {
    console.log(`  [${label}] ${method} ${path}\n      -> LỖI: ${err && err.message ? err.message : err}`);
    return -1;
  }
}

async function run(label, headers) {
  console.log(`\n===== KIỂU: ${label} =====`);
  await call(label, 'GET', '/backend-api/accounts/check/v4-2023-04-27', headers);
  await call(label, 'POST', `/backend-api/accounts/${WS}/invites/request`, headers);
  await call(label, 'POST', `/backend-api/accounts/${WS}/invites/accept`, headers);
}

(async () => {
  console.log(`Base=${BASE}  Workspace=${WS.slice(0, 8)}...  device-id=${DEVICE_ID.slice(0, 8)}...`);
  await run('bare (như code hiện tại)', bareHeaders);
  await run('browser (giả Chrome)', browserHeaders);
  console.log(
    '\nĐỌC KẾT QUẢ:\n' +
      '  - bare 403 + browser 2xx/409  => bị chặn vì thiếu header browser; thêm header CÓ THỂ đủ (nhẹ nhất).\n' +
      '  - CẢ HAI 403 (cf-ray có giá trị) => Cloudflare chặn ở tầng TLS/JA3/IP => phải chạy trong browser thật (Playwright).\n' +
      '  - 404/500 => WORKSPACE ID sai (khác ID extension dùng) => sửa cấu hình, không phải lỗi transport.\n' +
      '  - 401 => token hết hạn hoặc email domain không được workspace cho phép.\n' +
      '  - 409 => coi như OK (đã request / đã là thành viên).',
  );
})();
