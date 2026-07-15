# Plan: Log tiến trình thật cho trang Redeem (stream NDJSON)

> Đã duyệt: stream NDJSON trên chính `POST /api/redeem` · log tiếng Anh · KHÔNG tách trường hợp "join qua invite" (giữ chung `already_member`) · người dùng tự code theo plan này.
> Trạng thái: đã triển khai và kiểm chứng cục bộ.

## Mục tiêu

Trang redeem hiển thị từng dòng log theo đúng mốc tiến trình thật của server (không fake timer), và câu kết quả cuối phản ánh đúng thực tế:

- Bỏ: `Request approved for {email}. Check ChatGPT to continue.`
- Thay: `Done! {email} is now a member. Open ChatGPT and switch to the workspace.`

## Giao thức stream

`POST /api/redeem` giữ nguyên request body `{cdk, session}`. Response đổi thành:

- `200` + `content-type: application/x-ndjson; charset=utf-8` + `cache-control: no-store`
- Mỗi dòng là 1 JSON event, kết thúc bằng `\n`:

```
{"type":"progress","step":"cdk_valid"}
{"type":"progress","step":"session_loaded","email":"a@b.com"}
{"type":"progress","step":"join_request"}
{"type":"progress","step":"queued"}
{"type":"progress","step":"approved"}
{"type":"result","ok":true,"status":"accepted","email":"a@b.com"}
```

- Dòng cuối luôn là `type:"result"`, payload **giữ nguyên contract** của `RedemptionResult` hiện tại (`ok/status/email` hoặc `ok/code/message`) để client cũ dễ chuyển đổi.
- Server chỉ gửi `step` code, KHÔNG gửi text hiển thị — text nằm ở client (cùng pattern với `ERROR_MESSAGES` hiện có trong `web-pages.ts`).
- Các response KHÔNG stream vẫn tồn tại và client phải fallback được:
  - `400` JSON khi body sai shape (check đầu handler, trước khi hijack).
  - `429` JSON từ rate-limit plugin (chạy trước handler).

## Bảng step → dòng log (client render)

| `step` | Mốc thật trong code | Dòng log (English) |
|---|---|---|
| *(local, client tự in khi submit)* | fetch bắt đầu | `Submitting request…` |
| `cdk_valid` | qua `requireWorkspaceSnapshot` + `requireNormalizedCdk` + `requirePossiblyUnused` | `CDK is valid.` |
| `session_loaded` | qua `parseSingleSession` + `decodeSessionClaims` | `Session loaded for {email}.` |
| `join_request` | ngay trước `joinClient.requestJoin(...)` | `Sending join request to the workspace…` |
| `queued` | sau `queue.enqueue(ticket.job)` (đã qua check `worker.isReadyForRedemptions`) | `Join request submitted. Waiting for the approval bot…` |
| `approved` | sau `assertAccepted(...)` pass | `Join request approved.` |
| result `accepted` | sau `finishSuccess` (CDK đã mark used) | `Done! {email} is now a member. Open ChatGPT and switch to the workspace.` |
| result `already_member` | `join.membership === 'member'` (gồm cả case vừa accept invite — đã duyệt KHÔNG tách) | `{email} is already a member of this workspace.` |
| result lỗi | bất kỳ bước nào throw | text theo `ERROR_MESSAGES[code]` hiện có |

Lưu ý thứ tự: `already_member` kết thúc ngay sau `join_request` (không có `queued`/`approved`).

## Thay đổi theo file

### 1. `src/redemption-service.ts`

- Thêm type: `export type RedemptionProgress = { step: 'cdk_valid' | 'session_loaded' | 'join_request' | 'queued' | 'approved'; email?: string };`
- `redeem(input)` nhận thêm tham số optional: `redeem(input, onProgress?: (e: RedemptionProgress) => void)`.
- Emit tại đúng 5 mốc trong bảng trên (dùng `onProgress?.(...)`, bọc try/catch hoặc đảm bảo callback không throw ngược vào flow — khuyến nghị server tự nuốt lỗi write).
- `session_loaded` gửi kèm `email` từ `claims.email`.
- KHÔNG đổi logic nghiệp vụ, KHÔNG đổi `chatgpt-join-client.ts`.

### 2. `src/server.ts` — handler `/api/redeem`

- Giữ check body shape đầu handler → `400` JSON như cũ (trước khi hijack).
- Sau khi body hợp lệ:
  1. `reply.hijack()` (Fastify v4 — để tự quản response raw).
  2. `reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })`.
  3. Hàm `writeLine(obj)`: `if (!reply.raw.writableEnded) reply.raw.write(JSON.stringify(obj) + '\n')` — bọc try/catch, nuốt lỗi (client có thể đã disconnect).
  4. `const result = await dependencies.redemptions.redeem({...}, (e) => writeLine({ type: 'progress', ...e }))`.
  5. `writeLine({ type: 'result', ...result })` rồi `reply.raw.end()`.
- **Quan trọng**: client disconnect giữa chừng KHÔNG được hủy redemption — vẫn await `redeem` chạy đến cùng để trạng thái CDK nhất quán; chỉ việc write bị bỏ qua.
- Bọc toàn bộ trong try/catch: nếu throw ngoài dự kiến → `writeLine({ type: 'result', ok: false, code: 'INTERNAL_ERROR', message: 'The request could not be completed.' })` rồi `end()`.
- (Tùy chọn hardening, không bắt buộc) heartbeat `{"type":"ping"}` mỗi 15s trong lúc chờ — chỉ cần nếu deploy sau reverse proxy có idle timeout ngắn; nhớ `clearInterval` khi xong.

### 3. `src/web-pages.ts` — `renderRedeemPage`

- Thêm map text cạnh `ERROR_MESSAGES`:

```js
const STEP_MESSAGES = {
  cdk_valid: 'CDK is valid.',
  session_loaded: 'Session loaded for {email}.',
  join_request: 'Sending join request to the workspace…',
  queued: 'Join request submitted. Waiting for the approval bot…',
  approved: 'Join request approved.',
};
```

- HTML: thêm khối log dưới form, ví dụ `<ul id="log" class="log" aria-live="polite"></ul>`; giữ `#result` cho dòng kết quả cuối (styling success/error như hiện tại). Thêm chút CSS cho `.log` (monospace nhẹ, mỗi line 1 `<li>`, dùng `textContent` — không innerHTML).
- Submit handler:
  1. Clear log + result, in dòng local `Submitting request…`, giữ busy state như cũ (đã clear textarea session trước khi gửi — giữ nguyên).
  2. `fetch('/api/redeem', ...)`.
  3. Nếu `content-type` chứa `ndjson` → đọc `response.body.getReader()` + `TextDecoder`, buffer, tách theo `\n`, `JSON.parse` từng dòng (bỏ qua dòng parse lỗi và `type:"ping"`):
     - `progress` → append `STEP_MESSAGES[step]` (thay `{email}` nếu có).
     - `result` → render dòng kết quả cuối: `ok && status==='accepted'` → text Done!; `ok && status==='already_member'` → text already-member; `!ok` → `ERROR_MESSAGES[code]` (fallback `The request could not be completed.`).
  4. Nếu KHÔNG phải ndjson (400/429/proxy lỗi) → fallback logic cũ: parse JSON, hiện error qua `messageFor`.
  5. `finally` tắt busy; thành công thì clear ô CDK như cũ.
- CSP không cần đổi (`connect-src 'self'` đã cover fetch streaming).

## Test cần cập nhật

- `test/redemption-service.test.ts`:
  - Path `accepted`: `onProgress` được gọi đúng thứ tự `cdk_valid → session_loaded → join_request → queued → approved`.
  - Path `already_member`: dừng ở `join_request`, không có `queued`/`approved`.
  - Path lỗi (vd CDK sai): không emit step sau điểm fail; vẫn trả `{ok:false,...}`.
  - Không truyền `onProgress` → chạy bình thường (backward compatible).
- `test/server.test.ts`:
  - `/api/redeem` body hợp lệ → 200, `content-type` ndjson, dòng cuối là `type:"result"` đúng contract cũ.
  - Body sai shape → vẫn `400` JSON như cũ.
  - Progress lines xuất hiện trước result line theo thứ tự.
- `test/web-pages.test.ts`: page chứa `STEP_MESSAGES` / khối `#log` (theo pattern assert hiện có của file test này).

## Tiêu chí nghiệm thu

1. Redeem thành công: thấy lần lượt các dòng log thật theo bảng, kết thúc bằng `Done! {email} is now a member. Open ChatGPT and switch to the workspace.` — không còn câu `Request approved for … Check ChatGPT to continue.`
2. Đã là member: log dừng sau `Sending join request…` với dòng `{email} is already a member of this workspace.`
3. CDK sai: dòng lỗi `The CDK is invalid or has already been used.` xuất hiện, không có step nào sau `Submitting request…` (server fail trước `cdk_valid`).
4. Client disconnect giữa chừng: server vẫn hoàn tất redemption, CDK được mark đúng trạng thái, không crash (kiểm tra log server không có unhandled error).
5. Rate limit 429 và body sai 400 vẫn hiện message lỗi đúng (đường fallback JSON).
6. `npm test` (hoặc lệnh test hiện dùng) pass toàn bộ.

## Ngoài phạm vi (đã chốt khi duyệt)

- Không tách "vừa join qua pending invite" khỏi `already_member` (không sửa `chatgpt-join-client.ts`).
- Không đổi ngôn ngữ `ERROR_MESSAGES` (giữ tiếng Anh).
- Không đụng luồng webhook / worker / Telegram.

## Kết quả triển khai

- `RedemptionService` phát đúng các mốc `cdk_valid`, `session_loaded`, `join_request`, `queued`, `approved`; callback lỗi không làm hỏng redemption.
- `POST /api/redeem` trả NDJSON với dòng `result` cuối, giữ fallback JSON cho body sai shape và rate limit.
- Trang redeem đọc stream theo dòng, hiển thị log thật, bỏ qua `ping`/JSON lỗi, và giữ fallback JSON.
- Kết quả accepted dùng câu `Done! ...`; already-member giữ chung trạng thái `already_member` như đã chốt.
- Kiểm chứng: `npm run check` — 39 pass, 1 skip, 0 fail; `git diff --check` pass.
