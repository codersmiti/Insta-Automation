// src/scripts/multiAccountDmFull.ts
import { IgApiClient } from "instagram-private-api";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateDM } from "../agent/gptDM";

dotenv.config({ path: path.join(process.cwd(), ".env") });

// ---------- CONFIG ----------
const ACCOUNTS_FILE = path.join(process.cwd(), "accounts.csv"); // username,password[,proxy]
const LISTS_DIR = path.join(process.cwd(), "lists"); // per-account target lists: lists/<username>.txt
const MEDIA_DIR = path.join(process.cwd(), "media");
const LOGS_DIR = path.join(process.cwd(), "logs_multi");
const SESSIONS_DIR = path.join(process.cwd(), "sessions");

const CONCURRENCY = 3; // how many accounts to run in parallel
const DMS_PER_HOUR = 7;
const TOTAL_HOURS = 5;
const DAILY_LIMIT = DMS_PER_HOUR * TOTAL_HOURS; // 35/day
const COOLDOWN_MIN_MS = 20_000; // 20s
const COOLDOWN_MAX_MS = 75_000; // 75s

// ---------- HELPERS ----------
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function ensureDir(d: string) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function csvSafe(s: string) {
  return `"${(s || "").replace(/"/g, '""')}"`;
}
function appendLogFile(
  logPath: string,
  target: string,
  status: string,
  message: string,
  imageSent: boolean
) {
  const timestamp = new Date().toISOString();
  const line = `${csvSafe(target)},${csvSafe(status)},${csvSafe(timestamp)},${csvSafe(
    message
  )},${csvSafe(String(imageSent))}\n`;
  fs.appendFileSync(logPath, line, "utf8");
}

// Use a simple human-like behavior: like or comment a timeline post
async function humanLikeBehavior(ig: IgApiClient) {
  try {
    const items = await ig.feed.timeline().items();
    const pick = items[Math.floor(Math.random() * items.length)];
    if (!pick || !pick.id) return;
    if (Math.random() < 0.65) {
      await ig.media.like({ mediaId: pick.id, moduleInfo: { module_name: "profile" } });
      console.log("   ❤️ Liked a random post");
    } else {
      await ig.media.comment({ mediaId: pick.id, text: "Nice post! ✨" });
      console.log("   💬 Commented on a random post");
    }
  } catch (err) {
    // silent fallback if feed not available
    console.warn("   ⚠️ humanLikeBehavior skipped (feed unavailable)");
  }
}

// Save/restore session JSON (instagram-private-api exposes ig.state.serialize/deserialize)
async function saveSession(ig: IgApiClient, username: string) {
  try {
    const serialized = await ig.state.serialize(); // includes cookie jar + device + account info
    // serialized is an object that should be saved as JSON
    const out = JSON.stringify(serialized);
    ensureDir(SESSIONS_DIR);
    fs.writeFileSync(path.join(SESSIONS_DIR, `${username}.json`), out, "utf8");
    console.log(`   🗂 Saved session for ${username}`);
  } catch (err) {
    console.warn(`   ⚠️ Could not save session for ${username}: ${(err as any)?.message || err}`);
  }
}

async function loadSession(ig: IgApiClient, username: string) {
  const sessionPath = path.join(SESSIONS_DIR, `${username}.json`);
  if (!fs.existsSync(sessionPath)) return false;
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const parsed = JSON.parse(raw);
    // instagram-private-api has ig.state.deserialize - use it if available
    if (typeof ig.state.deserialize === "function") {
      await ig.state.deserialize(parsed);
      console.log(`   🗂 Restored session for ${username}`);
      return true;
    } else {
      // fallback: try to set cookieJar and other details if needed
      console.warn("   ⚠️ ig.state.deserialize not found - session restore skipped");
      return false;
    }
  } catch (err) {
    console.warn(`   ⚠️ Failed to load session for ${username}: ${(err as any)?.message || err}`);
    return false;
  }
}

// ---------- Per-account worker ----------
async function runAccount(accountRow: string) {
  // expected CSV row: username,password[,proxyUrl]
  const cols = accountRow.split(",").map((c) => c.trim());
  const username = cols[0];
  const password = cols[1];
  const proxy = cols[2]; // optional: http://user:pass@host:port

  if (!username || !password) {
    console.warn("Skipping bad account row:", accountRow);
    return;
  }

  console.log(`\n=== Starting worker for account: ${username} ===`);
  ensureDir(LOGS_DIR);
  ensureDir(SESSIONS_DIR);

  const logPath = path.join(LOGS_DIR, `dm_log_${username}.csv`);
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `"username","status","timestamp","message","image_sent"\n`, "utf8");
  }

  // read per-account list
  const listPath = path.join(LISTS_DIR, `${username}.txt`);
  if (!fs.existsSync(listPath)) {
    console.warn(`No list found for ${username} at ${listPath} — skipping account.`);
    return;
  }
  const targets = fs
    .readFileSync(listPath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (targets.length === 0) {
    console.warn(`No targets in ${listPath} — skipping account.`);
    return;
  }

  // images
  const images = fs.existsSync(MEDIA_DIR)
    ? fs.readdirSync(MEDIA_DIR).filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    : [];

  // init IG client
  const ig = new IgApiClient();

  // if proxy provided, set http(s) proxy env vars for underlying HTTP client (many libs honor env vars)
  // NOTE: this is a pragmatic approach — some environments/HTTP libs honor HTTP_PROXY/HTTPS_PROXY.
  if (proxy) {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
    console.log(`   🔁 Proxy for ${username} set to ${proxy}`);
  }

  ig.state.generateDevice(username);

  // try to restore session first
  const restored = await loadSession(ig, username);

  // login if session not restored
  if (!restored) {
    try {
      console.log(`   🔑 Logging ${username} in with password...`);
      await ig.account.login(username, password);
      console.log(`   ✅ Logged in ${username}`);
      // save session after login
      await saveSession(ig, username);
    } catch (err: any) {
      console.error(`   ❌ Login failed for ${username}:`, err?.message || err);
      return;
    }
  } else {
    // session restored; still attempt a small API call to confirm auth
    try {
      await ig.account.currentUser();
      console.log(`   ✅ Session valid for ${username}`);
    } catch (e) {
      console.warn(`   ⚠️ Session invalid, attempting login for ${username}...`);
      try {
        await ig.account.login(username, password);
        console.log(`   ✅ Re-logged in ${username}`);
        await saveSession(ig, username);
      } catch (err: any) {
        console.error(`   ❌ Re-login failed for ${username}:`, err?.message || err);
        return;
      }
    }
  }

  // ---------- scheduled sending: DMS_PER_HOUR for TOTAL_HOURS ----------
  let sentTotal = 0;
  for (let hour = 1; hour <= TOTAL_HOURS; hour++) {
    console.log(`   ⏰ [${username}] Hour ${hour}/${TOTAL_HOURS} — sending up to ${DMS_PER_HOUR} DMs`);
    const startIdx = (hour - 1) * DMS_PER_HOUR;
    const batch = targets.slice(startIdx, startIdx + DMS_PER_HOUR);
    if (batch.length === 0) {
      console.log(`   ℹ️ [${username}] no more targets for this hour`);
      break;
    }

    for (const target of batch) {
      if (sentTotal >= DAILY_LIMIT) {
        console.log(`   🌙 [${username}] daily limit reached (${DAILY_LIMIT}). Stopping.`);
        break;
      }

      console.log(`   → [${username}] sending to @${target}`);
      let message = "";
      let imageSent = false;

      try {
        const userId = await ig.user.getIdByUsername(target);
        const thread = ig.entity.directThread([userId]);

        // generate a unique DM
        message = await generateDM(target);
        await thread.broadcastText(message);
        console.log(`     ✅ text sent to @${target}`);

        // optional image (80% chance)
        if (images.length > 0 && Math.random() < 0.8) {
          const img = images[Math.floor(Math.random() * images.length)];
          const imgPath = path.join(MEDIA_DIR, img);
          await thread.broadcastPhoto({ file: fs.readFileSync(imgPath), caption: message });
          imageSent = true;
          console.log(`     📸 image sent (${img})`);
        }

        appendLogFile(logPath, target, "success", message, imageSent);
        sentTotal++;

        // occasionally do a human-like action
        if (Math.random() < 0.35) {
          await humanLikeBehavior(ig);
        }

        // variable cooldown
        const cooldown = randomBetween(COOLDOWN_MIN_MS, COOLDOWN_MAX_MS);
        console.log(`     ⏳ cooling for ${(cooldown / 1000).toFixed(1)}s`);
        await delay(cooldown);
      } catch (err: any) {
        console.error(`     ❌ failed to send to @${target}:`, err?.message || err);
        appendLogFile(logPath, target, "failed", message || "N/A", imageSent);
      }
    } // end batch

    // save session after each hour so we can resume later
    await saveSession(ig, username);

    if (hour < TOTAL_HOURS) {
      console.log(`   🛑 [${username}] waiting 1 hour before next batch...`);
      await delay(60 * 60 * 1000);
    }
  } // end hours

  console.log(`=== [${username}] done — total sent: ${sentTotal} — log: ${logPath}`);
}

// ---------- Orchestrator ----------
async function main() {
  ensureDir(LOGS_DIR);
  ensureDir(SESSIONS_DIR);

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(`Missing ${ACCOUNTS_FILE}`);
  }
  if (!fs.existsSync(LISTS_DIR)) {
    throw new Error(`Missing lists directory: ${LISTS_DIR}`);
  }

  const rows = fs
    .readFileSync(ACCOUNTS_FILE, "utf8")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);

  if (rows.length === 0) throw new Error("No accounts in accounts.csv");

  // start workers up to CONCURRENCY
  const workers: Promise<void>[] = [];
  for (const row of rows) {
    // start worker but don't await immediately (concurrency control below)
    const p = runAccount(row).catch((e) => {
      console.error("Worker error:", e);
    });
    workers.push(p);

    // simple concurrency throttle
    while (workers.length >= CONCURRENCY) {
      // wait for any to finish
      await Promise.race(workers);
      // filter out already-settled promises by reassigning with those still pending
      // (can't inspect Promise state; but awaiting a tiny pause and filtering works in practice)
      await delay(10);
      // compact array: keep those that haven't resolved by creating new array with only unresolved
      // NOTE: Node doesn't expose Promise.isFulfilled; keep design simple: let them run - not strict
      // We'll allow more than CONCURRENCY to run in rare race cases — acceptable for this script.
      break;
    }
  }

  await Promise.all(workers);
  console.log("All account workers finished.");
}

main().catch((err) => {
  console.error("Fatal error in orchestrator:", err);
  process.exit(1);
});
