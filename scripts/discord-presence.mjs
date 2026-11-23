import net from "node:net";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.stdout.on("error", (e) => { if (e.code !== "EPIPE") log(`stdout error: ${e.message}`); });

const CONFIG = {
  application_id: process.env.DISCORD_APPLICATION_ID || "",
  application_name: process.env.APPLICATION_NAME || "Antigravity",
  details: process.env.DETAILS ?? "",
  state: process.env.STATE || "AI-assisted development",
  large_image: process.env.LARGE_IMAGE || "antigravity",
  small_image: process.env.SMALL_IMAGE || "",
  elapsed_time: (process.env.ELAPSED_TIME || "true").toLowerCase() !== "false"
};

let socket = null;
let connected = false;
let receive_buffer = Buffer.alloc(0);
let reconnect_timer = null;
let presence_sent = false;
let closing = false;
let ready_received = false;
const start_time = Math.floor(Date.now() / 1000);
const model_state_file = path.join(
  os.homedir(),
  ".gemini",
  "antigravity",
  "discord-rpc-model.json"
);
let model_state_signature = "";
let state_poll_timer = null;

function log(message) {
  process.stderr.write(`[discord-rpc] ${message}\n`);
}

function write_frame(opcode, payload) {
  if (!socket || socket.destroyed) {
    throw new Error("Discord IPC is disconnected");
  }
  const payload_buffer = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(payload_buffer.length, 4);
  socket.write(Buffer.concat([header, payload_buffer]));
}

function clear_presence() {
  if (!connected || !presence_sent) {
    return;
  }
  try {
    write_frame(1, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: null },
      nonce: randomUUID()
    });
    log("Rich Presence cleared");
  } catch (error) {
    log(`Failed to clear Rich Presence: ${error.message}`);
  }
}

function set_activity() {
  const model_state = read_model_state();
  const state_text = model_state || CONFIG.state;
  const activity = {
    type: 0,
    state: state_text
  };
  if (CONFIG.details) {
    activity.details = CONFIG.details;
  }
  const assets = {};
  if (CONFIG.large_image) {
    assets.large_image = CONFIG.large_image;
  }
  if (CONFIG.small_image) {
    assets.small_image = CONFIG.small_image;
  }
  if (Object.keys(assets).length > 0) {
    activity.assets = assets;
  }
  if (CONFIG.elapsed_time) {
    activity.timestamps = { start: start_time };
  }

  write_frame(1, {
    cmd: "SET_ACTIVITY",
    args: { pid: process.pid, activity },
    nonce: randomUUID()
  });
  presence_sent = true;
  log("Rich Presence published");
}

function read_model_state() {
  try {
    if (!fs.existsSync(model_state_file)) {
      return "";
    }
    const state = JSON.parse(fs.readFileSync(model_state_file, "utf8"));
    if (typeof state.modelName !== "string" || !state.modelName.trim()) {
      return "";
    }
    return format_model_name(state.modelName);
  } catch {
    return "";
  }
}

function format_model_name(model_name) {
  const name = model_name.trim();
  const claude_match = name.match(/^(claude)-(sonnet|opus)-(\d+(?:[.-]\d+)?)(?:-(?:thinking-)?(low|medium|high|xhigh|extra))?(?:-thinking)?$/i);
  if (claude_match) {
    const family = claude_match[2][0].toUpperCase() + claude_match[2].slice(1).toLowerCase();
    const tier = claude_match[4];
    const version = claude_match[3].replace(/-/g, ".");
    if (!tier) {
      return `Claude ${family} ${version}`;
    }
    const tier_label = tier.toLowerCase() === "xhigh" || tier.toLowerCase() === "extra"
      ? "Extra"
      : tier[0].toUpperCase() + tier.slice(1).toLowerCase();
    return `Claude ${family} ${version} (${tier_label})`;
  }

  const slug_match = name.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro|neon|carbon|argon|hydrogen|helix)(?:-(low|medium|high|xhigh|extra|thinking))?$/i);
  if (slug_match) {
    const version = slug_match[1];
    const family = slug_match[2][0].toUpperCase() + slug_match[2].slice(1).toLowerCase();
    const tier = slug_match[3];
    if (!tier) {
      return `Gemini ${version} ${family}`;
    }
    const tier_label = tier.toLowerCase() === "xhigh" || tier.toLowerCase() === "extra"
      ? "Extra"
      : tier[0].toUpperCase() + tier.slice(1).toLowerCase();
    return `Gemini ${version} ${family} (${tier_label})`;
  }

  const tier_match = name.match(/^(.*)-(low|medium|high|xhigh|extra)(?:-thinking)?$/i);
  if (tier_match) {
    const base_name = format_model_words(tier_match[1]);
    if (base_name) {
      const tier = tier_match[2].toLowerCase();
      const tier_label = tier === "xhigh" || tier === "extra"
        ? "Extra"
        : tier[0].toUpperCase() + tier.slice(1);
      return `${base_name} (${tier_label})`;
    }
  }

  const generic_name = format_model_words(name);
  if (generic_name) {
    return generic_name;
  }

  if (/^[a-z0-9][a-z0-9._/-]*$/i.test(name)) {
    return name;
  }
  return "AI-assisted development";
}

function format_model_words(model_name) {
  const words = model_name.trim().split(/[-_]+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  const acronyms = new Set(["ai", "gpt", "oss", "lm", "llm", "vlm"]);
  const formatted_words = words.map((word) => {
    const lower_word = word.toLowerCase();
    if (acronyms.has(lower_word)) {
      return lower_word.toUpperCase();
    }
    if (/^\d+(?:\.\d+)?[bt]$/i.test(word)) {
      return word.toUpperCase();
    }
    if (/^\d+$/.test(word)) {
      return word;
    }
    return lower_word[0].toUpperCase() + lower_word.slice(1);
  });

  return formatted_words.reduce((parts, word, index) => {
    const previous_word = formatted_words[index - 1];
    if (
      previous_word &&
      /^[A-Z]+$/.test(previous_word) &&
      /^[A-Z]+$/.test(word)
    ) {
      parts[parts.length - 1] += `-${word}`;
    } else {
      parts.push(word);
    }
    return parts;
  }, []).join(" ");
}

function poll_model_state() {
  if (closing) {
    return;
  }
  let signature = "";
  try {
    const state = fs.existsSync(model_state_file)
      ? JSON.parse(fs.readFileSync(model_state_file, "utf8"))
      : null;
    if (
      typeof state?.modelName === "string" &&
      state.modelName.trim()
    ) {
      signature = state.modelName.trim();
    }
  } catch {}

  if (signature !== model_state_signature && connected) {
    model_state_signature = signature;
    try {
      set_activity();
    } catch (error) {
      log(`Failed to update model in Rich Presence: ${error.message}`);
    }
  }

  state_poll_timer = setTimeout(poll_model_state, 5000);
}

function handle_frame_data(data) {
  receive_buffer = Buffer.concat([receive_buffer, data]);
  while (receive_buffer.length >= 8) {
    const opcode = receive_buffer.readInt32LE(0);
    const length = receive_buffer.readInt32LE(4);
    if (length < 0 || length > 1024 * 1024) {
      receive_buffer = Buffer.alloc(0);
      if (socket) {
        socket.destroy();
      }
      return;
    }
    if (receive_buffer.length < 8 + length) {
      return;
    }
    const frame = receive_buffer.subarray(8, 8 + length);
    if (opcode === 1) {
      try {
        const payload = JSON.parse(frame.toString("utf8"));
        if (payload.evt === "ERROR") {
          log(`Discord RPC error: ${payload.data?.message || "unknown error"}`);
        }
        if (payload.evt === "READY" && !ready_received) {
          ready_received = true;
          try {
            set_activity();
          } catch (error) {
            log(`Failed to publish Rich Presence: ${error.message}`);
          }
        }
      } catch {}
    }
    receive_buffer = receive_buffer.subarray(8 + length);
  }
}

function connect_discord() {
  if (connected || closing) {
    return;
  }
  if (!/^\d+$/.test(CONFIG.application_id)) {
    log("Configuration error: DISCORD_APPLICATION_ID must be numeric");
    return;
  }
  log("Reconnection attempted");

  let failure_count = 0;
  let connection_established = false;

  function discord_pipes(index) {
    if (process.platform === "win32") {
      return [`\\\\?\\pipe\\discord-ipc-${index}`];
    }
    const runtime_dir =
      process.env.XDG_RUNTIME_DIR ||
      process.env.TMPDIR ||
      process.env.TMP ||
      process.env.TEMP ||
      "/tmp";
    return [
      path.join(runtime_dir, `discord-ipc-${index}`),
      path.join(runtime_dir, "app", "com.discordapp.Discord", `discord-ipc-${index}`),
      path.join(runtime_dir, "snap.discord", `discord-ipc-${index}`)
    ];
  }

  let total_candidates = 0;
  for (let index = 0; index < 10; index++) {
    for (const pipe of discord_pipes(index)) {
      total_candidates++;
      const candidate = net.createConnection(pipe);
      candidate.once("connect", () => {
        if (connected || connection_established) {
          candidate.destroy();
          return;
        }
        connection_established = true;
        socket = candidate;
        connected = true;
        receive_buffer = Buffer.alloc(0);
        log(`Discord IPC connection established on discord-ipc-${index}`);
        candidate.on("data", handle_frame_data);
        candidate.once("close", () => {
          if (socket !== candidate) {
            return;
          }
          connected = false;
          presence_sent = false;
          ready_received = false;
          socket = null;
          receive_buffer = Buffer.alloc(0);
          log("Discord disconnected");
          schedule_reconnect();
        });
        candidate.once("error", () => {
          candidate.destroy();
        });

        try {
          write_frame(0, {
            v: 1,
            client_id: CONFIG.application_id
          });
        } catch {
          candidate.destroy();
        }
      });
      candidate.once("error", () => {
        candidate.destroy();
        failure_count++;
        if (
          failure_count >= total_candidates &&
          !connection_established &&
          !connected
        ) {
          schedule_reconnect();
        }
      });
    }
  }
}

function schedule_reconnect() {
  if (closing || reconnect_timer) {
    return;
  }
  reconnect_timer = setTimeout(() => {
    reconnect_timer = null;
    connect_discord();
  }, 5000);
}

function send_json(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle_message(message) {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return;
  }

  if (message.method === "initialize") {
    send_json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "discord-rpc", version: "2.0.0" }
      }
    });
    return;
  }

  if (message.method === "ping") {
    send_json({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "tools/list") {
    send_json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "status",
            description: "Report Discord Rich Presence connection status.",
            inputSchema: {
              type: "object",
              properties: {}
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name !== "status") {
      send_json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "Invalid tool name" }
      });
      return;
    }
    send_json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: connected ? "Discord Rich Presence connected" : "Discord Rich Presence reconnecting"
          }
        ]
      }
    });
    return;
  }

  send_json({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" }
  });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  try {
    handle_message(JSON.parse(line));
  } catch (error) {
    send_json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    });
  }
});

function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  log("MCP server shutting down");
  clear_presence();
  if (state_poll_timer) {
    clearTimeout(state_poll_timer);
  }
  if (reconnect_timer) {
    clearTimeout(reconnect_timer);
  }
  if (socket) {
    socket.end();
  }
  setTimeout(() => process.exit(0), 100);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
process.on("exit", () => {
  if (!closing) {
    clear_presence();
  }
});

log("MCP server started");
log(`Application: ${CONFIG.application_name}`);
connect_discord();
poll_model_state();
