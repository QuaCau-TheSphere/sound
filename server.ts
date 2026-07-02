// server.ts
// Server Deno nhận webhook thông báo (notification) từ Tasker
// - Dashboard xem log CÔNG KHAI tại "/" (ai có link cũng xem được)
// - Dùng Temporal API (Deno 2.7+, stable, không cần --unstable-temporal) thay cho Date
// - Log console bằng LogTape, hiển thị giờ GMT+7 (Asia/Ho_Chi_Minh)
// - Lưu lịch sử vào Deno KV
// - Forward thông báo sang Telegram (plain text, tránh lỗi escape MarkdownV2)
//
// Yêu cầu: Deno 2.7 trở lên (deno --version để kiểm tra; deno upgrade nếu cần)
//
// Chạy local:
//   deno run --allow-net --unstable-kv --env-file server.ts
//
// Test thử (PowerShell):
//   Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/notify" -Method Post `
//     -Headers @{ "Authorization" = "Bearer secret123" } -ContentType "application/json" `
//     -Body '{"app":"com.zing.zalo","title":"Tin nhan moi","text":"Xin chao","time":"12:00"}'
//
// LƯU Ý BẢO MẬT: Dashboard ("/") và "/api/history" ở bản này KHÔNG có mật khẩu,
// ai có đường link cũng xem được toàn bộ log thông báo. Chỉ endpoint "/api/notify"
// (nơi ghi dữ liệu) vẫn yêu cầu Authorization token.

import {
  configure,
  getConsoleSink,
  getLogger,
  type LogRecord,
} from "jsr:@logtape/logtape";

// ====== CẤU HÌNH ======
const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN") ?? "secret123";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? 8080);
const TIMEZONE = "Asia/Ho_Chi_Minh"; // GMT+7

// ====== TEMPORAL: giờ hiện tại theo GMT+7 ======
// Trả về Temporal.ZonedDateTime tại thời điểm hiện tại, đúng múi giờ VN
function nowInVietnam(): Temporal.ZonedDateTime {
  return Temporal.Now.zonedDateTimeISO(TIMEZONE);
}

// Format 1 Instant (mốc thời gian tuyệt đối) sang chuỗi hiển thị GMT+7 dễ đọc
function formatGmt7(instant: Temporal.Instant): string {
  const zdt = instant.toZonedDateTimeISO(TIMEZONE);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${zdt.year}-${pad(zdt.month)}-${pad(zdt.day)} ` +
    `${pad(zdt.hour)}:${pad(zdt.minute)}:${pad(zdt.second)} (GMT+7)`;
}

function textFormatter(record: LogRecord): string {
  // LogTape cấp timestamp dạng epoch millisecond -> chuyển sang Temporal.Instant
  const instant = Temporal.Instant.fromEpochMilliseconds(record.timestamp);
  const time = formatGmt7(instant);
  const level = record.level.toUpperCase().padEnd(5);
  const category = record.category.join(".");
  const message = record.message.join("");
  return `[${time}] ${level} ${category} - ${message}`;
}

await configure({
  sinks: { console: getConsoleSink({ formatter: textFormatter }) },
  loggers: [
    { category: ["app"], lowestLevel: "info", sinks: ["console"] },
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
  ],
});

const logger = getLogger(["app"]);

// ====== DENO KV ======
const kv = await Deno.openKv();

interface NotificationPayload {
  app?: string;
  title?: string;
  text?: string;
  time?: string;
  [key: string]: unknown;
}

interface StoredEntry {
  receivedAtGmt7: string;
  receivedAtIso: string; // Temporal.Instant.toString() - chuẩn ISO 8601 UTC
  app?: string;
  title?: string;
  text?: string;
  telegramStatus: "sent" | "failed" | "skipped";
  telegramError?: string;
}

// ====== FORWARD SANG TELEGRAM (plain text, tránh lỗi escape MarkdownV2) ======
async function sendToTelegram(
  payload: NotificationPayload,
  receivedAtGmt7: string,
): Promise<{ status: "sent" | "failed" | "skipped"; error?: string }> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { status: "skipped", error: "Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID" };
  }

  const message =
    `📱 ${payload.app ?? "Không rõ app"}\n` +
    `${payload.title ?? ""}\n` +
    `${payload.text ?? ""}\n` +
    `🕒 ${receivedAtGmt7}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error("Gửi Telegram thất bại: {status} {body}", { status: res.status, body: errText });
      return { status: "failed", error: `${res.status}: ${errText}` };
    }
    return { status: "sent" };
  } catch (err) {
    logger.error("Lỗi khi gọi Telegram API: {error}", { error: String(err) });
    return { status: "failed", error: String(err) };
  }
}

// ====== HANDLERS ======
async function handleNotify(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  
  const authHeader = req.headers.get("Authorization") ?? "";
  if (AUTH_TOKEN && authHeader !== `Bearer ${AUTH_TOKEN}`) {
    logger.warn("Từ chối request thiếu/sai token");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  let payload: NotificationPayload;
  try {
    payload = await req.json();
    // const reqtext = await req.text()
    // console.log("test")
    // console.log(reqtext)
    // console.log("logger")
    logger.info(payload)
  } catch {
    logger.error("ko đọc được payload");
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  const nowInstant = Temporal.Now.instant();
  const receivedAtGmt7 = formatGmt7(nowInstant);
  console.log("logger2")
  logger.info("app={app} title={title} text={text}", {
    app: payload.app ?? "?",
    title: payload.title ?? "",
    text: payload.text ?? "",
  });

  const tgResult = await sendToTelegram(payload, receivedAtGmt7);

  const entry: StoredEntry = {
    receivedAtGmt7,
    receivedAtIso: nowInstant.toString(),
    app: payload.app,
    title: payload.title,
    text: payload.text,
    telegramStatus: tgResult.status,
    telegramError: tgResult.error,
  };

  // Key theo thời gian để Deno KV giữ đúng thứ tự khi list ngược (mới nhất trước)
  const key = ["notifications", nowInstant.toString(), crypto.randomUUID()];
  await kv.set(key, entry);

  return new Response(JSON.stringify({ status: "ok", receivedAt: receivedAtGmt7, telegram: tgResult.status }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function getRecentEntries(limit = 100): Promise<StoredEntry[]> {
  const items: StoredEntry[] = [];
  const entries = kv.list<StoredEntry>({ prefix: ["notifications"] }, { reverse: true, limit });
  for await (const entry of entries) {
    items.push(entry.value);
  }
  return items;
}

async function handleHistory(_req: Request): Promise<Response> {
  const items = await getRecentEntries(100);
  return new Response(JSON.stringify(items, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

// Dashboard công khai — không yêu cầu key/đăng nhập
function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tasker Webhook Log</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #0f1115; color: #e6e6e6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9aa0a6; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #2a2d34; vertical-align: top; }
  th { color: #9aa0a6; font-weight: 600; position: sticky; top: 0; background: #0f1115; }
  tr:hover { background: #171a20; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .sent { background: #103a20; color: #4ade80; }
  .failed { background: #3a1010; color: #f87171; }
  .skipped { background: #2a2a10; color: #facc15; }
  .app { color: #8ab4f8; font-family: monospace; font-size: 12px; }
  .empty { color: #9aa0a6; padding: 40px; text-align: center; }
  .time { white-space: nowrap; color: #9aa0a6; }
  #status { font-size: 12px; color: #6b7280; margin-bottom: 12px; }
</style>
</head>
<body>
  <h1>📋 Tasker Webhook Log</h1>
  <div class="sub">Tự động cập nhật mỗi 5 giây — GMT+7 — trang này công khai</div>
  <div id="status">Đang tải...</div>
  <table>
    <thead>
      <tr>
        <th>Thời gian</th>
        <th>App</th>
        <th>Tiêu đề</th>
        <th>Nội dung</th>
        <th>Telegram</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

<script>
  function escapeHtml(s) {
    if (s === undefined || s === null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function badge(status) {
    const map = { sent: "Đã gửi", failed: "Thất bại", skipped: "Bỏ qua" };
    return '<span class="badge ' + status + '">' + (map[status] || status) + '</span>';
  }

  async function refresh() {
    try {
      const res = await fetch("/api/history");
      if (!res.ok) {
        document.getElementById("status").textContent = "Lỗi tải log: HTTP " + res.status;
        return;
      }
      const items = await res.json();
      const rows = document.getElementById("rows");
      if (!items.length) {
        rows.innerHTML = '<tr><td colspan="5" class="empty">Chưa có thông báo nào được nhận</td></tr>';
      } else {
        rows.innerHTML = items.map((it) => \`
          <tr>
            <td class="time">\${escapeHtml(it.receivedAtGmt7)}</td>
            <td class="app">\${escapeHtml(it.app)}</td>
            <td>\${escapeHtml(it.title)}</td>
            <td>\${escapeHtml(it.text)}</td>
            <td>\${badge(it.telegramStatus)}\${it.telegramError ? '<div style="color:#f87171;font-size:11px;margin-top:4px">' + escapeHtml(it.telegramError) + '</div>' : ""}</td>
          </tr>
        \`).join("");
      }
      document.getElementById("status").textContent =
        "Cập nhật lúc " + new Date().toLocaleTimeString("vi-VN") + " — " + items.length + " thông báo gần nhất";
    } catch (e) {
      document.getElementById("status").textContent = "Lỗi kết nối: " + e;
    }
  }

  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/notify") {
    return await handleNotify(req);
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    return await handleHistory(req);
  }

  if (url.pathname === "/" && req.method === "GET") {
    return new Response(renderDashboard(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/health") {
    return new Response("Tasker webhook server đang chạy ✅", { status: 200 });
  }

  return new Response("Not Found", { status: 404 });
});

// logger.info("Telegram forward: {status}", {
//   status: TELEGRAM_BOT_TOKEN ? "BẬT ✅" : "TẮT (chưa cấu hình token)",
// });
