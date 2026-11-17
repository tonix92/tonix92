// Kopjon faqen e Vianto-s (dosja udhetimi/) te www/, që Capacitor ta fusë në aplikacion.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
const SRC = process.env.WEB_SRC || "../udhetimi";
const files = ["index.html", "privacy.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "og.png"];
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const f of files) if (existsSync(`${SRC}/${f}`)) cpSync(`${SRC}/${f}`, `www/${f}`);
console.log("www gati nga", SRC);
