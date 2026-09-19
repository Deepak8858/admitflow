"use client";
import { useId, useState } from "react";
import { AudioLines } from "lucide-react";
import audio from "@/data/sample-audio.json";

export function SampleAudio({ slug }: { slug: string }) {
  const id = useId();
  const [failed, setFailed] = useState(false);
  const sample = audio.samples.find(item => item.slug === slug);
  if (!sample) return null;
  return <section className="sample-audio" aria-labelledby={id}>
    <div className="audio-heading"><AudioLines size={19} /><div><h3 id={id}>{sample.title}</h3><span>AI-generated voice · fictional example</span></div></div>
    <audio controls preload="none" aria-label={`Play ${sample.title}`} onError={() => setFailed(true)} onPlay={event => { const active = event.currentTarget; document.querySelectorAll("audio").forEach(player => { if (player !== active) player.pause(); }); }} src={`/media/${sample.slug}.mp3`} />
    {failed && <p role="status">Audio is unavailable. The full transcript is below.</p>}
    <details><summary>Read transcript</summary><p>{sample.transcript}</p></details>
  </section>;
}
