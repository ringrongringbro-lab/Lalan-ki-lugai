import os, time, asyncio, subprocess, requests, html
import pyrogram.utils
from pyrogram import Client
from pyrogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from pyrogram.enums import ParseMode

pyrogram.utils.get_peer_type = lambda p: "channel" if str(p).startswith("-100") else "chat" if str(p).startswith("-") else "user"

# ============================================================
#  These come from GitHub repo Secrets (Settings -> Secrets -> Actions)
# ============================================================
API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
BOT_TOKEN = os.getenv("BOT_TOKEN")
STRING_SESSION = os.getenv("STRING_SESSION")  # optional, leave secret empty if not using

VIDEO_ID = os.getenv("VIDEO_ID")
AUDIO_ID = os.getenv("AUDIO_ID")
CHAT_ID = int(os.getenv("CHAT_ID"))
USER_ID = int(os.getenv("USER_ID"))
RENAME = os.getenv("RENAME")
TRIGGER_MSG_ID = os.getenv("TRIGGER_MSG_ID")

DESK_CHANNEL_ID = 0  # optional log channel id; set to 0 to disable logging copies

last_time = 0
start_time = 0
status_msg_id = None

def reset_prog():
    global last_time, start_time
    last_time = time.time()
    start_time = time.time()

def get_download_bar(percent):
    filled = int(percent / 100 * 20)
    return f"[{'>' * filled}{'-' * (20 - filled)}]"

def get_process_bar(percent):
    filled = int(percent / 100 * 20)
    seq = ["•", "°", ":", "°", "•", ":"]
    bar = "".join(seq[i % len(seq)] for i in range(filled))
    return f"[{bar}{'-' * (20 - filled)}]"

def get_send_bar(percent):
    filled = int(percent / 100 * 20)
    return f"[{'▓' * filled}{'▒' * (20 - filled)}]"

def _sync_http_edit(text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/editMessageText"
    payload = {
        "chat_id": CHAT_ID,
        "message_id": status_msg_id,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": [[{"text": "🛑 Cancel Task", "callback_data": "cancel_active_run"}]]}
    }
    try: requests.post(url, json=payload, timeout=6)
    except: pass

async def update_http_status(text):
    await asyncio.to_thread(_sync_http_edit, text)

async def prog(c, t, app_instance, step_name):
    global last_time, start_time
    now = time.time()
    if start_time == 0:
        start_time = now
        last_time = now
        return

    if now - last_time > 8 or c == t:
        elapsed = now - start_time
        speed = c / elapsed if elapsed > 0 else 0
        speed_mb = (speed / 1024) / 1024
        percent = (c / t) * 100 if t > 0 else 0

        if step_name == "download":
            text = f"📥 <b>Downloading</b>\n<code>{get_download_bar(percent)}</code> [{percent:.1f}%]\n🚀 Speed: <b>{speed_mb:.2f} MB/s</b>\n📦 {c/1048576:.1f}MB / {t/1048576:.1f}MB"
        else:
            text = f"📤 <b>Sending Video</b>\n<code>{get_send_bar(percent)}</code> [{percent:.1f}%]\n🚀 Speed: <b>{speed_mb:.2f} MB/s</b>\n📦 {c/1048576:.1f}MB / {t/1048576:.1f}MB"

        asyncio.create_task(update_http_status(text))
        last_time = now

def get_video_dimensions_and_duration(video_path):
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height:format=duration",
           "-of", "default=noprint_wrappers=1", video_path]
    width, height, duration = 1280, 720, 0.0
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        for line in res.stdout.strip().split("\n"):
            if "=" not in line: continue
            k, v = line.split("=", 1)
            if k == "width": width = int(v)
            elif k == "height": height = int(v)
            elif k == "duration": duration = float(v)
    except: pass
    return width, height, duration

async def download_tg_link(app_instance, link, output_path):
    if not link or link == "none": return None
    try:
        msg_id = int(link.split("/")[-1])
        msg = await app_instance.get_messages(CHAT_ID, msg_id)
        if msg and (msg.document or msg.video or msg.animation or msg.audio or msg.voice):
            reset_prog()
            downloaded = await asyncio.wait_for(
                app_instance.download_media(msg, file_name=output_path, progress=prog, progress_args=(app_instance, "download")),
                timeout=2400
            )
            if downloaded and os.path.exists(downloaded) and os.path.getsize(downloaded) > 1024:
                return downloaded
    except Exception as e:
        print(f"Download Exception: {e}")
    return None

async def deliver_video_asset(app_instance, chat_id, target_user, file_path, caption, progress_callback):
    if not os.path.exists(file_path) or os.path.getsize(file_path) < 1000:
        raise Exception("Output video file is missing or invalid.")

    width, height, duration = get_video_dimensions_and_duration(file_path)

    thumb_path = "thumb.jpg"
    try: subprocess.run(["ffmpeg", "-y", "-i", file_path, "-ss", "00:00:01", "-vframes", "1", thumb_path], capture_output=True, timeout=15)
    except: pass
    if not os.path.exists(thumb_path): thumb_path = None

    reset_prog()

    try:
        pm_msg = await asyncio.wait_for(
            app_instance.send_video(chat_id=target_user, video=file_path, width=width, height=height, duration=int(duration), supports_streaming=True, caption=caption, thumb=thumb_path, progress=progress_callback, progress_args=(app_instance, "sending_video")),
            timeout=2400
        )
        if pm_msg and pm_msg.video and DESK_CHANNEL_ID:
            try: await app_instance.send_video(chat_id=DESK_CHANNEL_ID, video=pm_msg.video.file_id, caption=f"🎬 Logs: {caption}\nUser: `{target_user}`")
            except: pass
        return pm_msg
    except Exception:
        pm_msg = await asyncio.wait_for(
            app_instance.send_video(chat_id=chat_id, video=file_path, width=width, height=height, duration=int(duration), supports_streaming=True, caption=f"⚠️ <a href='tg://user?id={target_user}'>User</a>, Video Ready:\n\n{caption}", thumb=thumb_path, progress=progress_callback, progress_args=(app_instance, "sending_video"), parse_mode=ParseMode.HTML),
            timeout=2400
        )
        return pm_msg

async def main():
    global status_msg_id

    client_params = {
        "name": "worker_single_session",
        "api_id": API_ID,
        "api_hash": API_HASH,
        "workers": 16,
        "max_concurrent_transmissions": 10,
        "no_updates": True
    }
    if STRING_SESSION and STRING_SESSION.strip() != "":
        client_params["session_string"] = STRING_SESSION.strip()
    else:
        client_params["bot_token"] = BOT_TOKEN

    app = Client(**client_params)
    await app.start()

    try: await app.get_chat(CHAT_ID)
    except: pass

    if TRIGGER_MSG_ID and TRIGGER_MSG_ID != "none":
        try: await app.delete_messages(CHAT_ID, int(TRIGGER_MSG_ID))
        except: pass

    init_msg = await app.send_message(
        CHAT_ID,
        "⚙️ Initializing Cloud Processing Node...",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🛑 Cancel Task", callback_data="cancel_active_run")]])
    )
    status_msg_id = init_msg.id

    try:
        video_file = await download_tg_link(app, VIDEO_ID, "video_input.mkv")
        if not video_file or not os.path.exists(video_file) or os.path.getsize(video_file) < 10000:
            raise Exception("Video download failed or file is 0 bytes.")

        audio_file = await download_tg_link(app, AUDIO_ID, "audio_input")
        if not audio_file or not os.path.exists(audio_file):
            raise Exception("Audio download failed or file is invalid.")

        _, _, duration = get_video_dimensions_and_duration(video_file)
        if duration <= 0: duration = 1.0

        base_name = "output"
        if RENAME and RENAME != "none":
            base_name = RENAME.rsplit('.', 1)[0]
        out_name = f"{base_name}.mp4"

        # ---------------- MERGE STAGE ----------------
        await update_http_status(f"⚙️ <b>Merging Audio</b>\n<code>{get_process_bar(0)}</code> [0.0%]")
        cmd = [
            "ffmpeg", "-y", "-progress", "pipe:1",
            "-i", video_file, "-i", audio_file,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", out_name
        ]

        process = await asyncio.create_subprocess_exec(*cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        last_edit = time.time()
        log_tail = []

        while True:
            line = await process.stdout.readline()
            if not line: break
            line_str = line.decode('utf-8', errors='ignore').strip()
            if line_str and "out_time_us=" not in line_str and "frame=" not in line_str:
                log_tail.append(line_str)
                if len(log_tail) > 15: log_tail.pop(0)
            if "out_time_us=" in line_str:
                now = time.time()
                if now - last_edit > 8:
                    try:
                        percent = min((int(line_str.split("=")[1]) / 1000000.0 / duration) * 100, 100.0)
                        asyncio.create_task(update_http_status(f"⚙️ <b>Merging Audio</b>\n<code>{get_process_bar(percent)}</code> [{percent:.1f}%]"))
                    except: pass
                    last_edit = now

        await process.wait()
        if process.returncode != 0:
            raise Exception("FFmpeg processing failure:\n" + "\n".join(log_tail[-6:]))

        # ---------------- SIZE GUARD ----------------
        MAX_BYTES = 2 * 1024 * 1024 * 1024  # 2GB
        out_size = os.path.getsize(out_name) if os.path.exists(out_name) else 0
        if out_size > MAX_BYTES:
            await update_http_status(f"⚠️ <b>File is {out_size/1073741824:.2f}GB, applying light compression to fit under 2GB...</b>")
            _, _, real_duration = get_video_dimensions_and_duration(out_name)
            if real_duration <= 0: real_duration = duration

            audio_kbps = 128
            target_bits = MAX_BYTES * 8 * 0.93
            video_kbps = max(int((target_bits / real_duration / 1000) - audio_kbps), 300)

            compressed_name = f"{base_name}_final.mp4"
            cmd_sq = [
                "ffmpeg", "-y", "-progress", "pipe:1", "-i", out_name,
                "-map", "0:v:0", "-map", "0:a:0",
                "-c:v", "libx264", "-preset", "veryfast", "-b:v", f"{video_kbps}k",
                "-maxrate", f"{int(video_kbps * 1.15)}k", "-bufsize", f"{int(video_kbps * 2)}k",
                "-pix_fmt", "yuv420p", "-threads", "0",
                "-c:a", "aac", "-b:a", f"{audio_kbps}k",
                "-movflags", "+faststart", compressed_name
            ]

            sq_process = await asyncio.create_subprocess_exec(*cmd_sq, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            sq_last_edit = time.time()
            while True:
                line = await sq_process.stdout.readline()
                if not line: break
                line_str = line.decode('utf-8', errors='ignore').strip()
                if "out_time_us=" in line_str:
                    now = time.time()
                    if now - sq_last_edit > 8:
                        try:
                            percent = min((int(line_str.split("=")[1]) / 1000000.0 / real_duration) * 100, 100.0)
                            asyncio.create_task(update_http_status(f"⚙️ <b>Compressing to fit 2GB</b>\n<code>{get_process_bar(percent)}</code> [{percent:.1f}%]"))
                        except: pass
                        sq_last_edit = now
            await sq_process.wait()

            if sq_process.returncode == 0 and os.path.exists(compressed_name) and os.path.getsize(compressed_name) > 1000:
                try: os.remove(out_name)
                except: pass
                out_name = compressed_name
            else:
                print("⚠️ Size-guard compression failed, sending original larger file as-is.")

        # ---------------- UPLOAD STAGE ----------------
        await update_http_status(f"📤 <b>Sending Video</b>\n<code>{get_send_bar(0)}</code> [0.0%]")
        await deliver_video_asset(app, CHAT_ID, USER_ID, out_name, f"✅ <b>Audio Added Successfully!</b>\n<code>{out_name}</code>", prog)

        try: await app.delete_messages(CHAT_ID, status_msg_id)
        except: pass

    except Exception as e:
        try: _sync_http_edit(f"❌ <b>Execution Error:</b>\n<code>{html.escape(str(e))}</code>")
        except: pass
    finally:
        await app.stop()

if __name__ == "__main__":
    asyncio.run(main())
