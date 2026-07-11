import type { Locator, Page } from 'playwright';

/**
 * TẤT CẢ selector phụ thuộc giao diện ChatGPT nằm ở file này (theo plan mục 7).
 * Khi ChatGPT đổi UI, chỉ cần sửa ở đây.
 *
 * Ưu tiên: getByRole > getByText > data-testid > XPath tương đối.
 * KHÔNG dùng XPath tuyệt đối (/html/body/...).
 *
 * Đã hiệu chỉnh theo DOM thật của trang:
 *   https://chatgpt.com/admin/members?tab=requests   (tab "Pending requests")
 *
 * GHI CHÚ QUAN TRỌNG:
 * - Duyệt theo TỪNG email (không dùng "Accept all"): lọc bằng ô Search rồi bấm nút
 *   "Accept" của đúng dòng email đó. Xem searchBoxCandidates / requestRowCandidates /
 *   rowAcceptButton bên dưới.
 * - Nút "Accept all" vẫn còn trong DOM (dùng làm dấu hiệu đã ở đúng trang requests),
 *   nhưng KHÔNG bấm để tránh duyệt nhầm người chưa có webhook.
 */

// -------------------------------------------------------------------------
// Nút "Accept all"  (text nội bộ: "Accept all" hoặc "Accept all (1)")
// -------------------------------------------------------------------------
export function acceptAllCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /accept all/i }),
    page.getByText(/^\s*accept all(\s*\(\d+\))?\s*$/i),
  ];
}

// -------------------------------------------------------------------------
// Duyệt theo TỪNG email (không dùng Accept all).
// Ô "Search for requests" để lọc, rồi bấm nút "Accept" của đúng dòng email đó.
// -------------------------------------------------------------------------

/** Escape để nhét email vào RegExp an toàn. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ô tìm kiếm yêu cầu. */
export function searchBoxCandidates(page: Page): Locator[] {
  return [
    page.getByPlaceholder(/search for requests/i),
    page.getByRole('searchbox'),
    page.getByRole('textbox', { name: /search/i }),
  ];
}

/**
 * Dòng yêu cầu chờ ứng với một email cụ thể.
 * Thử nhiều chiến lược vì DOM có thể là table hoặc list.
 */
export function requestRowCandidates(page: Page, email: string): Locator[] {
  const re = new RegExp(escapeRegExp(email), 'i');
  return [
    page.getByRole('row', { name: re }),
    page.locator('tr', { hasText: email }),
    page.locator('li', { hasText: email }),
    page.locator('[class*="row" i]', { hasText: email }),
    // fallback: phần tử text chứa email -> lên tổ tiên gần nhất có chứa <button>.
    page.getByText(email, { exact: false }).locator('xpath=ancestor-or-self::*[.//button][1]'),
  ];
}

/**
 * Nút "Accept" của MỘT dòng (khớp CHÍNH XÁC "Accept", không dính "Accept all").
 */
export function rowAcceptButton(row: Locator): Locator {
  return row.getByRole('button', { name: /^\s*accept\s*$/i });
}

// -------------------------------------------------------------------------
// Nút xác nhận trong modal — hiện KHÔNG có, giữ lại phòng khi UI đổi.
// -------------------------------------------------------------------------
export function confirmCandidates(page: Page): Locator[] {
  const dialog = page.getByRole('dialog');
  return [
    dialog.getByRole('button', { name: /accept|approve|confirm|yes/i }),
    page.getByRole('button', { name: /^\s*(confirm|accept|approve)\s*$/i }),
  ];
}

// -------------------------------------------------------------------------
// Tổng số thành viên (plan mục 9).
// Header hiển thị: "ChatGPT for Teachers · 63 members".
// -------------------------------------------------------------------------
export function memberCountRegionCandidates(page: Page): Locator[] {
  return [
    page.getByTestId('members-count'),
    page.getByText(/·\s*\d[\d.,]*\s+members/i), // "· 63 members"
    page.getByText(/\d[\d.,]*\s+members\b/i), // "63 members"
  ];
}

/** Các mẫu để trích số tổng thành viên từ chuỗi text của vùng ở trên. */
export const MEMBER_COUNT_PATTERNS: RegExp[] = [
  /(\d[\d.,]*)\s+members\b/i, // "63 members"
  /members[^\d]{0,12}(\d[\d.,]*)/i, // "Members: 63"
];

// -------------------------------------------------------------------------
// Phát hiện phiên đăng nhập
// -------------------------------------------------------------------------

/** URL cho thấy đã bị đá về trang đăng nhập. */
export const LOGIN_URL_PATTERNS: RegExp[] = [
  /auth\.openai\.com/i,
  /auth0\.openai\.com/i,
  /\/auth\/login/i,
  /\/login\b/i,
  /\/api\/auth\/signin/i,
];

/** Nút/text cho thấy đang ở màn hình đăng nhập. */
export function loginIndicatorCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /log in|sign in/i }),
    page.getByRole('link', { name: /log in|sign in/i }),
    page.getByText(/welcome back/i),
  ];
}

/** Phần tử cho thấy đang ở đúng trang Members/requests và đã đăng nhập. */
export function loggedInIndicatorCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /accept all/i }), // luôn có trên tab requests
    page.getByText(/pending requests/i),
    page.getByRole('heading', { name: /^\s*members\s*$/i }),
    page.getByPlaceholder(/search for requests/i),
    page.getByRole('table'),
  ];
}
