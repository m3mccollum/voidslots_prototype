/* =========================================================================
   VOID SLOTS — sound
   -------------------------------------------------------------------------
   Thin wrapper around Howler.js. The rest of the game touches sound only
   through the four globals exposed at the bottom of this file:

       playSound(name)   — fire-and-forget short SFX
       setMusic(name)    — crossfade to a looping background track; pass
                           null or "" to fade out and stop the current track
       setMuted(muted)   — global mute toggle (silences SFX and music)
       setVolume(v)      — global volume, 0..1 (clamped)

   Adding a new SFX or BGM track only requires registering it in the
   relevant config object below — no other code needs to change.

   Howler details we lean on:
       - pool: lets one sound overlap with itself (we need this for
         reel_stop, which fires three times in 2s and would otherwise
         re-trigger and clip the previous instance).
       - fade(): smooth volume ramps for music in/out, no manual rAF.
       - Howler.mute / Howler.volume: global controls — affect every
         registered sound at once.
       - Autoplay unlock: handled internally on first user gesture.
   ========================================================================= */

(function () {
    "use strict";

    /* ---- SFX configuration ----------------------------------------------
       Each key is a logical name the rest of the game uses to refer to
       the sound. src is the file path, volume is per-sound (so we can
       balance levels here once instead of at every call site), and pool
       is the maximum number of concurrent instances of that sound.
       --------------------------------------------------------------------- */
    const SFX_CONFIG = {
        spin_click:       { src: "assets/spin_click.mp3",       volume: 0.7 },
        // reel_stop fires three times in quick succession (one per reel),
        // so we need at least 3 simultaneous instances to avoid retrigger clipping.
        reel_stop:        { src: "assets/reel_stop.mp3",        volume: 0.8, pool: 3 },
        miss_result:      { src: "assets/miss_result.mp3",      volume: 0.6 },
        win_2oak:         { src: "assets/2oak_win.mp3",         volume: 0.8 },
        win_3oak:         { src: "assets/3oak_win.mp3",         volume: 0.9 },
        win_wild:         { src: "assets/wild_win.mp3",         volume: 1.0 },
        invert_available: { src: "assets/Invert_available.mp3", volume: 0.7 },
        invert_click:     { src: "assets/Invert_click.mp3",     volume: 0.9 },
    };

    /* ---- BGM configuration ----------------------------------------------
       Reel timing in game.js is BPM-synced to this track (BPM = 152, from
       Radiohead's "Ful Stop"). Volume sits well below SFX so wins, reel
       stops, and clicks all stay legible over the music.
       --------------------------------------------------------------------- */
    const MUSIC_CONFIG = {
        bgm: { src: "assets/bgm.mp3", volume: 0.35 },
    };

    const MUSIC_FADE_MS = 600;     // crossfade duration for setMusic()

    /* ---- Internal state -------------------------------------------------- */

    const sfxInstances = {};        // name -> Howl
    const musicInstances = {};      // name -> Howl (constructed lazily on first play)
    let currentMusic = null;        // the Howl currently playing, or null
    let currentMusicName = null;    // its name, used to no-op repeated setMusic calls

    // Per-category mute state. Tracked so it applies to music tracks
    // constructed AFTER the player has toggled the mute (future BGM swaps).
    let sfxMuted = false;
    let musicMuted = false;

    /* ---- SFX -------------------------------------------------------------
       Preload every SFX at module init. This makes the first call to
       playSound() instant; otherwise Howler would have to fetch and decode
       the MP3 on first play (perceptible delay on the spin button).
       --------------------------------------------------------------------- */
    for (const name in SFX_CONFIG) {
        const cfg = SFX_CONFIG[name];
        sfxInstances[name] = new Howl({
            src: [cfg.src],
            volume: cfg.volume ?? 1.0,
            pool: cfg.pool ?? 1,
        });
    }

    function playSound(name) {
        const s = sfxInstances[name];
        if (!s) {
            console.warn("playSound: unknown sound", name);
            return;
        }
        s.play();
    }

    /* ---- Music -----------------------------------------------------------
       Crossfade pattern: fade the outgoing track to 0 over MUSIC_FADE_MS
       and stop it; start the new track at volume 0 and fade up to its
       target volume over the same window. This avoids the silent gap and
       hard volume cuts you'd get with stop()+play().

       setMusic(name) is a no-op if the requested track is already current
       (we don't want to restart on repeated calls).
       --------------------------------------------------------------------- */
    function setMusic(name) {
        if (currentMusicName === (name || null)) return;

        // Fade out whatever is currently playing.
        if (currentMusic) {
            const fading = currentMusic;
            fading.fade(fading.volume(), 0, MUSIC_FADE_MS);
            // Stop after the fade completes so we don't leak running audio.
            setTimeout(() => fading.stop(), MUSIC_FADE_MS);
            currentMusic = null;
        }

        currentMusicName = name || null;
        if (!name) return;                // explicit fade-out, no new track

        const cfg = MUSIC_CONFIG[name];
        if (!cfg) {
            console.warn("setMusic: unknown track", name);
            return;
        }

        // Construct the Howl on first use; reuse the same instance after.
        if (!musicInstances[name]) {
            musicInstances[name] = new Howl({
                src: [cfg.src],
                loop: true,
                volume: 0,                // we fade up from 0 below
            });
            // Honor the current music-mute toggle for newly-constructed tracks.
            if (musicMuted) musicInstances[name].mute(true);
        }
        const track = musicInstances[name];
        track.volume(0);
        track.play();
        track.fade(0, cfg.volume ?? 0.4, MUSIC_FADE_MS);
        currentMusic = track;
    }

    /* ---- Global controls ------------------------------------------------- */

    function setMuted(muted) {
        Howler.mute(!!muted);
    }

    /** Mute/unmute only the SFX. Music keeps playing if it's on. */
    function setSfxMuted(muted) {
        sfxMuted = !!muted;
        for (const name in sfxInstances) {
            sfxInstances[name].mute(sfxMuted);
        }
    }

    /** Mute/unmute only the music. SFX keep firing if they're on.
     *  A muted track keeps playing silently — when unmuted it resumes
     *  in place, preserving the BPM sync with gameplay. */
    function setMusicMuted(muted) {
        musicMuted = !!muted;
        for (const name in musicInstances) {
            musicInstances[name].mute(musicMuted);
        }
    }

    function setVolume(v) {
        // Clamp defensively; Howler accepts out-of-range values but we
        // want predictable behavior.
        Howler.volume(Math.max(0, Math.min(1, v)));
    }

    /* ---- Expose to the rest of the game --------------------------------- */
    window.playSound      = playSound;
    window.setMusic       = setMusic;
    window.setMuted       = setMuted;
    window.setSfxMuted    = setSfxMuted;
    window.setMusicMuted  = setMusicMuted;
    window.setVolume      = setVolume;
})();
