import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state_dir = path.join(os.homedir(), ".gemini", "antigravity");
const state_file = path.join(state_dir, "discord-rpc-model.json");

function read_payload() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(chunks.join("")));
      } catch {
        resolve({});
      }
    });
  });
}

const payload = await read_payload();
const model_name = typeof payload.modelName === "string" ? payload.modelName.trim() : "";

try {
  fs.mkdirSync(state_dir, { recursive: true });
} catch {
  process.stdout.write("{}");
  process.exit(0);
}

if (model_name) {
  const temp_file = `${state_file}.tmp`;
  try {
    fs.writeFileSync(
      temp_file,
      JSON.stringify({
        modelName: model_name,
        updatedAt: Date.now()
      }),
      "utf8"
    );
    fs.renameSync(temp_file, state_file);
  } catch {
    try {
      fs.unlinkSync(temp_file);
    } catch {}
  }
}

process.stdout.write("{}");
