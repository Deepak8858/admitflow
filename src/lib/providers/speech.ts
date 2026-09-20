import type { Workspace } from "../domain";
import { credentials } from "../connections";
import { assert } from "../errors";
import { readLimitedBytes, readLimitedText } from "../http";
import { MAX_FILE_SIZE, validateFileBytes } from "../files";
import { requirePaidCapability } from "../subscription-access";

export async function transcribe(workspace: Workspace, audio: Uint8Array, mime = "audio/ogg") {
  assert(!workspace.demo, "Demo workspaces do not call speech providers.", 409);
  assert(mime.startsWith("audio/"), "A supported audio recording is required.");
  validateFileBytes(audio, mime, audio.length);
  const { apiKey } = await credentials(workspace, "elevenlabs");
  const extensions: Record<string, string> = { "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/webm": "webm", "audio/wav": "wav", "audio/aac": "aac", "audio/amr": "amr" };
  const extension = extensions[mime] || "audio";
  const form = new FormData(); form.set("model_id", "scribe_v1"); form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), `voice-note.${extension}`);
  await requirePaidCapability(workspace.id);
  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": apiKey }, body: form, signal: AbortSignal.timeout(45000) });
  assert(response.ok, "Voice-note transcription is unavailable. Review the message manually.", 502);
  const data = JSON.parse(await readLimitedText(response, 64_000)); assert(typeof data.text === "string" && data.text.trim(), "No transcript was returned.");
  return (data.text as string).slice(0, 8000);
}
export async function synthesize(workspace: Workspace, text: string) {
  assert(!workspace.demo, "Demo workspaces do not call speech providers.", 409);
  const { apiKey, voiceId: configuredVoice } = await credentials(workspace, "elevenlabs");
  const voiceId = workspace.ai?.voiceId || configuredVoice;
  assert(voiceId && /^[A-Za-z0-9_-]{8,100}$/.test(voiceId), "Choose a valid ElevenLabs voice in assistant settings.");
  await requirePaidCapability(workspace.id);
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 4000), model_id: "eleven_multilingual_v2" }), signal: AbortSignal.timeout(45000) });
  assert(response.ok, "Voice generation is unavailable.", 502);
  const bytes = await readLimitedBytes(response, MAX_FILE_SIZE);
  validateFileBytes(bytes, "audio/mpeg", bytes.length);
  return bytes;
}
