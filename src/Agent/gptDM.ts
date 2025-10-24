import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.join(process.cwd(), ".env") });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateDM(
  toUser: string,
  competitor = "Dreamland Journals",
  interests?: string
): Promise<string> {
  const personalization = interests
    ? `They seem genuinely into ${interests}.`
    : `They follow ${competitor}, which shares reflective and mindful journaling content.`;

  const prompt = `
You are writing a short, natural Instagram DM (1–2 sentences) as a friendly journaling enthusiast reaching out to @${toUser}.
You’re introducing *Sentari AI*, a journaling companion that helps people reflect on moods and personal growth.

💬 Guidelines:
- Make it sound like a genuine person, not a brand.
- Mention “Sentari AI” exactly once, woven naturally into the sentence.
- Be warm, curious, and human — like someone who also loves journaling.
- ${personalization}
- Vary the message style each time: some reflective, some curious, some lightly funny.
- Use emojis *only when they truly fit* the vibe (e.g. ✨, 🌿, 💭, 📖).
- No copy-paste intros (“Hey, check this out!”), and avoid hashtags or promotional tone.
- The message should feel personal, spontaneous, and slightly unique each run.
`;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 1.15,  // slightly more variation
    messages: [{ role: "user", content: prompt }],
    max_tokens: 100,
  });

  return (
    res.choices[0].message?.content?.trim() ||
    "Hey! I’ve been journaling with Sentari AI lately—it’s been surprisingly grounding ✨"
  );
}
