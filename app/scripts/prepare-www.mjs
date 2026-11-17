// Kopjon faqen e Vianto-s (dosja udhetimi/) te www/, që Capacitor ta fusë në aplikacion.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
const SRC = process.env.WEB_SRC || "../udhetimi";
const files = ["index.html", "privacy.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "og.png"];
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const f of files) if (existsSync(`${SRC}/${f}`)) cpSync(`${SRC}/${f}`, `www/${f}`);
console.log("www gati nga", SRC);

// Burimet për ikonat dhe splash (krijohen këtu, nëse mungojnë, nga ikonat e faqes).
const sharp = (await import("sharp")).default;
mkdirSync("assets", { recursive: true });
const ICON = `${SRC}/icon-512.png`;
if (!existsSync("assets/icon-only.png"))
  await sharp(ICON).resize(1024, 1024).png().toFile("assets/icon-only.png");
if (!existsSync("assets/splash.png")) {
  const logo = await sharp(ICON).resize(560, 560).png().toBuffer();
  const mask = Buffer.from('<svg width="560" height="560"><rect width="560" height="560" rx="124" fill="#fff"/></svg>');
  const rounded = await sharp(logo).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const bg = { create: { width: 2732, height: 2732, channels: 4, background: "#EBDCC2" } };
  await sharp(bg).composite([{ input: rounded, gravity: "center" }]).png().toFile("assets/splash.png");
  cpSync("assets/splash.png", "assets/splash-dark.png");
}
console.log("assets gati");
