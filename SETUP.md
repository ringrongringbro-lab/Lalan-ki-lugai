# Setup & Deploy — Step by Step

## Kya kya kaam kahan hoga
- **Cloudflare Worker** → Telegram commands sunta hai, state D1 me rakhta hai, GitHub Actions ko trigger karta hai
- **GitHub Actions** (`encode.yml`, `audio_merge.yml`) → asli ffmpeg kaam (hardsub, compress, audio merge) yahin hota hai, jaisa pehle tha
- **D1 database** → conversation state, watermark/font config, task queue

## Limits (adjust kar sakte ho `wrangler.toml` me)
- Ek time me max **2 tasks** GitHub Actions par parallel chalenge (`MAX_CONCURRENT`)
- Ek user max **3 tasks** ek saath queue me daal sakta hai (`MAX_QUEUED_PER_USER`) — usse zyada bheja to bot mana kar dega
- Queue har **1 minute** me check hoti hai aur agla task auto-dispatch hota hai jab slot free ho

---

## 1. Repo GitHub par push karo
Is poore folder ko apne naye repo me daal do (jaisa already plan tha):
```
.github/workflows/encode.yml
.github/workflows/audio_merge.yml
studio.py
studio_audio.py
requirements.txt
src/index.js
src/db.js
src/github.js
src/telegram.js
wrangler.toml
package.json
schema.sql
```

## 2. GitHub Secrets add karo (Settings → Secrets and variables → Actions)
Same jo pehle the:
- `API_ID`, `API_HASH`, `BOT_TOKEN`, `STRING_SESSION`

## 3. GitHub Personal Access Token banao (Worker ke liye alag se)
- GitHub → Settings → Developer settings → Personal access tokens → Generate (classic)
- Scope: `repo` + `workflow`
- Ye token Cloudflare Worker secret me jayega (`GITHUB_TOKEN`), GitHub repo secret me NAHI

## 4. Cloudflare account + Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

## 5. D1 database banao
```bash
wrangler d1 create bot-db
```
Output me jo `database_id` milega, usse `wrangler.toml` me `REPLACE_WITH_YOUR_D1_DATABASE_ID` ki jagah daal do.

Phir schema apply karo:
```bash
wrangler d1 execute bot-db --remote --file=./schema.sql
```

## 6. Secrets set karo (Worker ke liye — inko wrangler.toml me kabhi mat likhna)
```bash
wrangler secret put BOT_TOKEN
wrangler secret put GITHUB_TOKEN
wrangler secret put REPO_NAME
wrangler secret put WEBHOOK_SECRET
```
- `REPO_NAME` = `yourusername/your-repo`
- `WEBHOOK_SECRET` = koi bhi random string khud bana lo (jaise `openssl rand -hex 20`)

## 7. Deploy
```bash
wrangler deploy
```
Deploy hone ke baad ek URL milega, jaisे:
`https://video-control-bot.<yoursubdomain>.workers.dev`

## 8. Telegram webhook set karo
Browser me ye URL open karo (apna BOT_TOKEN, Worker URL, aur WEBHOOK_SECRET daal ke):
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>
```
Response me `"ok":true` aana chahiye — bas, bot live hai.

## 9. Test karo
- Group me `/start`, `/help` bhejo
- Video pe reply karke `/1080g`, `/sub`, `/audio` try karo
- `/stats` se queue size check karo

---

## Agar kuch change karna ho
- Limits: `wrangler.toml` me `MAX_CONCURRENT` / `MAX_QUEUED_PER_USER` badal do, phir `wrangler deploy` dubara chalao
- Cron interval: `wrangler.toml` me `crons = ["* * * * *"]` — chaaho to `*/2 * * * *` (har 2 min) kar sakte ho
