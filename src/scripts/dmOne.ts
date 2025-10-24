import { IgApiClient } from "instagram-private-api";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateDM } from "../agent/gptDM";

dotenv.config({ path: path.join(process.cwd(), ".env") });

// ---------- CONFIG ----------
const RECIPIENT = "smiii.jpg"; // 👤 change to target username
const MEDIA_DIR = path.join(process.cwd(), "media");

// ---------- MAIN FUNCTION ----------
async function main() {
  console.log("🚀 Starting Instagram DM workflow...");

  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;

  if (!username || !password) {
    throw new Error("❌ Missing IG_USERNAME or IG_PASSWORD in .env");
  }

  // Initialize IG client
  const ig = new IgApiClient();
  ig.state.generateDevice(username);

  // ---------- LOGIN ----------
  console.log("🔑 Logging into Instagram API...");
  try {
    await ig.account.login(username, password);
    console.log("✅ Login successful!");
  } catch (e: any) {
    console.error("❌ Login failed:", e.message);
    return;
  }

  // ---------- MESSAGE ----------
  const message = await generateDM(RECIPIENT);
  console.log("🧠 Generated personalized message:", message);

  // ---------- IMAGE SELECTION ----------
  let imagePath: string | null = null;
  if (fs.existsSync(MEDIA_DIR)) {
    const images = fs
      .readdirSync(MEDIA_DIR)
      .filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
    if (images.length > 0) {
      const randomImg = images[Math.floor(Math.random() * images.length)];
      imagePath = path.join(MEDIA_DIR, randomImg);
      console.log(`🖼 Selected image: ${randomImg}`);
    } else {
      console.warn("⚠️ No valid image files found in /media folder.");
    }
  } else {
    console.warn("⚠️ /media folder does not exist — continuing with text only.");
  }

  // ---------- GET USER ----------
  console.log(`🔍 Fetching user ID for @${RECIPIENT}...`);
  let userId: string;
  try {
    userId = await ig.user.getIdByUsername(RECIPIENT);
    console.log(`✅ Found user ID: ${userId}`);
  } catch (e: any) {
    console.error("❌ Failed to fetch user:", e.message);
    return;
  }

  // ---------- SEND DM ----------
  const thread = ig.entity.directThread([userId]);

  try {
    await thread.broadcastText(message);
    console.log(`💬 Text DM sent to @${RECIPIENT}`);
  } catch (e: any) {
    console.error("❌ Error sending text DM:", e.message);
    return;
  }

  if (imagePath) {
    try {
      await thread.broadcastPhoto({
        file: fs.readFileSync(imagePath),
        caption: message,
      });
      console.log(`📸 Image DM sent with ${path.basename(imagePath)}`);
    } catch (e: any) {
      console.error("❌ Error sending image DM:", e.message);
    }
  }

  console.log("✅ DM workflow completed successfully!");
  process.exit(0);
}

// ---------- EXECUTION ----------
main().catch((err) => {
  console.error("❌ Unhandled Error:", err);
  process.exit(1);
});
