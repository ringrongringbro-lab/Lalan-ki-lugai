// ---------- Session state (replaces the old in-memory users_data dict) ----------

export async function getSession(env, userId, chatId) {
  const row = await env.DB.prepare(
    "SELECT state, data FROM sessions WHERE user_id = ? AND chat_id = ?"
  ).bind(userId, chatId).first();
  if (!row) return null;
  return { state: row.state, data: JSON.parse(row.data) };
}

export async function setSession(env, userId, chatId, state, data) {
  await env.DB.prepare(
    `INSERT INTO sessions (user_id, chat_id, state, data, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, chat_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`
  ).bind(userId, chatId, state, JSON.stringify(data), Date.now()).run();
}

export async function clearSession(env, userId, chatId) {
  await env.DB.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND chat_id = ?"
  ).bind(userId, chatId).run();
}

// ---------- Config storage (replaces the "pin a message and parse it" trick) ----------

export async function getConfig(env, chatId, name) {
  const row = await env.DB.prepare(
    "SELECT value FROM configs WHERE chat_id = ? AND name = ?"
  ).bind(chatId, name).first();
  return row ? row.value : "none";
}

export async function setConfig(env, chatId, name, value) {
  await env.DB.prepare(
    `INSERT INTO configs (chat_id, name, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(chatId, name, value, Date.now()).run();
}

export async function deleteConfig(env, chatId, name) {
  const res = await env.DB.prepare(
    "DELETE FROM configs WHERE chat_id = ? AND name = ?"
  ).bind(chatId, name).run();
  return res.meta.changes > 0;
}

// ---------- Task queue ----------

export async function queueSize(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM queue").first();
  return row.c;
}

export async function queuedCountForUser(env, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM queue WHERE user_id = ? AND status = 'queued'"
  ).bind(userId).first();
  return row.c;
}

export async function pushQueue(env, { chatId, userId, workflow, payload }) {
  await env.DB.prepare(
    `INSERT INTO queue (chat_id, user_id, workflow, payload, status, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).bind(chatId, userId, workflow, JSON.stringify(payload), Date.now()).run();
}

export async function popNextQueued(env) {
  const row = await env.DB.prepare(
    "SELECT id, chat_id, user_id, workflow, payload FROM queue WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
  ).first();
  if (!row) return null;
  return { id: row.id, chatId: row.chat_id, userId: row.user_id, workflow: row.workflow, payload: JSON.parse(row.payload) };
}

export async function removeFromQueue(env, id) {
  await env.DB.prepare("DELETE FROM queue WHERE id = ?").bind(id).run();
}
