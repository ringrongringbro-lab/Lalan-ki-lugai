import { sendMessage, editMessage, answerCallback, getChat, withCancelButton, messageLink } from "./telegram.js";
import { getSession, setSession, clearSession, getConfig, setConfig, deleteConfig, queueSize, queuedCountForUser, pushQueue, popNextQueued, removeFromQueue } from "./db.js";
import { isServerBusy, dispatchWorkflow, cancelAllRuns } from "./github.js";

const OWNER_ID = 5344078567;
const ALLOWED_USER = 5351848105;
const GROUP_ID = -1003899919015;

const RES_MAP = { "1080g": "1080p", "720g": "720p", "480g": "480p" };
const AUDIO_EXTS = [".mp3", ".m4a", ".opus", ".aac", ".wav", ".flac", ".ogg", ".wma"];

function isAuthorized(msg) {
  const uid = msg.from?.id;
  if (!uid) return false;
  if ([OWNER_ID, ALLOWED_USER].includes(uid)) return true;
  if (msg.chat?.id === GROUP_ID) return true;
  return false;
}

async function checkCommandPrivacy(env, msg) {
  const isPm = msg.chat.type === "private";
  if (isPm && [OWNER_ID, ALLOWED_USER].includes(msg.from.id)) return true;
  if (isPm) {
    let inviteLink = "https://t.me/Mangajii";
    const chat = await getChat(env, GROUP_ID);
    if (chat?.invite_link) inviteLink = chat.invite_link;
    await sendMessage(env, msg.chat.id, `❌ Aap is Bot ko Private mein use nahi kar sakte!\n\n👉 Humara [Official Group](${inviteLink}) join karein.`, { disable_web_page_preview: true });
    return false;
  }
  return isAuthorized(msg);
}

// ---------- Queue / dispatch ----------

async function enqueueOrDispatch(env, chatId, userId, workflow, payload) {
  const busy = await isServerBusy(env);
  if (!busy) {
    const res = await dispatchWorkflow(env, workflow, payload);
    if (!res.ok) console.log("Dispatch error:", res.error);
    return { queued: false };
  }
  const queuedForUser = await queuedCountForUser(env, userId);
  const maxPerUser = parseInt(env.MAX_QUEUED_PER_USER || "3", 10);
  if (queuedForUser >= maxPerUser) {
    return { queued: false, rejected: true };
  }
  await pushQueue(env, { chatId, userId, workflow, payload });
  return { queued: true };
}

async function statusTextFor(result) {
  if (result.rejected) return "❌ Aapke already bahut saare tasks queue me hain, pehle unke complete hone ka wait karein.";
  return result.queued
    ? "⏳ *Task Queued!*\nServer busy hain, aapka task queue me lag gaya hai aur turn aane par automatic start hoga."
    : "⏳ *Task Dispatched to Cloud Processing Node...*";
}

// Called every minute by the cron trigger — drains the D1 queue while a GitHub Actions slot is free
export async function drainQueue(env) {
  const busy = await isServerBusy(env);
  if (busy) return;
  const next = await popNextQueued(env);
  if (!next) return;
  const res = await dispatchWorkflow(env, next.workflow, next.payload);
  if (!res.ok) console.log("Queue dispatch error:", res.error);
  await removeFromQueue(env, next.id);
}

// ---------- Command handlers ----------

async function handleGeneralCmd(env, msg, cmd) {
  if (cmd === "start" && msg.chat.type === "private") {
    if ([OWNER_ID, ALLOWED_USER].includes(msg.from.id)) {
      return sendMessage(env, msg.chat.id, "🙋‍♂️ Welcome Master!");
    }
    return checkCommandPrivacy(env, msg);
  }
  if (!(await checkCommandPrivacy(env, msg))) return;

  if (cmd === "help") {
    return sendMessage(env, msg.chat.id,
      "🤖 *Bot Usage Guide:*\n\n" +
      "1️⃣ *Compress Video:* Video par reply karein `/1080g`, `/720g`, ya `/480g`\n" +
      "2️⃣ *Hardsub Video:* Video par reply karein `/sub` aur subtitle send karein.\n" +
      "3️⃣ *Add/Replace Audio:* Video par reply karein `/audio` aur audio file bhejein.\n" +
      "4️⃣ *Set Watermark Position:* `/addposition left` ya `/addposition right`\n" +
      "5️⃣ *Cancel Setup State:* `/cancel` type karein."
    );
  }

  if (cmd === "cancel") {
    await clearSession(env, msg.from.id, msg.chat.id);
    return sendMessage(env, msg.chat.id, "✅ Active setup cancel kar diya gaya.");
  }

  if (cmd === "stats") {
    const size = await queueSize(env);
    return sendMessage(env, msg.chat.id, `📊 *System Status:*\n📂 Queue Size: \`${size}\``);
  }

  if (cmd === "addposition") {
    const parts = msg.text.trim().split(/\s+/);
    const pos = (parts[1] || "").toLowerCase();
    if (!["left", "right"].includes(pos)) {
      return sendMessage(env, msg.chat.id, "❌ Usage: `/addposition left` ya `/addposition right`");
    }
    await setConfig(env, msg.chat.id, "wm_position", pos);
    return sendMessage(env, msg.chat.id, `✅ Watermark position set to: *${pos.toUpperCase()}*`);
  }

  if (cmd === "admark" || cmd === "addfont") {
    const reply = msg.reply_to_message;
    if (!reply || !(reply.photo || reply.document)) {
      return sendMessage(env, msg.chat.id, "❌ File par reply karein.");
    }
    const link = messageLink(msg.chat.id, reply.message_id);
    const name = cmd === "admark" ? "watermark" : "file";
    await setConfig(env, msg.chat.id, name, link);
    return sendMessage(env, msg.chat.id, "✅ Configuration saved successfully.");
  }

  if (cmd === "deletmark" || cmd === "removefont") {
    const name = cmd === "deletmark" ? "watermark" : "file";
    const removed = await deleteConfig(env, msg.chat.id, name);
    return sendMessage(env, msg.chat.id, removed ? "🗑️ Config removed." : "❌ Config nahi mila.");
  }
}

async function handleCompressCmd(env, msg, cmdName) {
  if (!(await checkCommandPrivacy(env, msg))) return;
  const reply = msg.reply_to_message;
  const media = reply && (reply.video || reply.document || reply.animation);
  if (!media) return sendMessage(env, msg.chat.id, "❌ Kisi valid video par reply karein.");

  const resolution = RES_MAP[cmdName];
  const origName = media.file_name || "output.mp4";

  const busy = await isServerBusy(env);
  const st = await sendMessage(env, msg.chat.id, await statusTextFor({ queued: busy }));

  const fontLink = await getConfig(env, msg.chat.id, "file");
  const payload = {
    task_type: "compress",
    video_id: messageLink(msg.chat.id, reply.message_id),
    sub_id: "none", chat_id: String(msg.chat.id), user_id: String(msg.from.id),
    resolution, wm_id: "none", wm_pos: "none", rename: origName,
    font_link: fontLink, trigger_msg_id: String(st.result.message_id),
  };
  const result = await enqueueOrDispatch(env, msg.chat.id, msg.from.id, "encode.yml", payload);
  if (result.queued || result.rejected) {
    await editMessage(env, msg.chat.id, st.result.message_id, await statusTextFor(result));
  }
}

async function handleSubCmd(env, msg) {
  if (!(await checkCommandPrivacy(env, msg))) return;
  const reply = msg.reply_to_message;
  const media = reply && (reply.video || reply.document || reply.animation);
  if (!media) return sendMessage(env, msg.chat.id, "❌ Hardsub ke liye video par reply karein.");

  const origName = media.file_name || "output.mp4";
  await sendMessage(env, msg.chat.id, "Send subtitle file (.srt, .ass, .vtt) ya skip karne ke liye `S` type karein.");
  await setSession(env, msg.from.id, msg.chat.id, "WAIT_SUB", {
    flow: "hardsub", video_msg_id: reply.message_id, orig_name: origName, rename: "none",
  });
}

async function handleAudioCmd(env, msg) {
  if (!(await checkCommandPrivacy(env, msg))) return;
  const reply = msg.reply_to_message;
  const media = reply && (reply.video || reply.document || reply.animation);
  if (!media) return sendMessage(env, msg.chat.id, "❌ Audio add/replace karne ke liye kisi valid video par reply karein.");

  const origName = media.file_name || "output.mp4";
  await sendMessage(env, msg.chat.id, "🎵 Ab audio file bhejein (MP3, M4A, OPUS, AAC, WAV, FLAC, OGG — jo bhi ho, sab chalega).");
  await setSession(env, msg.from.id, msg.chat.id, "WAIT_AUDIO", {
    flow: "audio", video_msg_id: reply.message_id, orig_name: origName, rename: "none",
  });
}

// ---------- Multi-step conversation controller ----------

async function promptWatermarkOrExecute(env, msg, userId, session) {
  const wmLink = await getConfig(env, msg.chat.id, "watermark");
  if (wmLink !== "none") {
    session.state = "WAIT_WM_CHOICE";
    await setSession(env, userId, msg.chat.id, session.state, session.data);
    return sendMessage(env, msg.chat.id, "Add watermark? Type `A` for Add ya `S` for Skip.");
  }
  session.data.watermark = "no";
  return executeDispatchHardsub(env, msg, userId, session.data);
}

async function executeDispatchHardsub(env, msg, userId, data) {
  await clearSession(env, userId, msg.chat.id);
  const busy = await isServerBusy(env);
  const st = await sendMessage(env, msg.chat.id, await statusTextFor({ queued: busy }));

  let wmLink = "none", wmPos = "right";
  if (data.watermark === "yes") {
    wmLink = await getConfig(env, msg.chat.id, "watermark");
    wmPos = await getConfig(env, msg.chat.id, "wm_position");
    if (wmPos === "none") wmPos = "right";
  }
  const fontLink = await getConfig(env, msg.chat.id, "file");

  const payload = {
    task_type: "hardsub",
    video_id: messageLink(msg.chat.id, data.video_msg_id),
    sub_id: data.sub_msg_link || "none", chat_id: String(msg.chat.id), user_id: String(userId),
    resolution: "none", wm_id: wmLink, wm_pos: wmPos, rename: data.rename || "none",
    font_link: fontLink, trigger_msg_id: String(st.result.message_id),
  };
  const result = await enqueueOrDispatch(env, msg.chat.id, userId, "encode.yml", payload);
  if (result.queued || result.rejected) {
    await editMessage(env, msg.chat.id, st.result.message_id, await statusTextFor(result));
  }
}

async function executeDispatchAudio(env, msg, userId, data) {
  await clearSession(env, userId, msg.chat.id);
  const busy = await isServerBusy(env);
  const st = await sendMessage(env, msg.chat.id, await statusTextFor({ queued: busy }));

  const payload = {
    video_id: messageLink(msg.chat.id, data.video_msg_id),
    audio_id: data.audio_msg_link || "none",
    chat_id: String(msg.chat.id), user_id: String(userId),
    rename: data.rename || "none", trigger_msg_id: String(st.result.message_id),
  };
  const result = await enqueueOrDispatch(env, msg.chat.id, userId, "audio_merge.yml", payload);
  if (result.queued || result.rejected) {
    await editMessage(env, msg.chat.id, st.result.message_id, await statusTextFor(result));
  }
}

async function handleRepliesController(env, msg) {
  if (!msg.from || (msg.text && msg.text.startsWith("/"))) return;
  const userId = msg.from.id;
  const session = await getSession(env, userId, msg.chat.id);
  if (!session) return;
  if (session.data._chat_id_check && session.data._chat_id_check !== msg.chat.id) return;

  const state = session.state;
  const text = msg.text ? msg.text.trim().toUpperCase() : "";

  if (state === "WAIT_SUB") {
    const fname = msg.document?.file_name?.toLowerCase() || "";
    const isSubFile = msg.document && [".srt", ".ass", ".vtt", ".txt"].some((ext) => fname.endsWith(ext));
    if (isSubFile) {
      session.data.sub_msg_link = messageLink(msg.chat.id, msg.message_id);
      session.state = "WAIT_RENAME_CHOICE";
      await setSession(env, userId, msg.chat.id, session.state, session.data);
      return sendMessage(env, msg.chat.id, "Rename ke liye `R` / Same name ke liye `S` type karein.");
    } else if (text === "S") {
      session.data.sub_msg_link = "none";
      session.state = "WAIT_RENAME_CHOICE";
      await setSession(env, userId, msg.chat.id, session.state, session.data);
      return sendMessage(env, msg.chat.id, "Rename ke liye `R` / Same name ke liye `S` type karein.");
    }
    return sendMessage(env, msg.chat.id, "❌ Invalid format! Please send a valid subtitle file ya type `S`.");
  }

  if (state === "WAIT_AUDIO") {
    let audioMedia = msg.audio || msg.voice;
    const fname = msg.document?.file_name?.toLowerCase() || "";
    if (!audioMedia && msg.document && AUDIO_EXTS.some((ext) => fname.endsWith(ext))) audioMedia = msg.document;
    if (audioMedia) {
      session.data.audio_msg_link = messageLink(msg.chat.id, msg.message_id);
      session.state = "WAIT_RENAME_CHOICE";
      await setSession(env, userId, msg.chat.id, session.state, session.data);
      return sendMessage(env, msg.chat.id, "Rename ke liye `R` / Same name ke liye `S` type karein.");
    }
    return sendMessage(env, msg.chat.id, "❌ Invalid format! Please send a valid audio file (mp3/m4a/opus/aac/wav/flac/ogg) ya voice note.");
  }

  if (state === "WAIT_RENAME_CHOICE") {
    if (text === "R") {
      session.state = "WAIT_RENAME_VALUE";
      await setSession(env, userId, msg.chat.id, session.state, session.data);
      return sendMessage(env, msg.chat.id, "Send new file name:");
    } else if (text === "S") {
      session.data.rename = session.data.orig_name;
      return continueAfterRename(env, msg, userId, session);
    }
    return sendMessage(env, msg.chat.id, "❌ Type `R` to rename ya `S` to skip.");
  }

  if (state === "WAIT_RENAME_VALUE") {
    if (!msg.text || !msg.text.trim()) return sendMessage(env, msg.chat.id, "❌ Invalid name.");
    let rawName = msg.text.trim();
    if (rawName.toLowerCase().endsWith(".mp4")) rawName = rawName.slice(0, -4);
    const cleanName = rawName.replace(/[\\/:*?"<>|]/g, "").trim();
    session.data.rename = cleanName + ".mp4";
    return continueAfterRename(env, msg, userId, session);
  }

  if (state === "WAIT_WM_CHOICE") {
    if (text === "A") session.data.watermark = "yes";
    else if (text === "S") session.data.watermark = "no";
    else return sendMessage(env, msg.chat.id, "❌ Type `A` to add watermark ya `S` to skip.");
    return executeDispatchHardsub(env, msg, userId, session.data);
  }
}

async function continueAfterRename(env, msg, userId, session) {
  if (session.data.flow === "audio") {
    return executeDispatchAudio(env, msg, userId, session.data);
  }
  return promptWatermarkOrExecute(env, msg, userId, session);
}

// ---------- Callback query (Cancel Task button) ----------

async function handleCallbackQuery(env, cq) {
  if (![OWNER_ID, ALLOWED_USER].includes(cq.from.id)) {
    return answerCallback(env, cq.id, "❌ You are not authorized to cancel this task.", true);
  }
  if (cq.data !== "cancel_active_run") return;

  const cancelled = await cancelAllRuns(env);
  if (cancelled) {
    await editMessage(env, cq.message.chat.id, cq.message.message_id, "🛑 *Process Cancelled Successfully!*");
    await answerCallback(env, cq.id, "Task Aborted", true);
  } else {
    await answerCallback(env, cq.id, "Koi running task nahi mila.", true);
  }
}

// ---------- Update router ----------

async function handleUpdate(env, update) {
  if (update.callback_query) {
    return handleCallbackQuery(env, update.callback_query);
  }
  const msg = update.message;
  if (!msg) return;

  if (msg.text && msg.text.startsWith("/")) {
    const cmd = msg.text.split(/[\s@]/)[0].slice(1).toLowerCase();
    if (["start", "help", "cancel", "stats", "addposition", "admark", "deletmark", "addfont", "removefont"].includes(cmd)) {
      return handleGeneralCmd(env, msg, cmd);
    }
    if (["1080g", "720g", "480g"].includes(cmd)) return handleCompressCmd(env, msg, cmd);
    if (cmd === "sub") return handleSubCmd(env, msg);
    if (cmd === "audio") return handleAudioCmd(env, msg);
    return;
  }

  return handleRepliesController(env, msg);
}

// ---------- Worker entrypoints ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot is running ✅");

    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    ctx.waitUntil(handleUpdate(env, update).catch((e) => console.log("Update handling error:", e)));
    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainQueue(env));
  },
};
