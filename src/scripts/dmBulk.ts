import { IgApiClient } from "instagram-private-api";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateDM } from "../agent/gptDM";

dotenv.config({ path: path.join(process.cwd(), ".env") });

// ---------- CONFIG ----------
const TARGETS_FILE = path.join(process.cwd(), "targets.txt"); // 📄 usernames list
const MEDIA_DIR = path.join(process.cwd(), "media");
const LOG_FILE = path.join(process.cwd(), "dm_log.csv");
const SESSION_FILE = path.join(process.cwd(), "session.json");

const DMS_PER_HOUR = 5;
const DMS_PER_DAY = 30;
const COOLDOWN_RANGE: [number, number] = [25_000, 60_000]; // 25–60 seconds

// ---------- HELPERS ----------
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function appendToCSV(
  username: string,
  status: string,
  message: string,
  imageSent: boolean
) {
  const timestamp = new Date().toISOString();
  const line = `"${username}","${status}","${timestamp}","${message.replace(
    /"/g,
    '""'
  )}","${imageSent}"\n`;
  fs.appendFileSync(LOG_FILE, line, "utf8");
}

// 🗨️ Random comment messages
const COMMENT_TEMPLATES = [
  "Love this 💫",
  "Beautiful shot!",
  "This made my day 😍",
  "Awesome vibe 🔥",
  "✨✨✨",
  "So aesthetic 😍",
  "Great post 🙌",
  "Pure inspiration 🌱",
];

// 💬 Random human action (like or comment)
async function randomHumanAction(ig: IgApiClient) {
  try {
    const exploreFeed = await ig.feed.timeline().items();
    if (!exploreFeed || exploreFeed.length === 0) return;
    const randomPost = exploreFeed[Math.floor(Math.random() * exploreFeed.length)];
    if (!randomPost?.id) return;

    const doComment = Math.random() < 0.4; // 40% comment, 60% like
    if (doComment) {
      const text =
        COMMENT_TEMPLATES[Math.floor(Math.random() * COMMENT_TEMPLATES.length)];
      await ig.media.comment({ mediaId: randomPost.id, text });
      console.log(`💬 Commented: "${text}"`);
    } else {
      await ig.media.like({
        mediaId: randomPost.id,
        moduleInfo: { module_name: "profile" },
      });
      console.log("❤️ Liked a random post");
    }
  } catch (err: any) {
    console.warn("⚠️ Skipped human-like action:", err.message);
  }
}

// 🧍 Idle break with human-like behavior
async function idleBreak(ig: IgApiClient, minMs: number, maxMs: number) {
  const idleTime = randomBetween(minMs, maxMs);
  console.log(`😴 Idle break for ${(idleTime / 60000).toFixed(1)} min...`);

  const actionsCount = randomBetween(2, 5);
  for (let i = 0; i < actionsCount; i++) {
    await randomHumanAction(ig);
    await delay(randomBetween(10_000, 30_000)); // 10–30s between actions
  }

  await delay(idleTime);
}

// ---------- MAIN ----------
async function main() {
  console.log("🚀 Starting bulk Instagram DM workflow...");

  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;

  if (!username || !password) {
    throw new Error("❌ Missing IG_USERNAME or IG_PASSWORD in .env");
  }

  if (!fs.existsSync(TARGETS_FILE)) {
    throw new Error(`❌ Missing ${TARGETS_FILE}. Create it with one username per line.`);
  }

  // Initialize IG client
  const ig = new IgApiClient();
  ig.state.generateDevice(username);

  // ---------- LOGIN ----------
  console.log("🔄 Attempting to load session...");
  let sessionLoaded = false;

  if (fs.existsSync(SESSION_FILE)) {
    try {
      const sessionState = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      await ig.state.deserialize(sessionState);
      await ig.account.currentUser();
      console.log("✅ Session loaded and validated!");
      sessionLoaded = true;
    } catch (e: any) {
      console.warn(`⚠️ Could not load session (it may be expired): ${e.message}`);
      console.log("🗑️ Deleting invalid session file.");
      fs.unlinkSync(SESSION_FILE);
    }
  }

  if (!sessionLoaded) {
    console.log("🔑 No valid session found. Logging in...");
    await ig.account.login(username, password);
    console.log("✅ Login successful!");
    const state = await ig.state.serialize({all: true });
    delete (state as any).constants;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
    console.log("💾 Session saved to session.json!");
  }

  // ---------- LOAD TARGETS ----------
  const targets = fs
    .readFileSync(TARGETS_FILE, "utf-8")
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);

  console.log(`🎯 Loaded ${targets.length} target usernames.`);

  // ---------- LOAD IMAGES ----------
  const images =
    fs.existsSync(MEDIA_DIR) &&
    fs.readdirSync(MEDIA_DIR).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));

  // ---------- LOG HEADER ----------
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, `"username","status","timestamp","message","image_sent"\n`, "utf8");
  }

  // ---------- SHUFFLE TARGETS ----------
  function shuffle(array: string[]) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  shuffle(targets);
  console.log("🔀 Target order randomized for today.");

  // ---------- SEND LOOP ----------
  let sentToday = 0;
  let sentThisHour = 0;
  let hourStart = Date.now();
  let dmCountSinceIdle = 0;

  for (const target of targets) {
    if (sentToday >= DMS_PER_DAY) {
      console.log("🌙 Daily DM limit reached. Stopping for today.");
      break;
    }

    const elapsedHour = Date.now() - hourStart;
    if (elapsedHour < 60 * 60 * 1000 && sentThisHour >= DMS_PER_HOUR) {
      const waitTime = 60 * 60 * 1000 - elapsedHour;
      console.log(`🕒 Hourly limit reached. Sleeping ${(waitTime / 60000).toFixed(1)} min...`);
      await delay(waitTime);
      sentThisHour = 0;
      hourStart = Date.now();
    }

    console.log(`\n==============================\n📩 Sending DM to @${target}...`);
    let message = "";
    let imageSent = false;

    try {
      const userId = await ig.user.getIdByUsername(target);
      const thread = ig.entity.directThread([userId]);

      message = await generateDM(target);
      // message += [" 🌱", "✨", "🙂", "💬", ""].sort(() => 0.5 - Math.random())[0];
      console.log("🧠 Generated DM:", message);
      await thread.broadcastText(message);
      console.log("💬 Text message sent.");

      if (images && images.length > 0 && Math.random() < 0.2) {
        const img = images[Math.floor(Math.random() * images.length)];
        await thread.broadcastPhoto({
          file: fs.readFileSync(path.join(MEDIA_DIR, img)),
          caption: message,
        });
        console.log(`📸 Image sent with ${img}`);
        imageSent = true;
      }

      appendToCSV(target, "success", message, imageSent);
      sentToday++;
      sentThisHour++;
      dmCountSinceIdle++;

      // 👀 Random human action during normal flow
      if (Math.random() < 0.5) await randomHumanAction(ig);

      // 💤 Cooldown logic
      let cooldown = randomBetween(...COOLDOWN_RANGE);
      if (Math.random() < 0.4) cooldown = randomBetween(180_000, 300_000); // 3–5 min
      console.log(`⏳ Cooling for ${(cooldown / 1000).toFixed(1)}s...`);
      if (Math.random() < 0.5) await randomHumanAction(ig);
      await delay(cooldown);

      // 🧘 Idle break after 5–8 DMs
      if (dmCountSinceIdle >= randomBetween(5, 8)) {
        await idleBreak(ig, 600_000, 900_000); // 10–15 min with random actions
        dmCountSinceIdle = 0;
      }
    } catch (err: any) {
      console.error(`❌ Failed to send to @${target}:`, err.message);
      appendToCSV(target, "failed", message || "N/A", imageSent);
    }
  }

  console.log("\n🎉 All DMs processed! Log saved to dm_log.csv");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Unhandled Error:", err);
  process.exit(1);
});
