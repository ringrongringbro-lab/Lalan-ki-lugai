export async function tg(env, method, params) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}

export async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
}

export async function editMessage(env, chatId, messageId, text, extra = {}) {
  return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", ...extra });
}

export async function answerCallback(env, callbackQueryId, text, showAlert = false) {
  return tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

export async function getChat(env, chatId) {
  const res = await tg(env, "getChat", { chat_id: chatId });
  return res.ok ? res.result : null;
}

const CANCEL_BUTTON = { reply_markup: { inline_keyboard: [[{ text: "🛑 Cancel Task", callback_data: "cancel_active_run" }]] } };

export function withCancelButton(extra = {}) {
  return { ...extra, ...CANCEL_BUTTON };
}

// Builds a t.me/c/... deep link to a message, same format the old pyrogram bot used
export function messageLink(chatId, messageId) {
  return `https://t.me/c/${String(chatId).slice(4)}/${messageId}`;
}
