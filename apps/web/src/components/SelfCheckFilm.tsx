import { useRef, useState } from "react";

export function SelfCheckFilm() {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [playError, setPlayError] = useState(false);

  async function play() {
    if (!video.current) return;
    setPlayError(false);
    try {
      await video.current.play();
      setStarted(true);
    } catch {
      setPlayError(true);
    }
  }

  return (
    <figure className="self-check-film" id="demo" aria-label="Self-Check in 36 seconds">
      <div className="film-topline"><span>RECORDED AI SHOPPING TEST</span><span>36 seconds</span></div>
      <div className="film-screen">
        <video
          ref={video}
          controls={started || playError}
          playsInline
          preload="none"
          poster="/assets/self-check-promo/poster-v2.jpg"
          aria-label="36-second Self-Check explainer. Original music with all information also shown as on-screen text."
          onPlay={() => setStarted(true)}
          onEnded={() => setStarted(false)}
        >
          <source src="/assets/self-check-promo/self-check-agents-36s.mp4" type="video/mp4" />
          <a href="/assets/self-check-promo/self-check-agents-36s.mp4">Watch the Self-Check film</a>
        </video>
        {!started ? (
          <button type="button" className="film-play" onClick={() => void play()} aria-label="Play the 36-second Self-Check film">
            <span className="film-play-label"><span aria-hidden="true">▶</span> Watch the walkthrough <small>0:36</small></span>
          </button>
        ) : null}
      </div>
      <figcaption>Illustrative demo. Your report contains your own recorded test.</figcaption>
      {playError ? <p className="film-fallback" role="status">Use the video controls or <a href="/assets/self-check-promo/self-check-agents-36s.mp4">open the film</a>.</p> : null}
      <details className="film-transcript"><summary>Read the 36-second walkthrough</summary><p>When AI makes a shopping shortlist, is your Shopify product in it? MC Lab Self-Check first understands your product and records a buyer brief. The buyer controller and shopping AI have a natural shopping conversation without private brand hints. Shopping AI searches and returns answers and sources. The controller chooses whether to explore, verify key unknowns, compare suitable options or stop based on the recorded evidence. Independent review checks for changed buyer needs or target identity leakage before a question reaches shopping AI. Product diagnosis separately records where your product first appeared, entered the shortlist or was recommended, with the questions, answers, sources and suggested next step. Start with a free product-data preview. After email verification, 1 complimentary Self-Check may be available; further recorded tests use paid credit packs. This film is illustrative, not a customer result. It represents a controlled API observation, with no guarantee of placement.</p></details>
    </figure>
  );
}
